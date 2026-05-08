// MLB projection engine — Phase 3.
//
// Two layers, deliberately separated:
//
//   1. computeMlbProjection(inputs) — pure formula. No DB, no
//      randomness, fully testable with synthetic inputs.
//
//   2. projectMlbStat(args) — orchestrator. Loads the inputs from
//      the DB (game-log averages, opponent splits, home/away splits)
//      and hands them to (1).
//
// The pure formula is what tests cover. Calibration / weight tuning
// happens here in one place.
//
// Mission discipline: we only use signals we actually have. Park
// factor, weather, BvP, pitcher arsenal, lineup spot, and bullpen
// context are all deferred to later phases. The formula renormalizes
// the weights of available signals so a missing input doesn't bias
// the projection — it just shrinks the model to what we know.

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
import {
  computeMlbLast10,
  MlbPlayerNotFoundError,
  MlbStatTypeMismatchError,
  type MlbLast10Result,
} from './mlbLast10Engine.js';

// -----------------------------------------------------------------
// Inputs / outputs
// -----------------------------------------------------------------

export type ProjectionInputs = {
  statKey: MlbStatKey;
  playerType: 'hitter' | 'pitcher';
  line: number;
  direction: 'OVER' | 'UNDER';

  // Core distribution from the L10 engine. Always present; everything
  // else is optional (renormalize when missing).
  last10: MlbLast10Result;

  // Long-term baseline: full-season average across however many games
  // have been logged. Drives the "regression to the mean" anchor.
  seasonAverage: number | null;
  seasonGames: number;

  // Per-opponent average (player vs this specific opponent's pitching
  // staff or defense). Most reliable signal we have for matchup.
  opponentAverage: number | null;
  opponentGames: number;

  // Home/away split. is_home === true → use the home avg when the
  // upcoming game is home, etc. Very small weight in v0.
  homeAverage: number | null;
  awayAverage: number | null;
  isHome: boolean | null;     // upcoming game; null = unknown
};

// Stat-type risk per the StatEdge MLB spec. Used as a floor on
// `riskScore` — high-variance stats (HR, SB) are inherently risky
// regardless of how stable the player is at them.
export const STAT_TYPE_RISK: Record<MlbStatKey, number> = {
  hits: 45,
  singles: 50,
  doubles: 70,
  triples: 90,
  home_runs: 85,
  total_bases: 60,
  runs: 55,
  rbis: 60,
  walks: 55,
  strikeouts: 65,                // hitter K
  stolen_bases: 90,
  hits_runs_rbis: 50,
  hitter_fantasy_score: 50,
  ks: 45,                        // pitcher K
  earned_runs_allowed: 65,
  walks_allowed: 60,
  pitcher_outs: 35,
  hits_allowed: 60,
  innings_pitched: 35,
  home_runs_allowed: 80,
  pitches_thrown: 35,
};

export type ProjectionResult = {
  // What we project this stat to be. Renormalized weighted blend of
  // available signals. The "expected value" of the stat for the
  // upcoming game.
  projection: number;
  // 0-100, our model's probability the OVER (or UNDER, depending on
  // direction) hits the line.
  probability: number;
  // 0-100. Higher = more reliable. Driven by sample size + signal
  // agreement (e.g. opponent avg matches L10 avg → high confidence).
  confidence: number;
  // 0-100. Variance / volatility / stat-type risk.
  riskScore: number;
  // 0-100. Trap detection — public-narrative + thin-margin + small-
  // sample + outlier risks combined.
  trapScore: number;
  // Trap label for UI surface.
  trapTier: 'Clean' | 'Mild Trap Risk' | 'Moderate Trap Risk' | 'High Trap Risk' | 'Extreme Trap Risk';
  // 0-100. How well the projection separates from the line, in
  // standard deviations. 0σ → 0; 1σ → 50; 2σ+ → 100.
  projectionDistanceScore: number;
  // edgePercent = modelProbability - implied break-even (default 50).
  edgePercent: number;
  // edgeScore = 0..100, scaled edgePercent for UI sorting.
  edgeScore: number;
  // EV score per the spec formula. Not a dollar EV — a 0-100ish
  // ranker that downstream slate construction will use.
  evScore: number;
  // Whether this pick clears the per-mode eligibility bar. v0
  // implementation only flags Safe-mode eligibility; richer mode-
  // aware eligibility lands with the slate builder in Phase 4.
  qualifiesForCards: {
    safe: boolean;
    balanced: boolean;
  };
  // Why we're projecting what we are — surfaced to users so they
  // know what's driving the number, per the mission's transparency
  // principle. Each entry is human-readable.
  reasonCodes: string[];
  // Inputs we actually used vs renormalization weights (debug).
  weightsUsed: Record<string, number>;
};

// -----------------------------------------------------------------
// Formula
// -----------------------------------------------------------------

// v0 weights. Renormalized to whatever signals are present. Per spec,
// these are tuned later via calibration.
const BASE_WEIGHTS = {
  last10: 0.40,           // recent baseline — strongest single signal
  last5: 0.20,            // recent momentum
  opponent: 0.20,         // matchup history
  homeAway: 0.10,         // venue split
  season: 0.10,           // long-term anchor
} as const;

type SignalKey = keyof typeof BASE_WEIGHTS;

// Standard normal CDF approximation (Abramowitz & Stegun 26.2.17).
// Used to convert (projection − line) / stddev into a probability.
// More accurate than the previous coarse-tier approximations and
// lets the engine produce smooth probabilities across the range.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (
    0.319381530 + t * (
      -0.356563782 + t * (
        1.781477937 + t * (
          -1.821255978 + t * 1.330274429
        )
      )
    )
  );
  return z >= 0 ? 1 - p : p;
}

// Empty-input guard. Projecting on zero data should return a neutral,
// low-confidence verdict rather than NaN.
function emptyResult(
  statKey: MlbStatKey,
  line: number,
  direction: 'OVER' | 'UNDER',
): ProjectionResult {
  return {
    projection: 0,
    probability: 50,
    confidence: 0,
    riskScore: 100,
    trapScore: 80,
    trapTier: 'High Trap Risk',
    projectionDistanceScore: 0,
    edgePercent: 0,
    edgeScore: 0,
    evScore: 0,
    qualifiesForCards: { safe: false, balanced: false },
    reasonCodes: ['No game-log data available — cannot project.'],
    weightsUsed: {},
  };
}

export function computeMlbProjection(inputs: ProjectionInputs): ProjectionResult {
  const { last10, line, direction, statKey } = inputs;

  if (last10.sampleSize === 0) {
    return emptyResult(statKey, line, direction);
  }

  // ----- Renormalized weighted projection -----
  const signals: Array<{ key: SignalKey; value: number; weight: number }> = [];
  signals.push({ key: 'last10', value: last10.last10Average, weight: BASE_WEIGHTS.last10 });
  if (last10.last5Average !== null) {
    signals.push({ key: 'last5', value: last10.last5Average, weight: BASE_WEIGHTS.last5 });
  }
  if (inputs.opponentAverage !== null && inputs.opponentGames > 0) {
    // De-weight opponent if very small sample (<3 games) — it's still
    // signal but noisy. Half-weight under 3 games.
    const w = inputs.opponentGames < 3 ? BASE_WEIGHTS.opponent * 0.5 : BASE_WEIGHTS.opponent;
    signals.push({ key: 'opponent', value: inputs.opponentAverage, weight: w });
  }
  if (inputs.isHome !== null) {
    const venueAvg = inputs.isHome ? inputs.homeAverage : inputs.awayAverage;
    if (venueAvg !== null) {
      signals.push({ key: 'homeAway', value: venueAvg, weight: BASE_WEIGHTS.homeAway });
    }
  }
  if (inputs.seasonAverage !== null && inputs.seasonGames >= 5) {
    signals.push({ key: 'season', value: inputs.seasonAverage, weight: BASE_WEIGHTS.season });
  }

  const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
  const projection =
    totalWeight === 0
      ? last10.last10Average
      : signals.reduce((s, x) => s + x.value * x.weight, 0) / totalWeight;

  const weightsUsed: Record<string, number> = {};
  for (const s of signals) {
    weightsUsed[s.key] = Math.round((s.weight / totalWeight) * 100) / 100;
  }

  // ----- Probability via normal approximation -----
  // Use the L10 stddev as our variance estimate. If stddev is
  // pathologically small (e.g. all values identical), use a floor of
  // ~10% of the projection so probabilities don't snap to 0/100.
  const stddev = Math.max(last10.stddev, Math.max(0.01, Math.abs(projection) * 0.15));
  const z = (projection - line) / stddev;
  const probOver = normalCdf(z) * 100;
  const rawProbability = direction === 'OVER' ? probOver : 100 - probOver;
  // Soft cap to [5, 95]. Even with huge separation, we're not 100%
  // confident on a single game. This is the regression-to-the-mean
  // discipline the mission demands — no fake "lock" probabilities.
  const probability = clamp(rawProbability, 5, 95);

  // ----- Projection distance score (0-100) -----
  const distanceUnits = Math.abs(projection - line) / stddev;
  const projectionDistanceScore = clamp(Math.round(distanceUnits * 50), 0, 100);

  // ----- Confidence -----
  // Sample size: 0 → 0, 10 → 100 (capped). Modulated by signal
  // agreement: if opponent avg, season avg, and L10 avg all agree
  // within ~15%, bump confidence. If they wildly disagree, drop it.
  const sampleConfidence = Math.min(100, last10.sampleSize * 10);
  const agreementPenalty = computeAgreementPenalty(inputs);
  const confidence = clamp(Math.round(sampleConfidence - agreementPenalty), 0, 100);

  // ----- Risk -----
  // Take the bigger of the L10-driven volatility risk and the stat-
  // type floor. HR / SB / triples are inherently risky no matter how
  // stable the player.
  const statTypeFloor = STAT_TYPE_RISK[statKey] ?? 50;
  const riskScore = clamp(
    Math.round(Math.max(last10.riskScore, statTypeFloor * 0.6)),
    0,
    100,
  );

  // ----- Trap score -----
  const trapScore = computeTrapScore(inputs, projection);
  const trapTier = trapTierFromScore(trapScore);

  // ----- Edge -----
  const impliedBreakEven = 50;     // baseline for v0; spec evolves later
  const edgePercent = round1(probability - impliedBreakEven);
  const edgeScore = clamp(Math.round((edgePercent + 25) * 2), 0, 100);

  // ----- EV score per spec -----
  const evScore = round1(
    edgePercent * 0.40
    + confidence * 0.20
    + projectionDistanceScore * 0.20
    - riskScore * 0.10
    - trapScore * 0.10,
  );

  // ----- Eligibility for cards (v0: simple gates; richer in Phase 4) -----
  const qualifiesSafe =
    confidence >= 60 &&
    riskScore <= 60 &&
    trapScore <= 40 &&
    probability >= 60;
  const qualifiesBalanced =
    confidence >= 50 &&
    trapScore <= 60 &&
    edgePercent >= 5;

  // ----- Reason codes -----
  const reasonCodes = buildReasonCodes(inputs, {
    projection,
    probability,
    confidence,
    riskScore,
    trapScore,
    projectionDistanceScore,
    edgePercent,
  });

  return {
    projection: round2(projection),
    probability: round1(probability),
    confidence,
    riskScore,
    trapScore: Math.round(trapScore),
    trapTier,
    projectionDistanceScore,
    edgePercent,
    edgeScore,
    evScore,
    qualifiesForCards: { safe: qualifiesSafe, balanced: qualifiesBalanced },
    reasonCodes,
    weightsUsed,
  };
}

// -----------------------------------------------------------------
// Helpers (pure)
// -----------------------------------------------------------------

function computeAgreementPenalty(inputs: ProjectionInputs): number {
  // Compare L10, season, opponent (if present). Big spread → penalty.
  const baseline = inputs.last10.last10Average;
  if (baseline === 0) return 0;
  const others: number[] = [];
  if (inputs.seasonAverage !== null && inputs.seasonGames >= 10) {
    others.push(inputs.seasonAverage);
  }
  if (inputs.opponentAverage !== null && inputs.opponentGames >= 2) {
    others.push(inputs.opponentAverage);
  }
  if (others.length === 0) return 0;
  let totalDelta = 0;
  for (const o of others) {
    totalDelta += Math.abs(o - baseline) / Math.max(0.5, Math.abs(baseline));
  }
  const avgDelta = totalDelta / others.length;
  // 0.15 (15% off) → 5 point penalty; 0.40 (40% off) → 30 points.
  return clamp(Math.round((avgDelta - 0.15) * 100), 0, 30);
}

function computeTrapScore(
  inputs: ProjectionInputs,
  projection: number,
): number {
  let trap = 0;

  // Small sample
  if (inputs.last10.sampleSize < 5) trap += 25;
  else if (inputs.last10.sampleSize < 8) trap += 10;

  // Thin line margin (line basically at projection)
  const margin = Math.abs(projection - inputs.line);
  const stddev = Math.max(inputs.last10.stddev, 0.01);
  if (margin / stddev < 0.25) trap += 25;
  else if (margin / stddev < 0.5) trap += 10;

  // Volatility (CV-like)
  const meanForCv = Math.max(0.5, Math.abs(inputs.last10.last10Average));
  const cv = inputs.last10.stddev / meanForCv;
  if (cv >= 0.6) trap += 25;
  else if (cv >= 0.4) trap += 12;

  // Outlier in L5 — last5 average sharply above L10 average could
  // be one big game inflating the trend. We can't tell from averages
  // alone, but L5 ≥ 1.6× L10 is a yellow flag.
  if (inputs.last10.last5Average !== null
    && inputs.last10.last10Average > 0
    && inputs.last10.last5Average / inputs.last10.last10Average >= 1.6) {
    trap += 15;
  }

  return clamp(trap, 0, 100);
}

function trapTierFromScore(s: number): ProjectionResult['trapTier'] {
  if (s <= 20) return 'Clean';
  if (s <= 40) return 'Mild Trap Risk';
  if (s <= 60) return 'Moderate Trap Risk';
  if (s <= 80) return 'High Trap Risk';
  return 'Extreme Trap Risk';
}

function buildReasonCodes(
  inputs: ProjectionInputs,
  out: {
    projection: number;
    probability: number;
    confidence: number;
    riskScore: number;
    trapScore: number;
    projectionDistanceScore: number;
    edgePercent: number;
  },
): string[] {
  const reasons: string[] = [];

  // Sample
  if (inputs.last10.sampleSize < 5) {
    reasons.push(`Only ${inputs.last10.sampleSize} games of data — small-sample risk.`);
  } else if (inputs.last10.sampleSize >= 10) {
    reasons.push(`Strong sample size: ${inputs.last10.sampleSize} games.`);
  }

  // Trend
  if (inputs.last10.trend !== null) {
    const trend = inputs.last10.trend;
    if (Math.abs(trend) >= Math.max(0.5, inputs.last10.last10Average * 0.15)) {
      reasons.push(
        trend > 0
          ? `L5 ${inputs.last10.last5Average?.toFixed(2)} > L10 ${inputs.last10.last10Average.toFixed(2)} — momentum up.`
          : `L5 ${inputs.last10.last5Average?.toFixed(2)} < L10 ${inputs.last10.last10Average.toFixed(2)} — cooling off.`,
      );
    }
  }

  // Opponent
  if (inputs.opponentAverage !== null && inputs.opponentGames >= 2) {
    reasons.push(
      `Vs this opponent: ${inputs.opponentAverage.toFixed(2)} avg over ${inputs.opponentGames} games.`,
    );
  }

  // Venue
  if (inputs.isHome !== null) {
    const venueAvg = inputs.isHome ? inputs.homeAverage : inputs.awayAverage;
    if (venueAvg !== null) {
      reasons.push(
        `${inputs.isHome ? 'Home' : 'Away'} split: ${venueAvg.toFixed(2)} avg.`,
      );
    }
  }

  // Margin / distance
  if (out.projectionDistanceScore >= 70) {
    reasons.push(
      `Projection ${out.projection.toFixed(2)} sits ≥1σ from line ${inputs.line} — strong separation.`,
    );
  } else if (out.projectionDistanceScore < 25) {
    reasons.push(
      `Projection ${out.projection.toFixed(2)} hugs the line — thin margin, fragile pick.`,
    );
  }

  // Trap
  if (out.trapScore >= 60) {
    reasons.push('High trap exposure — interpret with caution.');
  }

  // Stat-type
  if (STAT_TYPE_RISK[inputs.statKey] >= 80) {
    reasons.push(
      `${inputs.statKey} is structurally low-event / high-variance — inherent risk.`,
    );
  }

  return reasons;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// -----------------------------------------------------------------
// DB-backed orchestrator
// -----------------------------------------------------------------

export type ProjectStatArgs = {
  playerId: number;
  statKey: MlbStatKey;
  line: number;
  direction: 'OVER' | 'UNDER';
  // Upcoming opponent (optional — drives opponent-avg signal).
  opponentTeamId?: number;
  // Whether the player will be home for the upcoming game.
  isHome?: boolean;
};

export async function projectMlbStat(
  args: ProjectStatArgs,
): Promise<ProjectionResult> {
  const playerType = playerTypeForStat(args.statKey);
  if (!playerType) {
    throw new Error(`Unknown stat key: ${args.statKey}`);
  }

  // L10 distribution. computeMlbLast10 already enforces type-restriction
  // and player-not-found.
  const last10 = await computeMlbLast10({
    playerId: args.playerId,
    statKey: args.statKey,
    line: args.line,
    direction: args.direction,
  });

  // Season + opponent + venue averages from the same game logs.
  const baselines =
    playerType === 'hitter'
      ? await loadHittingBaselines(args.playerId, args.statKey as MlbHitterStatKey, args.opponentTeamId)
      : await loadPitchingBaselines(args.playerId, args.statKey as MlbPitcherStatKey, args.opponentTeamId);

  const inputs: ProjectionInputs = {
    statKey: args.statKey,
    playerType,
    line: args.line,
    direction: args.direction,
    last10,
    seasonAverage: baselines.seasonAverage,
    seasonGames: baselines.seasonGames,
    opponentAverage: baselines.opponentAverage,
    opponentGames: baselines.opponentGames,
    homeAverage: baselines.homeAverage,
    awayAverage: baselines.awayAverage,
    isHome: args.isHome ?? null,
  };

  return computeMlbProjection(inputs);
}

// Re-export error classes so route handlers can switch on them.
export { MlbPlayerNotFoundError, MlbStatTypeMismatchError };

// ---------- Baselines ----------

type Baselines = {
  seasonAverage: number | null;
  seasonGames: number;
  opponentAverage: number | null;
  opponentGames: number;
  homeAverage: number | null;
  awayAverage: number | null;
};

async function loadHittingBaselines(
  playerId: number,
  statKey: MlbHitterStatKey,
  opponentTeamId: number | undefined,
): Promise<Baselines> {
  const { rows } = await getPool().query<{
    is_home: boolean | null;
    opponent_team_id: number | null;
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
  }>(
    `SELECT is_home, opponent_team_id,
            hits, singles, doubles, triples, home_runs, total_bases,
            runs, rbis, walks, strikeouts, stolen_bases
       FROM mlb_hitting_stats
      WHERE player_id = $1`,
    [playerId],
  );

  return reduceBaselines(rows, opponentTeamId, (r) =>
    valueFromHittingRow(statKey, r as HittingRow));
}

async function loadPitchingBaselines(
  playerId: number,
  statKey: MlbPitcherStatKey,
  opponentTeamId: number | undefined,
): Promise<Baselines> {
  const { rows } = await getPool().query<{
    is_home: boolean | null;
    opponent_team_id: number | null;
    outs_recorded: number | null;
    innings_pitched: string | null;
    pitches_thrown: number | null;
    hits_allowed: number | null;
    earned_runs_allowed: number | null;
    walks_allowed: number | null;
    strikeouts: number | null;
    home_runs_allowed: number | null;
  }>(
    `SELECT is_home, opponent_team_id,
            outs_recorded, innings_pitched, pitches_thrown, hits_allowed,
            earned_runs_allowed, walks_allowed, strikeouts, home_runs_allowed
       FROM mlb_pitching_stats
      WHERE player_id = $1`,
    [playerId],
  );

  return reduceBaselines(rows, opponentTeamId, (r) =>
    valueFromPitchingRow(statKey, r as unknown as Parameters<typeof valueFromPitchingRow>[1]));
}

function reduceBaselines<R extends { is_home: boolean | null; opponent_team_id: number | null }>(
  rows: R[],
  opponentTeamId: number | undefined,
  toValue: (r: R) => number | null,
): Baselines {
  const all: number[] = [];
  const opp: number[] = [];
  const home: number[] = [];
  const away: number[] = [];
  for (const r of rows) {
    const v = toValue(r);
    if (v === null) continue;
    all.push(v);
    if (opponentTeamId !== undefined && r.opponent_team_id === opponentTeamId) {
      opp.push(v);
    }
    if (r.is_home === true) home.push(v);
    else if (r.is_home === false) away.push(v);
  }
  return {
    seasonAverage: all.length > 0 ? avg(all) : null,
    seasonGames: all.length,
    opponentAverage: opp.length > 0 ? avg(opp) : null,
    opponentGames: opp.length,
    homeAverage: home.length > 0 ? avg(home) : null,
    awayAverage: away.length > 0 ? avg(away) : null,
  };
}

function avg(nums: number[]): number {
  let s = 0;
  for (const n of nums) s += n;
  return s / nums.length;
}
