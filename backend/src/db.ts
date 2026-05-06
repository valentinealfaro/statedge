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
