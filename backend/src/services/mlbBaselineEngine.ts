// Layer 1 — Baseline Statistical Truth Engine.
//
// Builds the player's robust baseline projection from multiple history
// windows (season / L30 / L20 / L10 / L5) plus distribution stats
// (median, trimmed mean) so a single hot streak or one cold game can't
// tilt the baseline. Then applies Bayesian regression toward season
// (or league) average when the sample is below stat-specific
// stabilization thresholds.
//
// Pure module — no DB, no MLB API. Inputs come from the projection
// engine's existing baseline loader after that query is extended to
// return per-game values ordered by date (most-recent first).

import type { MlbStatKey } from '../mlb/stats.js';

// ----- Spec weights -----
//
// Per the MLB Intelligence Engine spec:
//   robustBaseline =
//     seasonAvg     * 0.18 +
//     last30Avg     * 0.14 +
//     last20Avg     * 0.18 +
//     last10Avg     * 0.22 +
//     last5Avg      * 0.12 +
//     median        * 0.10 +
//     trimmedMean   * 0.06
//
// When a window can't be computed (e.g. a player with only 12 logged
// games has no L30), we drop that component and renormalize the rest
// — same pattern the rest of the engine uses for missing inputs.
const ROBUST_WEIGHTS = {
  season:      0.18,
  last30:      0.14,
  last20:      0.18,
  last10:      0.22,
  last5:       0.12,
  median:      0.10,
  trimmedMean: 0.06,
} as const;

export type RobustBaselineComponents = {
  seasonAverage: number | null;
  last30Average: number | null;
  last20Average: number | null;
  last10Average: number | null;
  last5Average: number | null;
  median: number | null;
  trimmedMean: number | null;
};

export type RobustBaselineResult = {
  robust: number;                          // the blended baseline
  components: RobustBaselineComponents;    // raw inputs for transparency
  weightsUsed: Record<string, number>;     // renormalized 0..1 weights
};

// ----- Window helpers -----

// Take the first N values from an already-ordered list (most-recent
// first). Returns null when the source has fewer than the minimum
// games we'd trust for that window — small samples should fall back
// to longer windows or get dropped from the blend.
export function windowAverage(
  orderedValues: number[],
  window: number,
  minGames = Math.min(window, 3),
): number | null {
  if (orderedValues.length < minGames) return null;
  const slice = orderedValues.slice(0, window);
  if (slice.length === 0) return null;
  let sum = 0;
  for (const v of slice) sum += v;
  return sum / slice.length;
}

// ----- Distribution helpers -----

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

// Symmetric-trim mean: drop the top and bottom `trimPct` of values
// then average the rest. Default 10% (5% per tail) — protects against
// the one 4-hit blowout game inflating the player's baseline without
// throwing away the actual signal of an above-average performance.
// Falls back to plain mean when the sample is too small to trim.
export function trimmedMean(
  values: number[],
  trimPct = 0.10,
): number | null {
  if (values.length === 0) return null;
  if (values.length < 5) {
    // Too few to trim usefully — return plain mean.
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * (trimPct / 2));
  const trimmed = sorted.slice(cut, sorted.length - cut);
  let sum = 0;
  for (const v of trimmed) sum += v;
  return sum / trimmed.length;
}

// ----- Robust baseline composition -----

export function computeRobustBaseline(
  orderedValues: number[],     // most-recent first, full season
): RobustBaselineResult {
  const len = orderedValues.length;
  if (len === 0) {
    return {
      robust: 0,
      components: {
        seasonAverage: null, last30Average: null, last20Average: null,
        last10Average: null, last5Average: null, median: null, trimmedMean: null,
      },
      weightsUsed: {},
    };
  }

  // Season average is the full window. We require at least 1 game;
  // smaller windows have stricter mins.
  let seasonSum = 0;
  for (const v of orderedValues) seasonSum += v;
  const seasonAverage = seasonSum / len;

  const last30Average = windowAverage(orderedValues, 30, 15);   // need ≥15 games for "L30"
  const last20Average = windowAverage(orderedValues, 20, 10);
  const last10Average = windowAverage(orderedValues, 10, 5);
  const last5Average  = windowAverage(orderedValues,  5, 3);
  const seasonMedian  = median(orderedValues);
  const seasonTrim    = trimmedMean(orderedValues, 0.10);

  const components: RobustBaselineComponents = {
    seasonAverage,
    last30Average,
    last20Average,
    last10Average,
    last5Average,
    median: seasonMedian,
    trimmedMean: seasonTrim,
  };

  // Build the renormalized blend. Every component is independent —
  // missing ones drop out and the rest scale up.
  const parts: Array<{ key: string; value: number; weight: number }> = [];
  if (seasonAverage !== null)  parts.push({ key: 'season',      value: seasonAverage,  weight: ROBUST_WEIGHTS.season });
  if (last30Average !== null)  parts.push({ key: 'last30',      value: last30Average,  weight: ROBUST_WEIGHTS.last30 });
  if (last20Average !== null)  parts.push({ key: 'last20',      value: last20Average,  weight: ROBUST_WEIGHTS.last20 });
  if (last10Average !== null)  parts.push({ key: 'last10',      value: last10Average,  weight: ROBUST_WEIGHTS.last10 });
  if (last5Average !== null)   parts.push({ key: 'last5',       value: last5Average,   weight: ROBUST_WEIGHTS.last5 });
  if (seasonMedian !== null)   parts.push({ key: 'median',      value: seasonMedian,   weight: ROBUST_WEIGHTS.median });
  if (seasonTrim !== null)     parts.push({ key: 'trimmedMean', value: seasonTrim,     weight: ROBUST_WEIGHTS.trimmedMean });

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const robust =
    totalWeight === 0
      ? seasonAverage   // fallback — shouldn't happen given ≥1 game guarantees season
      : parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;

  const weightsUsed: Record<string, number> = {};
  for (const p of parts) {
    weightsUsed[p.key] = Math.round((p.weight / totalWeight) * 1000) / 1000;
  }

  return { robust, components, weightsUsed };
}

// ----- Stabilization thresholds -----
//
// Per the spec, sample-size thresholds at which a stat's per-PA (or
// per-batter-faced for pitchers) rate stabilizes. Until a player has
// crossed the threshold, the baseline is regressed toward an anchor
// (typically season average — or league average for rookies).
//
// Spec lists thresholds in PA/BF. We don't track PA per game cleanly
// (some legs only have AB), so we convert to "games needed" using:
//   hitter: ~4 PA/game
//   pitcher: ~25 BF/start
// This is approximate but consistent — the spec's exact PA/BF numbers
// are themselves rules of thumb, so the gameification doesn't add
// meaningful error.
const STABILIZATION_GAMES: Partial<Record<MlbStatKey, number>> = {
  hits:                 20,    // 80 PA / 4
  singles:              20,
  doubles:              30,    // higher variance → more games to stabilize
  triples:              60,    // very rare event
  home_runs:            45,    // 180 PA / 4
  total_bases:          30,    // 120 PA / 4
  runs:                 30,
  rbis:                 30,    // 120 PA / 4
  walks:                30,
  strikeouts:           20,    // hitter K
  stolen_bases:         60,    // very rare
  hits_runs_rbis:       25,
  hitter_fantasy_score: 20,
  ks:                   14,    // pitcher K — 350 BF / 25
  earned_runs_allowed:  10,    // 250 BF / 25
  walks_allowed:        12,
  pitcher_outs:         10,    // 250 BF / 25
  hits_allowed:         12,
  innings_pitched:      10,
  home_runs_allowed:    20,
  pitches_thrown:       8,
};

export function getStabilizationGames(statKey: MlbStatKey): number {
  return STABILIZATION_GAMES[statKey] ?? 25;
}

// ----- Bayesian regression -----
//
// When the player's sample size is below the stabilization threshold,
// blend the recent baseline toward an anchor. anchor should be the
// season average (or league average for rookies), but the engine
// passes whatever is most appropriate given the data it has.
//
// sampleStrength = clamp(gamesPlayed / threshold, 0, 1)
// blended        = recent * sampleStrength + anchor * (1 - sampleStrength)
//
// At gamesPlayed >= threshold, sampleStrength = 1 and the recent
// baseline is trusted entirely. At 0 games, we'd return pure anchor.

export type BayesianResult = {
  blended: number;
  sampleStrength: number;       // 0..1
  anchorWeight: number;         // 1 - sampleStrength, surfaced for transparency
};

export function applyBayesianRegression(opts: {
  recent: number;
  anchor: number;
  gamesPlayed: number;
  threshold: number;
}): BayesianResult {
  const sampleStrength = Math.max(0, Math.min(1, opts.gamesPlayed / opts.threshold));
  const blended =
    opts.recent * sampleStrength + opts.anchor * (1 - sampleStrength);
  return {
    blended,
    sampleStrength: Math.round(sampleStrength * 1000) / 1000,
    anchorWeight: Math.round((1 - sampleStrength) * 1000) / 1000,
  };
}
