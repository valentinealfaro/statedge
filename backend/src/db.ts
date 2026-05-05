import pg from 'pg';

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
