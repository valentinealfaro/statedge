// MLB grader. Walks ungraded rows in mlb_projection_history, joins
// with mlb_hitting_stats / mlb_pitching_stats by player_id +
// game_date, computes the actual stat value for each pick, then
// fills in result_value + hit_or_miss.
//
// Design points:
//   - Lazy: invoked on demand from /api/mlb/calibration. We don't run
//     a continuous grader cron — once games are in the stats tables
//     (after the daily MLB sync), the next calibration request grades
//     anything ripe.
//   - Conservative: only grades rows where the player ACTUALLY played
//     on that date. DNPs / postponed games stay ungraded. We don't
//     fabricate "0" for missed games — that's the spec's explicit
//     "no fake completeness" principle.
//   - Direction-aware: OVER hits when actual > line; UNDER hits when
//     actual < line; equal = push (we record null hit_or_miss).

import { getPool } from '../db.js';
import {
  type HittingRow,
  type MlbHitterStatKey,
  type MlbPitcherStatKey,
  type MlbStatKey,
  playerTypeForStat,
  valueFromHittingRow,
  valueFromPitchingRow,
} from '../mlb/stats.js';
import { classifyFailure } from './failureArchetype.js';
import {
  listMlbProjections,
  setMlbProjectionResult,
  type StoredProjection,
} from './mlbProjectionHistory.js';

export type GradeOutcome = 'hit' | 'miss' | 'push' | 'no_game';

export type GradeResult = {
  scanned: number;
  graded: number;
  hits: number;
  misses: number;
  pushes: number;
  noGame: number;
};

// Pull ungraded rows in the window, look each one up against the
// stat tables, persist the result if available. Returns a small
// summary so the caller can show "graded N picks today."
export async function gradeMlbProjections(opts?: {
  windowDays?: number;
  // Skip rows from today (game might still be live). Default true —
  // override only for testing.
  skipToday?: boolean;
}): Promise<GradeResult> {
  const ungraded = await listMlbProjections({
    windowDays: opts?.windowDays ?? 90,
    graded: 'ungraded',
  });
  const skipToday = opts?.skipToday ?? true;
  const today = todayIsoUtc();

  const result: GradeResult = {
    scanned: ungraded.length,
    graded: 0,
    hits: 0,
    misses: 0,
    pushes: 0,
    noGame: 0,
  };

  for (const row of ungraded) {
    if (skipToday && row.gameDate >= today) continue;
    const outcome = await gradeOne(row);
    if (outcome === 'no_game') {
      result.noGame += 1;
      continue;
    }
    result.graded += 1;
    if (outcome === 'hit') result.hits += 1;
    else if (outcome === 'miss') result.misses += 1;
    else result.pushes += 1;
  }

  return result;
}

// Grade a single row. Returns the outcome, also persists if we
// found stats. Returns 'no_game' when the player has no entry on
// that date (DNP / postponed) — those rows stay ungraded so they
// can grade later when stats arrive.
async function gradeOne(row: StoredProjection): Promise<GradeOutcome> {
  const playerType = playerTypeForStat(row.selectedStat);
  if (!playerType) return 'no_game';     // shouldn't happen; defensive
  const actual =
    playerType === 'hitter'
      ? await readHitterValueForDate(
          row.playerId,
          row.gameDate,
          row.selectedStat as MlbHitterStatKey,
        )
      : await readPitcherValueForDate(
          row.playerId,
          row.gameDate,
          row.selectedStat as MlbPitcherStatKey,
        );
  if (actual === null) return 'no_game';

  // Direction-aware outcome. Equal-to-line is a push; record value
  // but leave hit_or_miss null. PrizePicks treats pushes as a tier
  // revert; for calibration we exclude them from accuracy bucket.
  let outcome: GradeOutcome;
  if (actual > row.lineValue) outcome = row.direction === 'OVER' ? 'hit' : 'miss';
  else if (actual < row.lineValue) outcome = row.direction === 'UNDER' ? 'hit' : 'miss';
  else outcome = 'push';

  if (outcome === 'push') {
    // Persist value but don't claim a hit/miss. Calibration excludes.
    await getPool().query(
      `UPDATE mlb_projection_history
          SET result_value = $1,
              hit_or_miss  = NULL,
              graded_at    = NOW()
        WHERE id = $2`,
      [actual, row.id],
    );
  } else {
    // Phase 102 Loss Forensics — only on misses. Hits get null
    // failure_archetype so the calibration aggregator can filter
    // cleanly with `WHERE failure_archetype IS NOT NULL`.
    const failureArchetype = outcome === 'miss'
      ? classifyFailure({
          probability: row.probability,
          edgePercent: row.edgePercent ?? 0,
          projection: row.projectionValue,
          line: row.lineValue,
          direction: row.direction,
          trapScore: row.trapScore ?? 0,
          fragilityScore: row.fragilityScore ?? 50,
          momentumScore: row.momentumScore,
          lineInflationScore: row.lineInflationScore ?? 0,
          publicBiasTags: row.publicBiasTags ?? [],
          resultValue: actual,
        })
      : null;
    await setMlbProjectionResult({
      id: row.id,
      resultValue: actual,
      hitOrMiss: outcome === 'hit',
      failureArchetype,
    });
  }
  return outcome;
}

async function readHitterValueForDate(
  playerId: number,
  gameDate: string,
  statKey: MlbHitterStatKey,
): Promise<number | null> {
  const { rows } = await getPool().query<{
    hits: number | null;
    singles: number | null;
    doubles: number | null;
    triples: number | null;
    home_runs: number | null;
    total_bases: number | null;
    runs: number | null;
    rbis: number | null;
    walks: number | null;
    strikeouts: number | null;
    stolen_bases: number | null;
    plate_appearances: number | null;
  }>(
    `SELECT hs.hits, hs.singles, hs.doubles, hs.triples, hs.home_runs,
            hs.total_bases, hs.runs, hs.rbis, hs.walks, hs.strikeouts,
            hs.stolen_bases, hs.plate_appearances
       FROM mlb_hitting_stats hs
       JOIN mlb_games g ON g.id = hs.game_id
      WHERE hs.player_id = $1 AND g.game_date = $2`,
    [playerId, gameDate],
  );
  // Doubleheader handling: sum across multiple games on the same
  // date if both are in the table. PrizePicks generally treats DH
  // game 1 + game 2 as separate props, but calibration-wise summing
  // is a reasonable approximation absent gamePk-level granularity.
  if (rows.length === 0) return null;
  let total = 0;
  let saw = false;
  for (const r of rows) {
    const v = valueFromHittingRow(statKey, r as HittingRow);
    if (v !== null) {
      total += v;
      saw = true;
    }
  }
  return saw ? total : null;
}

async function readPitcherValueForDate(
  playerId: number,
  gameDate: string,
  statKey: MlbPitcherStatKey,
): Promise<number | null> {
  const { rows } = await getPool().query<{
    outs_recorded: number | null;
    innings_pitched: string | null;
    pitches_thrown: number | null;
    hits_allowed: number | null;
    earned_runs_allowed: number | null;
    walks_allowed: number | null;
    strikeouts: number | null;
    home_runs_allowed: number | null;
  }>(
    `SELECT ps.outs_recorded, ps.innings_pitched, ps.pitches_thrown,
            ps.hits_allowed, ps.earned_runs_allowed, ps.walks_allowed,
            ps.strikeouts, ps.home_runs_allowed
       FROM mlb_pitching_stats ps
       JOIN mlb_games g ON g.id = ps.game_id
      WHERE ps.player_id = $1 AND g.game_date = $2`,
    [playerId, gameDate],
  );
  if (rows.length === 0) return null;
  let total = 0;
  let saw = false;
  for (const r of rows) {
    const v = valueFromPitchingRow(statKey, r as Parameters<typeof valueFromPitchingRow>[1]);
    if (v !== null) {
      total += v;
      saw = true;
    }
  }
  return saw ? total : null;
}

function todayIsoUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Pure helper exposed for testing. Given a line + direction + actual,
// returns the outcome. Same logic the grader uses internally.
export function outcomeFor(
  line: number,
  direction: 'OVER' | 'UNDER',
  actual: number,
): Exclude<GradeOutcome, 'no_game'> {
  if (actual > line) return direction === 'OVER' ? 'hit' : 'miss';
  if (actual < line) return direction === 'UNDER' ? 'hit' : 'miss';
  return 'push';
}
