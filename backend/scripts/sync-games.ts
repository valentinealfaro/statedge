import 'dotenv/config';
import {
  cachePlayerGameLog,
  cacheTeamGameLog,
  isDbConfigured,
  listActivePlayerIdsFromDb,
  getPool,
} from '../src/db.js';
import {
  currentSeason,
  getPlayerGameLog,
  getTeamGameLog,
  type PlayerGame,
  type TeamGame,
} from '../src/nba/client.js';
import { NBA_TEAMS } from '../src/nba/teams.js';

// Pull both Regular Season and Playoffs and merge them into a single cache
// row per (team|player, season). Playoff games come first (they're the most
// recent) so the freshness banner reflects the latest action — without this
// the cache stops at ~April every year.
async function fetchAllForTeam(teamId: number, season: string): Promise<TeamGame[]> {
  const reg = await getTeamGameLog(teamId, season, 'Regular Season').catch(() => []);
  await sleep(250);
  const post = await getTeamGameLog(teamId, season, 'Playoffs').catch(() => []);
  return mergeNewestFirst(post, reg, (g) => g.gameId);
}

async function fetchAllForPlayer(playerId: number, season: string): Promise<PlayerGame[]> {
  const reg = await getPlayerGameLog(playerId, season, 'Regular Season').catch(() => []);
  await sleep(250);
  const post = await getPlayerGameLog(playerId, season, 'Playoffs').catch(() => []);
  return mergeNewestFirst(post, reg, (g) => g.gameId);
}

function mergeNewestFirst<T>(a: T[], b: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const g of [...a, ...b]) {
    const k = key(g);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
}

async function main() {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  // Allow backfilling past seasons via SEASON env var ("2024-25", "2023-24", etc).
  // Defaults to the current season so the scheduled task stays unchanged.
  const season = process.env.SEASON?.trim() || currentSeason();
  console.log(`Syncing game logs for season ${season} (Regular Season + Playoffs)...`);

  // Teams: 30 calls × 2 season types = 60. Still quick.
  console.log(`\nTeams (${NBA_TEAMS.length}):`);
  for (const t of NBA_TEAMS) {
    try {
      const games = await fetchAllForTeam(t.id, season);
      await cacheTeamGameLog(t.id, season, games);
      const reg = games.filter((g) => /vs\.|@/.test(g.matchup)).length;
      console.log(`  ${t.abbreviation}: ${games.length} games (${reg} total entries)`);
      await sleep(400);
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
      const games = await fetchAllForPlayer(id, season);
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
