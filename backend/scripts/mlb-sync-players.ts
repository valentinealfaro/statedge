// Sync active MLB players for the current season from statsapi.mlb.com
// into mlb_players. Run AFTER mlb-sync-teams (player rows reference
// team_id). Run via:  npm run mlb:sync-players [season]
//
// Acceptance: ~1,500 active players loaded for an in-season run.

import 'dotenv/config';
import { isDbConfigured } from '../src/db.js';
import { getAllPlayers } from '../src/mlb/client.js';
import { upsertMlbPlayers, getMlbCounts } from '../src/mlb/db.js';

function currentSeason(): number {
  // MLB season runs roughly March → October. Use the current year
  // unless we're in Jan/Feb (in which case the prior year's data is
  // still the "current" reference for offseason syncs).
  const now = new Date();
  const month = now.getMonth() + 1;     // 1-12
  return month <= 2 ? now.getFullYear() - 1 : now.getFullYear();
}

async function main() {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const seasonArg = process.argv[2];
  const season = seasonArg ? Number(seasonArg) : currentSeason();
  if (!Number.isFinite(season) || season < 2000) {
    console.error(`Invalid season: ${seasonArg}`);
    process.exit(1);
  }
  console.log(`Fetching MLB players for season ${season}...`);
  const players = await getAllPlayers(season);
  console.log(`Fetched ${players.length} players. Upserting...`);
  const upserted = await upsertMlbPlayers(players);
  console.log(`Upserted ${upserted} MLB players.`);
  const counts = await getMlbCounts();
  console.log(`mlb_players now has ${counts.players} rows.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('mlb-sync-players failed:', err);
  process.exit(1);
});
