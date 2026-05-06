import 'dotenv/config';
import { getPool, isDbConfigured } from '../src/db.js';

async function main() {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const p = getPool();

  const lastDate = await p.query<{ last_game: string | null }>(
    `SELECT MAX((g->>'date')::date)::text AS last_game
       FROM team_game_logs, jsonb_array_elements(games) g`,
  );

  const teamRows = await p.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM team_game_logs`,
  );
  const teamGamesTotal = await p.query<{ count: string }>(
    `SELECT SUM(jsonb_array_length(games))::bigint AS count FROM team_game_logs`,
  );

  const playerRows = await p.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM player_game_logs`,
  );
  const playerGamesTotal = await p.query<{ count: string }>(
    `SELECT SUM(jsonb_array_length(games))::bigint AS count FROM player_game_logs`,
  );

  const perSeason = await p.query<{ season: string; rows: string }>(
    `SELECT season, COUNT(*)::text AS rows
       FROM player_game_logs
   GROUP BY season
   ORDER BY season DESC`,
  );

  // The legacy normalized tables — should be 0 since the sync uses JSONB cache.
  const normalizedGames = await p.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM games`,
  );
  const normalizedPgs = await p.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM player_game_stats`,
  );

  console.log('=== StatEdge cache diagnose ===');
  console.log(`Most recent NBA game in cache : ${lastDate.rows[0]?.last_game ?? 'n/a'}`);
  console.log(`team_game_logs rows           : ${teamRows.rows[0]!.count}`);
  console.log(`  game entries inside JSONB   : ${teamGamesTotal.rows[0]!.count ?? 0}`);
  console.log(`player_game_logs rows         : ${playerRows.rows[0]!.count}`);
  console.log(`  game entries inside JSONB   : ${playerGamesTotal.rows[0]!.count ?? 0}`);
  console.log('player_game_logs by season    :');
  for (const r of perSeason.rows) console.log(`  ${r.season}: ${r.rows} player rows`);
  console.log('--- normalized tables (currently unused by sync) ---');
  console.log(`games rows                    : ${normalizedGames.rows[0]!.count}`);
  console.log(`player_game_stats rows        : ${normalizedPgs.rows[0]!.count}`);

  await p.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
