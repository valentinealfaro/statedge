import pg from 'pg';
import type { NbaPlayer, PlayerGame, TeamGame } from './nba/client.js';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Add it to backend/.env (Neon connection string recommended).');
  }
  pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  return pool;
}

export function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export async function searchPlayersFromDb(query: string, limit = 20): Promise<NbaPlayer[]> {
  const q = fold(query.trim());
  if (!q) return [];
  const { rows } = await getPool().query<{
    id: number;
    full_name: string;
    first_name: string | null;
    last_name: string | null;
    team_id: number | null;
    is_active: boolean;
  }>(
    // unaccent strips diacritics so "jokic" matches "Jokić".
    `SELECT id, full_name, first_name, last_name, team_id, is_active
       FROM players
      WHERE lower(unaccent(full_name)) LIKE '%' || $1 || '%'
   ORDER BY is_active DESC, full_name
      LIMIT $2`,
    [q, limit],
  );

  const filtered = rows;

  // We loaded teams from NBA_TEAMS list with the same IDs, so cross-ref abbr.
  const { NBA_TEAMS } = await import('./nba/teams.js');
  const teamAbbr = (id: number | null): string | null => {
    if (!id) return null;
    return NBA_TEAMS.find((t) => t.id === id)?.abbreviation ?? null;
  };

  return filtered.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    firstName: r.first_name ?? '',
    lastName: r.last_name ?? '',
    teamId: r.team_id,
    teamAbbreviation: teamAbbr(r.team_id),
    isActive: r.is_active,
  }));
}

export type TrendingPlayer = NbaPlayer & {
  ppg: number;
  rpg: number;
  apg: number;
  gamesPlayed: number;
};

// Computes season averages per active player from the cached JSONB game logs
// and returns the top N by points-per-game. We unnest the JSONB into rows in
// SQL so the average math runs in Postgres rather than shipping every game
// to Node — much cheaper on large player tables. Minimum-games filter avoids
// giving a one-game cup-of-coffee a #1 leaderboard slot.
export async function getTrendingPlayersFromDb(
  season: string,
  limit = 8,
  minGames = 10,
): Promise<TrendingPlayer[]> {
  const { rows } = await getPool().query<{
    id: number;
    full_name: string;
    first_name: string | null;
    last_name: string | null;
    team_id: number | null;
    is_active: boolean;
    ppg: number;
    rpg: number;
    apg: number;
    games: number;
  }>(
    `SELECT
        p.id,
        p.full_name,
        p.first_name,
        p.last_name,
        p.team_id,
        p.is_active,
        AVG((g->>'points')::numeric)   AS ppg,
        AVG((g->>'rebounds')::numeric) AS rpg,
        AVG((g->>'assists')::numeric)  AS apg,
        COUNT(*)::int                  AS games
       FROM player_game_logs pgl
       JOIN players p ON p.id = pgl.player_id
       , jsonb_array_elements(pgl.games) g
      WHERE pgl.season = $1
        AND p.is_active = TRUE
      GROUP BY p.id, p.full_name, p.first_name, p.last_name, p.team_id, p.is_active
     HAVING COUNT(*) >= $2
   ORDER BY AVG((g->>'points')::numeric) DESC
      LIMIT $3`,
    [season, minGames, limit],
  );

  const { NBA_TEAMS } = await import('./nba/teams.js');
  const abbrFor = (id: number | null): string | null =>
    id ? NBA_TEAMS.find((t) => t.id === id)?.abbreviation ?? null : null;

  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    firstName: r.first_name ?? '',
    lastName: r.last_name ?? '',
    teamId: r.team_id,
    teamAbbreviation: abbrFor(r.team_id),
    isActive: r.is_active,
    ppg: round1(Number(r.ppg)),
    rpg: round1(Number(r.rpg)),
    apg: round1(Number(r.apg)),
    gamesPlayed: r.games,
  }));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export type RecentGameSide = {
  teamId: number;
  abbreviation: string;
  fullName: string;
  points: number;
  isHome: boolean;
  result: 'W' | 'L' | null;
};

export type RecentGame = {
  gameId: string;
  date: string;       // YYYY-MM-DD
  away: RecentGameSide;
  home: RecentGameSide;
};

export type BoxscorePlayer = {
  playerId: number;
  fullName: string;
  minutes: number;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  fgm: number;
  fga: number;
  fg3m: number;
  fg3a: number;
  ftm: number;
  fta: number;
  pf: number;
};

export type BoxscoreSide = {
  teamId: number;
  abbreviation: string;
  fullName: string;
  isHome: boolean;
  result: 'W' | 'L' | null;
  points: number;
  players: BoxscorePlayer[];
};

export type Boxscore = {
  gameId: string;
  date: string;
  away: BoxscoreSide;
  home: BoxscoreSide;
};

// Build a full boxscore for a single game out of the JSONB caches.
// Strategy: first pull the two team_game_logs rows (for the matchup
// header / final score / W-L / home-away), then pull every player whose
// player_game_logs has a row with matching gameId. The player's matchup
// string ("LAL vs. DEN" or "LAL @ DEN") tells us which team they were
// playing FOR in this specific game — important because the players
// table only knows their CURRENT team, not their team at the time.
export async function getBoxscoreFromDb(
  season: string,
  gameId: string,
): Promise<Boxscore | null> {
  const pool = getPool();

  // Step 1: paired team rows for this gameId.
  const teamRes = await pool.query<{
    team_id: number;
    points: number;
    is_home: boolean;
    result: 'W' | 'L' | null;
    matchup: string;
    date: string;
  }>(
    `SELECT
       tgl.team_id,
       (g->>'points')::int                     AS points,
       (g->>'isHome')::boolean                 AS is_home,
       NULLIF(g->>'result','')                 AS result,
       g->>'matchup'                           AS matchup,
       (g->>'date')::date::text                AS date
       FROM team_game_logs tgl
       , jsonb_array_elements(tgl.games) g
      WHERE tgl.season = $1 AND g->>'gameId' = $2`,
    [season, gameId],
  );
  if (teamRes.rows.length !== 2) return null;

  // Step 2: every player with a stat line for this gameId.
  const playerRes = await pool.query<{
    player_id: number;
    full_name: string;
    games: { gameId: string; matchup: string; minutes: number; points: number;
             rebounds: number; assists: number; steals: number; blocks: number;
             turnovers: number; fgm?: number; fga?: number; fg3m?: number;
             fg3a?: number; ftm?: number; fta?: number; pf?: number }[];
  }>(
    `SELECT pgl.player_id, p.full_name, pgl.games
       FROM player_game_logs pgl
       JOIN players p ON p.id = pgl.player_id
      WHERE pgl.season = $1
        AND pgl.games @> jsonb_build_array(jsonb_build_object('gameId', $2::text))`,
    [season, gameId],
  );

  const { NBA_TEAMS } = await import('./nba/teams.js');
  const meta = (id: number) => NBA_TEAMS.find((t) => t.id === id);

  // Build a side keyed by the team_abbreviation so we can sort each
  // player's row into the right side using their matchup string.
  const sides = new Map<string, BoxscoreSide>();
  for (const t of teamRes.rows) {
    const team = meta(t.team_id);
    if (!team) return null;
    sides.set(team.abbreviation, {
      teamId: team.id,
      abbreviation: team.abbreviation,
      fullName: team.fullName,
      isHome: t.is_home,
      result: t.result,
      points: t.points,
      players: [],
    });
  }

  // Drop each player's stat row into the appropriate side based on the
  // matchup string for the matching game.
  for (const r of playerRes.rows) {
    const game = r.games.find((g) => g.gameId === gameId);
    if (!game) continue;
    // matchup is "TEAM vs. OPP" or "TEAM @ OPP" — first 3 chars are the
    // player's team for this game.
    const playerTeam = game.matchup.slice(0, 3).toUpperCase();
    const side = sides.get(playerTeam);
    if (!side) continue;
    side.players.push({
      playerId: r.player_id,
      fullName: r.full_name,
      minutes:  Number(game.minutes  ?? 0),
      points:   Number(game.points   ?? 0),
      rebounds: Number(game.rebounds ?? 0),
      assists:  Number(game.assists  ?? 0),
      steals:   Number(game.steals   ?? 0),
      blocks:   Number(game.blocks   ?? 0),
      turnovers:Number(game.turnovers?? 0),
      fgm:      Number(game.fgm      ?? 0),
      fga:      Number(game.fga      ?? 0),
      fg3m:     Number(game.fg3m     ?? 0),
      fg3a:     Number(game.fg3a     ?? 0),
      ftm:      Number(game.ftm      ?? 0),
      fta:      Number(game.fta      ?? 0),
      pf:       Number(game.pf       ?? 0),
    });
  }
  // Most-minutes-first feels like the natural starting-five-then-bench order.
  for (const side of sides.values()) {
    side.players.sort((a, b) => b.minutes - a.minutes);
  }

  const sideArr = [...sides.values()];
  const home = sideArr.find((s) => s.isHome);
  const away = sideArr.find((s) => !s.isHome);
  if (!home || !away) return null;

  return { gameId, date: teamRes.rows[0]!.date, home, away };
}

// Most recent N completed games. Each game appears in two team_game_logs
// rows (one per team's POV); we group by gameId to pair them and emit a
// home-vs-away record.
export async function getRecentGamesFromDb(
  season: string,
  limit = 6,
): Promise<RecentGame[]> {
  const { rows } = await getPool().query<{
    game_id: string;
    date: string;
    teams: Array<{ teamId: number; points: number; isHome: boolean; result: 'W' | 'L' | null }>;
  }>(
    `WITH unnested AS (
       SELECT
         tgl.team_id                                               AS team_id,
         g->>'gameId'                                              AS game_id,
         (g->>'date')::date                                        AS date,
         (g->>'points')::int                                       AS points,
         (g->>'isHome')::boolean                                   AS is_home,
         NULLIF(g->>'result', '')                                  AS result
       FROM team_game_logs tgl
       , jsonb_array_elements(tgl.games) g
       WHERE tgl.season = $1
     )
     SELECT
       game_id,
       MIN(date)::text                                             AS date,
       JSON_AGG(
         JSON_BUILD_OBJECT(
           'teamId', team_id,
           'points', points,
           'isHome', is_home,
           'result', result
         )
       )                                                           AS teams
     FROM unnested
     GROUP BY game_id
     -- Only include games where both teams' perspectives are cached.
     -- During the day-of-sync window stats.nba.com sometimes has one
     -- side updated before the other, so half-cached games are real.
   HAVING COUNT(*) = 2
   ORDER BY MIN(date) DESC, game_id DESC
     LIMIT $2`,
    [season, limit],
  );

  const { NBA_TEAMS } = await import('./nba/teams.js');
  const meta = (id: number) => NBA_TEAMS.find((t) => t.id === id);

  return rows.flatMap((r) => {
    if (r.teams.length !== 2) return [];          // half-cached game; skip
    const homeRow = r.teams.find((t) => t.isHome);
    const awayRow = r.teams.find((t) => !t.isHome);
    if (!homeRow || !awayRow) return [];
    const homeTeam = meta(homeRow.teamId);
    const awayTeam = meta(awayRow.teamId);
    if (!homeTeam || !awayTeam) return [];
    return [{
      gameId: r.game_id,
      date: r.date,
      home: {
        teamId: homeTeam.id,
        abbreviation: homeTeam.abbreviation,
        fullName: homeTeam.fullName,
        points: homeRow.points,
        isHome: true,
        result: homeRow.result,
      },
      away: {
        teamId: awayTeam.id,
        abbreviation: awayTeam.abbreviation,
        fullName: awayTeam.fullName,
        points: awayRow.points,
        isHome: false,
        result: awayRow.result,
      },
    }];
  });
}

export type TopPerformer = {
  playerId: number;
  fullName: string;
  teamAbbreviation: string | null;
  date: string;
  matchup: string;
  opponentAbbr: string;
  isHome: boolean;
  result: 'W' | 'L' | null;
  minutes: number;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
};

// Best scorers from the most recent game day in cache. We don't trust
// 'today' literally — the sync runs once a day, so 'most recent date
// in cache' is the right anchor. Dynamic min-points filter prevents
// short-roster mop-up minutes from cluttering the leaderboard.
export async function getTopPerformersFromDb(
  season: string,
  limit = 6,
): Promise<TopPerformer[]> {
  const dateRes = await getPool().query<{ d: string | null }>(
    `SELECT MAX((g->>'date')::date)::text AS d
       FROM player_game_logs, jsonb_array_elements(games) g
      WHERE season = $1`,
    [season],
  );
  const date = dateRes.rows[0]?.d;
  if (!date) return [];

  const { rows } = await getPool().query<{
    player_id: number;
    full_name: string;
    g: {
      gameId: string; matchup: string; opponentAbbr: string; isHome: boolean;
      result: 'W' | 'L' | null; minutes: number; points: number; rebounds: number;
      assists: number; steals: number; blocks: number;
    };
  }>(
    `SELECT pgl.player_id, p.full_name, g
       FROM player_game_logs pgl
       JOIN players p ON p.id = pgl.player_id
       , jsonb_array_elements(pgl.games) g
      WHERE pgl.season = $1
        AND (g->>'date')::date = $2::date
   ORDER BY (g->>'points')::int DESC
      LIMIT $3`,
    [season, date, limit],
  );

  const { NBA_TEAMS } = await import('./nba/teams.js');
  return rows.map((r) => {
    // First 3 chars of matchup are this player's team for the game.
    const playerTeamAbbr = (r.g.matchup ?? '').slice(0, 3).toUpperCase() || null;
    return {
      playerId: r.player_id,
      fullName: r.full_name,
      teamAbbreviation: playerTeamAbbr,
      date,
      matchup: r.g.matchup,
      opponentAbbr: r.g.opponentAbbr,
      isHome: !!r.g.isHome,
      result: r.g.result,
      minutes:  Number(r.g.minutes  ?? 0),
      points:   Number(r.g.points   ?? 0),
      rebounds: Number(r.g.rebounds ?? 0),
      assists:  Number(r.g.assists  ?? 0),
      steals:   Number(r.g.steals   ?? 0),
      blocks:   Number(r.g.blocks   ?? 0),
    };
  }).filter((p) => {
    // Sanity-check: NBA_TEAMS has the abbreviation as a known key.
    return !p.teamAbbreviation || NBA_TEAMS.some((t) => t.abbreviation === p.teamAbbreviation);
  });
}

export type StandingRow = {
  teamId: number;
  abbreviation: string;
  fullName: string;
  conference: 'East' | 'West';
  wins: number;
  losses: number;
  winPct: number;
  ppg: number;
  oppPpg: number;
  pointDiff: number;
};

// Computes regular-season-style W-L records and PPG per team from the
// JSONB team_game_logs cache, then attaches conference metadata from
// the static teams list. Sorted by win-pct desc inside each conference.
export async function getStandingsFromDb(season: string): Promise<{
  east: StandingRow[];
  west: StandingRow[];
}> {
  const { rows } = await getPool().query<{
    team_id: number;
    wins: number;
    losses: number;
    games: number;
    ppg: number;
    pts_for_total: number;
  }>(
    `SELECT
        tgl.team_id,
        COUNT(*) FILTER (WHERE g->>'result' = 'W')::int            AS wins,
        COUNT(*) FILTER (WHERE g->>'result' = 'L')::int            AS losses,
        COUNT(*)::int                                              AS games,
        AVG((g->>'points')::numeric)                               AS ppg,
        SUM((g->>'points')::numeric)                               AS pts_for_total
       FROM team_game_logs tgl
       , jsonb_array_elements(tgl.games) g
      WHERE tgl.season = $1
      GROUP BY tgl.team_id`,
    [season],
  );

  // To compute opp PPG we'd need to look at the opposing team's row for
  // each gameId, which is a separate query — for now skip and just emit
  // PPG. Pts diff returns 0 placeholder; the standings UI can hide these.

  const { NBA_TEAMS } = await import('./nba/teams.js');
  const standings: StandingRow[] = rows.flatMap((r) => {
    const team = NBA_TEAMS.find((t) => t.id === r.team_id);
    if (!team) return [];
    const wins = Number(r.wins);
    const losses = Number(r.losses);
    const total = wins + losses;
    return [{
      teamId: team.id,
      abbreviation: team.abbreviation,
      fullName: team.fullName,
      conference: team.conference,
      wins,
      losses,
      winPct: total === 0 ? 0 : Math.round((wins / total) * 1000) / 1000,
      ppg: round1(Number(r.ppg)),
      oppPpg: 0,
      pointDiff: 0,
    }];
  });

  const cmp = (a: StandingRow, b: StandingRow) =>
    b.winPct - a.winPct || b.wins - a.wins || a.fullName.localeCompare(b.fullName);

  return {
    east: standings.filter((s) => s.conference === 'East').sort(cmp),
    west: standings.filter((s) => s.conference === 'West').sort(cmp),
  };
}

export type TrendingTeam = {
  id: number;
  abbreviation: string;
  city: string;
  name: string;
  fullName: string;
  ppg: number;
  oppPpg: number;     // not stored; we approximate via win-margin if needed
  wins: number;
  losses: number;
  gamesPlayed: number;
};

// Top teams by PPG for the season. Mirrors getTrendingPlayersFromDb but for
// the team_game_logs cache. Returns the top N — the small minGames gate
// avoids early-season anomalies.
export async function getTrendingTeamsFromDb(
  season: string,
  limit = 8,
  minGames = 10,
): Promise<TrendingTeam[]> {
  const { rows } = await getPool().query<{
    team_id: number;
    ppg: number;
    wins: number;
    losses: number;
    games: number;
  }>(
    `SELECT
        tgl.team_id,
        AVG((g->>'points')::numeric)                                    AS ppg,
        COUNT(*) FILTER (WHERE g->>'result' = 'W')::int                 AS wins,
        COUNT(*) FILTER (WHERE g->>'result' = 'L')::int                 AS losses,
        COUNT(*)::int                                                   AS games
       FROM team_game_logs tgl
       , jsonb_array_elements(tgl.games) g
      WHERE tgl.season = $1
      GROUP BY tgl.team_id
     HAVING COUNT(*) >= $2
   ORDER BY AVG((g->>'points')::numeric) DESC
      LIMIT $3`,
    [season, minGames, limit],
  );

  const { NBA_TEAMS } = await import('./nba/teams.js');
  return rows.flatMap((r) => {
    const team = NBA_TEAMS.find((t) => t.id === r.team_id);
    if (!team) return [];
    return [{
      id: team.id,
      abbreviation: team.abbreviation,
      city: team.city,
      name: team.name,
      fullName: team.fullName,
      ppg: round1(Number(r.ppg)),
      oppPpg: 0,
      wins: r.wins,
      losses: r.losses,
      gamesPlayed: r.games,
    }];
  });
}

// Bulk version of getPlayerGameLogFromDb — used by /api/slate/auto so a
// 16-line slate doesn't fan out to 16 separate round-trips.
export async function getPlayerGameLogsBulkFromDb(
  playerIds: number[],
  season: string,
): Promise<Map<number, PlayerGame[]>> {
  const out = new Map<number, PlayerGame[]>();
  if (playerIds.length === 0) return out;
  const { rows } = await getPool().query<{ player_id: number; games: PlayerGame[] }>(
    `SELECT player_id, games FROM player_game_logs
      WHERE season = $1 AND player_id = ANY($2::int[])`,
    [season, playerIds],
  );
  for (const r of rows) out.set(r.player_id, r.games);
  return out;
}

// Lightweight player metadata for the slate resolver. We pull every row
// once per request, since slate parsing fan-outs to ~20 players.
export async function listAllPlayerCandidatesFromDb(): Promise<{
  id: number;
  fullName: string;
  isActive: boolean;
  teamId: number | null;
}[]> {
  const { rows } = await getPool().query<{
    id: number;
    full_name: string;
    is_active: boolean;
    team_id: number | null;
  }>(
    `SELECT id, full_name, is_active, team_id FROM players`,
  );
  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    isActive: r.is_active,
    teamId: r.team_id,
  }));
}

export async function getPlayerByIdFromDb(playerId: number): Promise<NbaPlayer | null> {
  const { rows } = await getPool().query<{
    id: number;
    full_name: string;
    first_name: string | null;
    last_name: string | null;
    team_id: number | null;
    is_active: boolean;
  }>(
    `SELECT id, full_name, first_name, last_name, team_id, is_active
       FROM players
      WHERE id = $1`,
    [playerId],
  );
  const r = rows[0];
  if (!r) return null;
  const { NBA_TEAMS } = await import('./nba/teams.js');
  const teamAbbr = r.team_id
    ? NBA_TEAMS.find((t) => t.id === r.team_id)?.abbreviation ?? null
    : null;
  return {
    id: r.id,
    fullName: r.full_name,
    firstName: r.first_name ?? '',
    lastName: r.last_name ?? '',
    teamId: r.team_id,
    teamAbbreviation: teamAbbr,
    isActive: r.is_active,
  };
}

export async function getPlayerGameLogFromDb(
  playerId: number,
  season: string,
): Promise<PlayerGame[] | null> {
  const { rows } = await getPool().query<{ games: PlayerGame[] }>(
    'SELECT games FROM player_game_logs WHERE player_id = $1 AND season = $2',
    [playerId, season],
  );
  return rows[0]?.games ?? null;
}

// Returns all cached games for a player across the given seasons, newest first.
// Returns null if NO seasons are cached. Returns merged games if at least one is cached.
export async function getPlayerGameLogsMultiFromDb(
  playerId: number,
  seasons: string[],
): Promise<PlayerGame[] | null> {
  const { rows } = await getPool().query<{ games: PlayerGame[]; season: string }>(
    `SELECT games, season FROM player_game_logs
      WHERE player_id = $1 AND season = ANY($2::text[])`,
    [playerId, seasons],
  );
  if (rows.length === 0) return null;
  const merged = rows.flatMap((r) => r.games);
  // playergamelog rows are already newest-first per season; merging across
  // seasons can interleave. Re-sort by date desc so "last N" is meaningful.
  merged.sort((a, b) => b.date.localeCompare(a.date));
  return merged;
}

export async function cachePlayerGameLog(
  playerId: number,
  season: string,
  games: PlayerGame[],
): Promise<void> {
  await getPool().query(
    `INSERT INTO player_game_logs (player_id, season, games, fetched_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (player_id, season) DO UPDATE
       SET games = EXCLUDED.games, fetched_at = EXCLUDED.fetched_at`,
    [playerId, season, JSON.stringify(games)],
  );
}

export async function getTeamGameLogFromDb(
  teamId: number,
  season: string,
): Promise<TeamGame[] | null> {
  const { rows } = await getPool().query<{ games: TeamGame[] }>(
    'SELECT games FROM team_game_logs WHERE team_id = $1 AND season = $2',
    [teamId, season],
  );
  return rows[0]?.games ?? null;
}

export async function getTeamGameLogsMultiFromDb(
  teamId: number,
  seasons: string[],
): Promise<TeamGame[] | null> {
  const { rows } = await getPool().query<{ games: TeamGame[]; season: string }>(
    `SELECT games, season FROM team_game_logs
      WHERE team_id = $1 AND season = ANY($2::text[])`,
    [teamId, seasons],
  );
  if (rows.length === 0) return null;
  const merged = rows.flatMap((r) => r.games);
  merged.sort((a, b) => b.date.localeCompare(a.date));
  return merged;
}

export async function cacheTeamGameLog(
  teamId: number,
  season: string,
  games: TeamGame[],
): Promise<void> {
  await getPool().query(
    `INSERT INTO team_game_logs (team_id, season, games, fetched_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (team_id, season) DO UPDATE
       SET games = EXCLUDED.games, fetched_at = EXCLUDED.fetched_at`,
    [teamId, season, JSON.stringify(games)],
  );
}

export async function listActivePlayerIdsFromDb(): Promise<number[]> {
  const { rows } = await getPool().query<{ id: number }>(
    'SELECT id FROM players WHERE is_active = TRUE ORDER BY id',
  );
  return rows.map((r) => r.id);
}

// Most recent NBA game date in our cache. Computed by scanning team game-log
// JSONB rows (each team has up to 82 games × 3 seasons; a few thousand rows
// total — fine for an unindexed scan, runs in <100ms on Neon).
export async function getDataFreshness(): Promise<{
  lastGameDate: string | null;
  daysStale: number | null;
}> {
  const { rows } = await getPool().query<{ last_game_date: string | null }>(
    `SELECT MAX((g->>'date')::date)::text AS last_game_date
       FROM team_game_logs, jsonb_array_elements(games) g`,
  );
  const last = rows[0]?.last_game_date ?? null;
  if (!last) return { lastGameDate: null, daysStale: null };

  const lastMs = new Date(last + 'T00:00:00Z').getTime();
  const todayUtc = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  const daysStale = Math.max(0, Math.round((todayUtc - lastMs) / (1000 * 60 * 60 * 24)));
  return { lastGameDate: last, daysStale };
}
