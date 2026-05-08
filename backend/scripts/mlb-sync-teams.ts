// Sync MLB teams from statsapi.mlb.com into mlb_teams. Idempotent —
// can be re-run safely. Run via:  npm run mlb:sync-teams
//
// Acceptance: 30 active teams loaded.

import 'dotenv/config';
import { isDbConfigured } from '../src/db.js';
import { getTeams } from '../src/mlb/client.js';
import { upsertMlbTeams, getMlbCounts } from '../src/mlb/db.js';

async function main() {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  console.log('Fetching MLB teams from statsapi.mlb.com...');
  const teams = await getTeams();
  console.log(`Fetched ${teams.length} teams. Upserting...`);
  const upserted = await upsertMlbTeams(teams);
  console.log(`Upserted ${upserted} MLB teams.`);
  const counts = await getMlbCounts();
  console.log(`mlb_teams now has ${counts.teams} rows.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('mlb-sync-teams failed:', err);
  process.exit(1);
});
