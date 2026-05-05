import 'dotenv/config';
import {
  cachePlayerGameLog,
  cacheTeamGameLog,
  isDbConfigured,
  listActivePlayerIdsFromDb,
  getPool,
} from '../src/db.js';
import { currentSeason, getPlayerGameLog, getTeamGameLog } from '../src/nba/client.js';
import { NBA_TEAMS } from '../src/nba/teams.js';

async function main() {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  // Allow backfilling past seasons via SEASON env var ("2024-25", "2023-24", etc).
  // Defaults to the current season so the GitHub Actions cron stays unchanged.
  const season = process.env.SEASON?.trim() || currentSeason();
  console.log(`Syncing game logs for season ${season}...`);

  // Teams: 30 calls. Quick.
  console.log(`\nTeams (${NBA_TEAMS.length}):`);
  for (const t of NBA_TEAMS) {
    try {
      const games = await getTeamGameLog(t.id, season);
      await cacheTeamGameLog(t.id, season, games);
      console.log(`  ${t.abbreviation}: ${games.length} games`);
      await sleep(400); // be polite to stats.nba.com
    } catch (err) {
      console.error(`  ${t.abbreviation}: FAILED -`, (err as Error).message);
    }
  }

  // Players: only active ones, to keep this manageable.
  const playerIds = await listActivePlayerIdsFromDb();
  console.log(`\nActive players (${playerIds.length}):`);
  let ok = 0, fail = 0;
  for (const id of playerIds) {
    try {
      const games = await getPlayerGameLog(id, season);
      if (games.length > 0) {
        await cachePlayerGameLog(id, season, games);
        ok += 1;
      }
      if ((ok + fail) % 25 === 0) {
        console.log(`  ${ok + fail}/${playerIds.length} (${ok} cached, ${fail} failed)`);
      }
      await sleep(400);
    } catch (err) {
      fail += 1;
      // Don't spam logs — just count.
      if (fail < 10) {
        console.error(`  player ${id}: FAILED -`, (err as Error).message);
      }
    }
  }
  console.log(`\nDone. ${ok} player logs cached, ${fail} failures.`);

  await getPool().end();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
