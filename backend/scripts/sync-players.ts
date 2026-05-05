import 'dotenv/config';
import { getPool, isDbConfigured } from '../src/db.js';
import { getAllPlayers } from '../src/nba/client.js';
import { NBA_TEAMS } from '../src/nba/teams.js';

async function main() {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = getPool();

  console.log('Upserting NBA teams...');
  for (const t of NBA_TEAMS) {
    await pool.query(
      `INSERT INTO teams (id, league, abbreviation, city, name, full_name, conference, division)
       VALUES ($1, 'nba', $2, $3, $4, $5, $6, NULL)
       ON CONFLICT (id) DO UPDATE
         SET abbreviation = EXCLUDED.abbreviation,
             city         = EXCLUDED.city,
             name         = EXCLUDED.name,
             full_name    = EXCLUDED.full_name,
             conference   = EXCLUDED.conference`,
      [t.id, t.abbreviation, t.city, t.name, t.fullName, t.conference],
    );
  }
  console.log(`Upserted ${NBA_TEAMS.length} teams.`);

  console.log('Fetching all NBA players from stats.nba.com...');
  const players = await getAllPlayers();
  console.log(`Got ${players.length} players. Upserting...`);

  let i = 0;
  for (const p of players) {
    await pool.query(
      `INSERT INTO players (id, league, team_id, first_name, last_name, full_name, position, is_active)
       VALUES ($1, 'nba', $2, $3, $4, $5, NULL, $6)
       ON CONFLICT (id) DO UPDATE
         SET team_id     = EXCLUDED.team_id,
             first_name  = EXCLUDED.first_name,
             last_name   = EXCLUDED.last_name,
             full_name   = EXCLUDED.full_name,
             is_active   = EXCLUDED.is_active`,
      [p.id, p.teamId, p.firstName, p.lastName, p.fullName, p.isActive],
    );
    i += 1;
    if (i % 500 === 0) console.log(`  ${i}/${players.length}`);
  }
  console.log(`Upserted ${players.length} players.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
