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
  l10Wins: number;
  l10Losses: number;
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
    l10_wins: number;
    l10_losses: number;
  }>(
    `WITH ranked AS (
       SELECT
         tgl.team_id,
         g->>'result'                                              AS result,
         (g->>'points')::numeric                                   AS pts,
         ROW_NUMBER() OVER (
           PARTITION BY tgl.team_id
           ORDER BY (g->>'date')::date DESC, g->>'gameId' DESC
         )                                                         AS rn
       FROM team_game_logs tgl
       , jsonb_array_elements(tgl.games) g
       WHERE tgl.season = $1
     )
     SELECT
       team_id,
       COUNT(*) FILTER (WHERE result = 'W')::int                    AS wins,
       COUNT(*) FILTER (WHERE result = 'L')::int                    AS losses,
       COUNT(*)::int                                                AS games,
       AVG(pts)                                                     AS ppg,
       COUNT(*) FILTER (WHERE result = 'W' AND rn <= 10)::int       AS l10_wins,
       COUNT(*) FILTER (WHERE result = 'L' AND rn <= 10)::int       AS l10_losses
     FROM ranked
     GROUP BY team_id`,
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
      l10Wins: Number(r.l10_wins),
      l10Losses: Number(r.l10_losses),
    }];
  });

  const cmp = (a: StandingRow, b: StandingRow) =>
    b.winPct - a.winPct || b.wins - a.wins || a.fullName.localeCompare(b.fullName);

  return {
    east: standings.filter((s) => s.conference === 'East').sort(cmp),
    west: standings.filter((s) => s.conference === 'West').sort(cmp),
  };
}

export type RosterPlayer = NbaPlayer & {
  ppg: number;
  rpg: number;
  apg: number;
  minutes: number;
  gamesPlayed: number;
};

// Returns every active player on a team, joined with their season
// minutes so we can sort the rotation up top. Players who haven't
// played this season show last with zeros.
export async function getTeamRosterFromDb(
  season: string,
  teamId: number,
): Promise<RosterPlayer[]> {
  const { rows } = await getPool().query<{
    id: number;
    full_name: string;
    first_name: string | null;
    last_name: string | null;
    team_id: number | null;
    is_active: boolean;
    minutes: number | null;
    games: number | null;
    ppg: number | null;
    rpg: number | null;
    apg: number | null;
  }>(
    `WITH player_stats AS (
       SELECT
         pgl.player_id,
         SUM((g->>'minutes')::numeric)   AS minutes,
         COUNT(*)::int                   AS games,
         AVG((g->>'points')::numeric)    AS ppg,
         AVG((g->>'rebounds')::numeric)  AS rpg,
         AVG((g->>'assists')::numeric)   AS apg
       FROM player_game_logs pgl
       , jsonb_array_elements(pgl.games) g
       WHERE pgl.season = $1
       GROUP BY pgl.player_id
     )
     SELECT
       p.id, p.full_name, p.first_name, p.last_name,
       p.team_id, p.is_active,
       ps.minutes, ps.games, ps.ppg, ps.rpg, ps.apg
     FROM players p
     LEFT JOIN player_stats ps ON ps.player_id = p.id
     WHERE p.is_active = TRUE AND p.team_id = $2
     ORDER BY ps.minutes DESC NULLS LAST, p.full_name`,
    [season, teamId],
  );

  const { NBA_TEAMS } = await import('./nba/teams.js');
  const team = NBA_TEAMS.find((t) => t.id === teamId);

  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    firstName: r.first_name ?? '',
    lastName: r.last_name ?? '',
    teamId: r.team_id,
    teamAbbreviation: team?.abbreviation ?? null,
    isActive: r.is_active,
    minutes: r.minutes ? Math.round(Number(r.minutes)) : 0,
    gamesPlayed: r.games ?? 0,
    ppg: r.ppg ? round1(Number(r.ppg)) : 0,
    rpg: r.rpg ? round1(Number(r.rpg)) : 0,
    apg: r.apg ? round1(Number(r.apg)) : 0,
  }));
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

// -----------------------------------------------------------------
// Daily slate — the "today's prop board" the admin sets, served
// publicly to /slate so every visitor sees the same lines without
// having to paste anything. Keyed by ET-calendar date so US sports
// users see the right day even at 1am UTC.
// -----------------------------------------------------------------

export type StoredSlateLine = {
  playerName: string;
  statLabel: string;
  line: number;
  team?: string;
  opponentAbbr?: string | null;
  // 'over' = PrizePicks Demon (over-only, higher payout)
  // 'under' = PrizePicks Goblin (under-only, lower line)
  // 'both' = standard prop, both sides available
  direction?: 'over' | 'under' | 'both';
};

async function ensureDailySlateTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS daily_slate (
      slate_date DATE PRIMARY KEY,
      lines JSONB NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

// US Eastern calendar date — sports lock on the East Coast clock so
// using ET avoids a 1am-UTC slate bleed-over.
function todayEt(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

export async function getDailySlateFromDb(): Promise<{
  date: string;
  lines: StoredSlateLine[];
  updatedAt: string;
} | null> {
  await ensureDailySlateTable();
  const date = todayEt();
  const { rows } = await getPool().query<{
    slate_date: string;
    lines: StoredSlateLine[];
    updated_at: Date;
  }>(
    `SELECT slate_date::text, lines, updated_at FROM daily_slate WHERE slate_date = $1`,
    [date],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    date: r.slate_date,
    lines: r.lines,
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function setDailySlateInDb(lines: StoredSlateLine[]): Promise<{
  date: string;
  count: number;
}> {
  await ensureDailySlateTable();
  const date = todayEt();
  await getPool().query(
    `INSERT INTO daily_slate (slate_date, lines, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (slate_date) DO UPDATE
       SET lines = EXCLUDED.lines, updated_at = NOW()`,
    [date, JSON.stringify(lines)],
  );
  return { date, count: lines.length };
}

// -----------------------------------------------------------------
// MLB daily slate — mirrors the NBA daily_slate table but stores the
// pipe-format MLB lines (per the MLB slate route's contract). Same
// admin-publishes-once-per-day flow: GET /api/mlb/slate/today reads
// the published slate, POST replaces it, public users see whatever
// was last posted.
// -----------------------------------------------------------------

export type MlbStoredDailyLine = {
  playerId: number;
  statKey: string;
  line: number;
  direction?: 'over' | 'under' | 'both';
  gamePk?: number;
  opponentTeamId?: number;
  isHome?: boolean;
  opposingPitcherId?: number;
  // Original raw text (pipe-format) so the admin can re-edit later.
  rawText?: string;
};

async function ensureMlbDailySlateTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS mlb_daily_slate (
      slate_date DATE PRIMARY KEY,
      lines JSONB NOT NULL,
      raw_text TEXT,
      mode TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  // Defensive idempotent column-add — old rows might predate raw_text/mode.
  await getPool().query(`
    DO $$ BEGIN
      ALTER TABLE mlb_daily_slate ADD COLUMN IF NOT EXISTS raw_text TEXT;
      ALTER TABLE mlb_daily_slate ADD COLUMN IF NOT EXISTS mode TEXT;
    END $$;
  `).catch(() => { /* ignore — older Postgres without DO $$ */ });
}

export async function getMlbDailySlateFromDb(): Promise<{
  date: string;
  lines: MlbStoredDailyLine[];
  rawText: string | null;
  mode: string | null;
  updatedAt: string;
} | null> {
  await ensureMlbDailySlateTable();
  const date = todayEt();
  const { rows } = await getPool().query<{
    slate_date: string;
    lines: MlbStoredDailyLine[];
    raw_text: string | null;
    mode: string | null;
    updated_at: Date;
  }>(
    `SELECT slate_date::text, lines, raw_text, mode, updated_at
       FROM mlb_daily_slate WHERE slate_date = $1`,
    [date],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    date: r.slate_date,
    lines: r.lines,
    rawText: r.raw_text,
    mode: r.mode,
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function setMlbDailySlateInDb(opts: {
  lines: MlbStoredDailyLine[];
  rawText: string | null;
  mode: string | null;
}): Promise<{ date: string; count: number }> {
  await ensureMlbDailySlateTable();
  const date = todayEt();
  await getPool().query(
    `INSERT INTO mlb_daily_slate (slate_date, lines, raw_text, mode, updated_at)
     VALUES ($1, $2::jsonb, $3, $4, NOW())
     ON CONFLICT (slate_date) DO UPDATE
       SET lines = EXCLUDED.lines,
           raw_text = EXCLUDED.raw_text,
           mode = EXCLUDED.mode,
           updated_at = NOW()`,
    [date, JSON.stringify(opts.lines), opts.rawText, opts.mode],
  );
  return { date, count: opts.lines.length };
}

export async function clearMlbDailySlateFromDb(): Promise<void> {
  await ensureMlbDailySlateTable();
  const date = todayEt();
  await getPool().query(
    `DELETE FROM mlb_daily_slate WHERE slate_date = $1`,
    [date],
  );
}

// -----------------------------------------------------------------
// MLB resolved-slate cache (cross-instance via Postgres).
//
// In-memory caching doesn't work on Vercel because each request can
// land on a different serverless instance. A 25-second projection
// run for a 3000-leg slate would have to repeat on every cold hit.
// This shared-Postgres cache means the FIRST visitor pays the cost
// and every other visitor across every instance gets the cached
// payload until TTL expires.
// -----------------------------------------------------------------

async function ensureMlbSlateCacheTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS mlb_slate_cache (
      cache_key TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
}

export async function getMlbSlateCache(cacheKey: string): Promise<unknown | null> {
  await ensureMlbSlateCacheTable();
  const { rows } = await getPool().query<{
    payload: unknown;
    expires_at: Date;
  }>(
    `SELECT payload, expires_at FROM mlb_slate_cache
      WHERE cache_key = $1 AND expires_at > NOW()`,
    [cacheKey],
  );
  return rows[0]?.payload ?? null;
}

export async function setMlbSlateCache(
  cacheKey: string,
  payload: unknown,
  ttlMs: number,
): Promise<void> {
  await ensureMlbSlateCacheTable();
  const expiresAt = new Date(Date.now() + ttlMs);
  await getPool().query(
    `INSERT INTO mlb_slate_cache (cache_key, payload, expires_at)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (cache_key) DO UPDATE
       SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
    [cacheKey, JSON.stringify(payload), expiresAt],
  );
}

export async function purgeMlbSlateCacheDb(): Promise<void> {
  await ensureMlbSlateCacheTable();
  // Clear EVERYTHING — admin re-publish should evict regardless of
  // mode/date in the key. Cheap (table is tiny, max ~5 entries per day).
  await getPool().query(`DELETE FROM mlb_slate_cache`);
}

// -----------------------------------------------------------------
// Slate results — snapshotted pre-built parlays per ET date plus the
// graded outcome once games are final. Schema lives in db/schema.sql;
// we ensureSlateResultsTable on every read/write so a fresh DB doesn't
// 500 if migrations haven't been run yet.
// -----------------------------------------------------------------

async function ensureSlateResultsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS slate_results (
      slate_date   DATE PRIMARY KEY,
      combos       JSONB NOT NULL,
      results      JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at  TIMESTAMPTZ
    )
  `);
}

export type SlateSnapshotRow = {
  date: string;
  combos: unknown;            // Combo[] from services/slateCombos.ts
  results: unknown | null;    // GradedCombo[] from services/slateGrade.ts
  createdAt: string;
  resolvedAt: string | null;
};

// Look up a single day's snapshot (combos + maybe-graded results).
export async function getSlateSnapshotFromDb(
  date: string,
): Promise<SlateSnapshotRow | null> {
  await ensureSlateResultsTable();
  const { rows } = await getPool().query<{
    slate_date: string;
    combos: unknown;
    results: unknown | null;
    created_at: Date;
    resolved_at: Date | null;
  }>(
    `SELECT slate_date::text, combos, results, created_at, resolved_at
       FROM slate_results
      WHERE slate_date = $1`,
    [date],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    date: r.slate_date,
    combos: r.combos,
    results: r.results,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}

// List recent snapshots (newest first). Used by the History tab to
// render the day-picker. Bounded by `limit` to keep the response light.
export async function listSlateSnapshotsFromDb(
  limit = 30,
): Promise<SlateSnapshotRow[]> {
  await ensureSlateResultsTable();
  const { rows } = await getPool().query<{
    slate_date: string;
    combos: unknown;
    results: unknown | null;
    created_at: Date;
    resolved_at: Date | null;
  }>(
    `SELECT slate_date::text, combos, results, created_at, resolved_at
       FROM slate_results
      ORDER BY slate_date DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    date: r.slate_date,
    combos: r.combos,
    results: r.results,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  }));
}

// Like getDailySlateFromDb but takes an explicit date. Used by the
// history backfill path when a deep link to /slate/history/:date hits
// a date that has no snapshot yet — we still need the raw lines from
// daily_slate to materialize one.
export async function getDailySlateByDateFromDb(
  date: string,
): Promise<{ date: string; lines: StoredSlateLine[] } | null> {
  await ensureDailySlateTable();
  const { rows } = await getPool().query<{
    slate_date: string;
    lines: StoredSlateLine[];
  }>(
    `SELECT slate_date::text, lines FROM daily_slate WHERE slate_date = $1`,
    [date],
  );
  const r = rows[0];
  if (!r) return null;
  return { date: r.slate_date, lines: r.lines };
}

// Backfill source for the History tab. Returns past `daily_slate` rows
// (the raw published lines) that don't yet have a `slate_results`
// snapshot. The /slate/history handler resolves each one with an
// `asOfDate` filter and writes a snapshot, so days that pre-date the
// History feature still show up. Excludes today's date — today's
// snapshot is owned by the live /slate/today fetch path.
export async function listDailySlatesMissingSnapshotFromDb(
  todayEt: string,
  limit: number,
): Promise<Array<{ date: string; lines: StoredSlateLine[] }>> {
  await ensureDailySlateTable();
  await ensureSlateResultsTable();
  const { rows } = await getPool().query<{
    slate_date: string;
    lines: StoredSlateLine[];
  }>(
    `SELECT ds.slate_date::text, ds.lines
       FROM daily_slate ds
       LEFT JOIN slate_results sr ON sr.slate_date = ds.slate_date
      WHERE sr.slate_date IS NULL
        AND ds.slate_date < $1::date
      ORDER BY ds.slate_date DESC
      LIMIT $2`,
    [todayEt, limit],
  );
  return rows.map((r) => ({ date: r.slate_date, lines: r.lines }));
}

// Snapshot today's combos. Two modes:
//
//   - default (insert-only) — used by the History backfill path. If a
//     row exists for the date, leave it alone. Past days are frozen
//     once snapshotted.
//
//   - upsertIfPending — used by the live /slate/today path. If the
//     row exists AND has not yet been graded (`resolved_at IS NULL`),
//     OVERWRITE the combos with the fresh ones. Once any grading has
//     happened (resolved_at set), the row freezes — you can't change
//     picks that already played.
//
// Why upsertIfPending matters: when we ship a combo-builder
// improvement (diversity-first, correlation fix, line-raising, etc),
// today's snapshot was written under the old algo and would otherwise
// stay frozen forever. The History tab would show stale picks for
// today even though the games haven't been played yet. With
// upsertIfPending, the next /slate/today fetch refreshes the snapshot
// to reflect the latest algo.
//
// Determinism trade-off: visitors during the day may see slightly
// different combos as PrizePicks lines drift. That's acceptable
// because (a) the slate already updates that way for live data and
// (b) once games tip off and grading begins, the snapshot freezes.
export async function snapshotSlateCombosInDb(
  date: string,
  combos: unknown,
  options: { upsertIfPending?: boolean } = {},
): Promise<{ inserted: boolean; updated: boolean }> {
  await ensureSlateResultsTable();
  if (options.upsertIfPending) {
    const { rowCount } = await getPool().query(
      `INSERT INTO slate_results (slate_date, combos)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (slate_date) DO UPDATE
         SET combos = EXCLUDED.combos
         WHERE slate_results.resolved_at IS NULL`,
      [date, JSON.stringify(combos)],
    );
    return { inserted: false, updated: (rowCount ?? 0) > 0 };
  }
  const { rowCount } = await getPool().query(
    `INSERT INTO slate_results (slate_date, combos)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (slate_date) DO NOTHING`,
    [date, JSON.stringify(combos)],
  );
  return { inserted: (rowCount ?? 0) > 0, updated: false };
}

// Fill in graded results for a previously-locked snapshot. Idempotent:
// safe to re-grade the same date if the resolver finds new finalized
// games on a second pass.
export async function setSlateResolvedInDb(
  date: string,
  results: unknown,
): Promise<void> {
  await ensureSlateResultsTable();
  await getPool().query(
    `UPDATE slate_results
        SET results = $2::jsonb,
            resolved_at = NOW()
      WHERE slate_date = $1`,
    [date, JSON.stringify(results)],
  );
}
