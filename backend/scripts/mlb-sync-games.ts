// Sync MLB games + per-player game logs for a season from
// statsapi.mlb.com. Run AFTER mlb-sync-teams + mlb-sync-players.
// Run via:  npm run mlb:sync-games [season] [--limit N]
//
// What it does, in order:
//   1. Pull the season schedule (one chunk per month so the API
//      doesn't truncate).
//   2. Upsert mlb_games rows.
//   3. For each active player, pull their game log and upsert
//      hitter or pitcher stats depending on type. Sequential,
//      with a 200ms sleep between players to be polite to the API.
//
// `--limit N` caps the player sweep at N players for testing — drop
// the flag for a full sync.

import 'dotenv/config';
import { isDbConfigured } from '../src/db.js';
import {
  getGameLog,
  getScheduleRange,
  sleep,
} from '../src/mlb/client.js';
import { getPool } from '../src/db.js';
import {
  ensureMlbTables,
  getMlbCounts,
  listActiveMlbPlayerIdsFromDb,
  upsertMlbGames,
  upsertMlbHittingStat,
  upsertMlbPitchingStat,
} from '../src/mlb/db.js';

function currentSeason(): number {
  const now = new Date();
  const month = now.getMonth() + 1;
  return month <= 2 ? now.getFullYear() - 1 : now.getFullYear();
}

function parseLimit(): number | null {
  const idx = process.argv.indexOf('--limit');
  if (idx === -1) return null;
  const n = Number(process.argv[idx + 1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function syncSchedule(season: number): Promise<number> {
  // Walk month-by-month to keep response sizes manageable. MLB's
  // schedule endpoint can return the whole season in one go but the
  // payload is large — chunking keeps memory and timeouts reasonable.
  let total = 0;
  for (let month = 3; month <= 11; month += 1) {
    const start = `${season}-${String(month).padStart(2, '0')}-01`;
    const end =   `${season}-${String(month).padStart(2, '0')}-${month === 2 ? 28 : 31}`;
    try {
      const games = await getScheduleRange(start, end);
      if (games.length === 0) continue;
      const upserted = await upsertMlbGames(games);
      total += upserted;
      console.log(`  ${start} → ${end}: ${upserted} games`);
    } catch (err) {
      console.warn(`  ${start} → ${end} schedule fetch failed:`, (err as Error).message);
    }
  }
  return total;
}

async function isPitcherInDb(playerId: number): Promise<boolean> {
  const { rows } = await getPool().query<{ is_pitcher: boolean }>(
    `SELECT is_pitcher FROM mlb_players WHERE id = $1`,
    [playerId],
  );
  return rows[0]?.is_pitcher ?? false;
}

async function gameExistsInDb(gameId: number): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM mlb_games WHERE id = $1) AS exists`,
    [gameId],
  );
  return rows[0]?.exists ?? false;
}

async function syncPlayerGameLog(
  playerId: number,
  season: number,
  isPitcher: boolean,
): Promise<number> {
  const group = isPitcher ? 'pitching' : 'hitting';
  let entries;
  try {
    entries = await getGameLog(playerId, season, group);
  } catch (err) {
    // Players with no games in this group return 200 + empty splits;
    // a real fetch error is rare but we don't want one bad player to
    // kill the whole sync.
    console.warn(`  player ${playerId} ${group} log fetch failed:`, (err as Error).message);
    return 0;
  }
  let written = 0;
  for (const e of entries) {
    if (!e.gamePk) continue;
    // Foreign-key safety: skip stats for games we haven't synced yet
    // (e.g. spring training games not in the regular-season schedule).
    if (!(await gameExistsInDb(e.gamePk))) continue;
    if (isPitcher) {
      await upsertMlbPitchingStat(playerId, e);
    } else {
      await upsertMlbHittingStat(playerId, e);
    }
    written += 1;
  }
  return written;
}

async function main() {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  await ensureMlbTables();
  const seasonArg = process.argv[2] && !process.argv[2].startsWith('--')
    ? Number(process.argv[2])
    : currentSeason();
  if (!Number.isFinite(seasonArg) || seasonArg < 2000) {
    console.error(`Invalid season: ${seasonArg}`);
    process.exit(1);
  }
  const limit = parseLimit();

  console.log(`Syncing MLB schedule for ${seasonArg}...`);
  const games = await syncSchedule(seasonArg);
  console.log(`  total games upserted: ${games}`);

  console.log(`Syncing player game logs (limit: ${limit ?? 'none'})...`);
  const playerIds = await listActiveMlbPlayerIdsFromDb();
  const targetIds = limit ? playerIds.slice(0, limit) : playerIds;
  let totalStats = 0;
  let processed = 0;
  for (const playerId of targetIds) {
    const isPitcher = await isPitcherInDb(playerId);
    const written = await syncPlayerGameLog(playerId, seasonArg, isPitcher);
    totalStats += written;
    processed += 1;
    if (processed % 25 === 0) {
      console.log(`  ${processed}/${targetIds.length} players · ${totalStats} stats`);
    }
    await sleep(200);     // polite delay between players
  }
  console.log(`Synced ${totalStats} stat rows across ${processed} players.`);
  const counts = await getMlbCounts();
  console.log(
    `mlb_games: ${counts.games} · ` +
    `mlb_hitting_stats: ${counts.hittingStats} · ` +
    `mlb_pitching_stats: ${counts.pitchingStats}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('mlb-sync-games failed:', err);
  process.exit(1);
});
