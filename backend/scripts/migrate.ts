import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, isDbConfigured } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set. Add it to backend/.env (Neon connection string).');
    process.exit(1);
  }
  const sql = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const pool = getPool();
  console.log('Running schema.sql...');
  await pool.query(sql);
  console.log('Schema applied.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
