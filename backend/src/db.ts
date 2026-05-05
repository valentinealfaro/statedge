import pg from 'pg';
import type { NbaPlayer } from './nba/client.js';

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
