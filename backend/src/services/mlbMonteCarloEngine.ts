// MLB Monte Carlo simulation engine — v0.
//
// Per the StatEdge mission's "Quantitative Intelligence" section:
// "10k+ draws per projection, percentile bands (P10/P50/P90)."
//
// What v0 does:
//   - Takes a point projection + stddev estimate + stat type
//   - Generates 10,000 draws from a stat-type-aware distribution
//   - Returns P10/P25/P50/P75/P90 + estimated probability over/under line
//
// What v0 does NOT do (deferred):
//   - Possession-level / plate-appearance-level simulation. This v0
//     models the FINAL stat outcome distribution, not the per-event
//     dynamics that produce it.
//   - Joint cross-leg simulation (one player's HR doesn't affect
//     another's). That belongs in slate-level Monte Carlo.
//   - Bayesian posterior updates. The mean + stddev come from the
//     existing engine; MC just samples them.
//
// Distribution choice per stat type:
//   - Low-event integer stats (hits, runs, RBI, walks, K hitter):
//     Normal. Discretized at sample time (rounded to nearest integer)
//     since you can't get 1.4 hits.
//   - Skewed positive integer stats (HR, total_bases, doubles, triples,
//     stolen_bases): Half-normal-style — clamp draws at zero, fatter
//     right tail. These stats are zero-inflated in real life (Aaron
//     Judge has a ton of zero-HR games even at his elite rate).
//   - Continuous pitcher stats (innings_pitched, pitches_thrown):
//     Normal but clamped at 0 below.
//   - Pitcher counting stats (ks, hits_allowed, ER, walks_allowed):
//     Normal, discretized.
//
// The model probability returned by the projection engine uses normal-
// CDF math which already aligns with these distributions for most
// stats. MC v0 mostly serves to expose the FLOOR/CEILING for users —
// "Aaron Judge HR projection 1.7 with P10=0.0 / P90=4.0" is more
// informative than just "1.7 with 65% probability."

import type { MlbStatKey } from '../mlb/stats.js';

const DRAWS = 10_000;

// Box-Muller transform for normal-distribution draws. Uses
// Math.random() — fine for v0; if we ever need cross-process
// reproducibility we can swap in seedrandom + a fixed seed.
function normalSample(mean: number, stddev: number): number {
  // Two uniforms in (0,1].
  const u1 = 1 - Math.random();
  const u2 = 1 - Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

// Poisson sampler (Knuth's algorithm — exact for small λ, which is
// what we need for rare-event MLB stats: HR ≈ 0.4/game, SB ≈ 0.1,
// triples ≈ 0.05). For the projections we deal with (λ < 30 always)
// the loop terminates in a handful of iterations on average.
//
// Per the MLB Intelligence Engine spec L6: "Use skew-aware
// distributions for HRs and SBs" — Poisson is the textbook choice
// for count-of-rare-events outcomes. Replaces the v0 normal-rounded
// approximation, which produced symmetric distributions where the
// real world is right-skewed (long upper tail, hard floor at 0).
function poissonSample(lambda: number): number {
  if (lambda <= 0) return 0;
  // Knuth's algorithm. Numerically stable for λ < ~30 (everything
  // we'd ever project for a single MLB game).
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  // Cap iterations defensively — astronomically unlikely to need more.
  for (let i = 0; i < 1000; i++) {
    k += 1;
    p *= Math.random();
    if (p <= L) break;
  }
  return k - 1;
}

// Stat type categorization for distribution choice. Kept private to
// this module — the projection engine doesn't need to know.
type DistShape =
  | 'integer_normal'        // hits, runs, RBI, K (hitter), pitcher K, etc.
  | 'poisson'               // HR, triples, SB, home_runs_allowed (rare events)
  | 'integer_zero_inflated' // doubles, total_bases (semi-rare, asymmetric)
  | 'continuous_normal';     // innings_pitched, pitches_thrown

function shapeFor(key: MlbStatKey): DistShape {
  switch (key) {
    // True rare events — Poisson is the textbook fit. Mean λ < 0.5
    // for a single game in real-world MLB.
    case 'home_runs':
    case 'triples':
    case 'stolen_bases':
    case 'home_runs_allowed':
      return 'poisson';
    // Semi-rare integer stats with more spread — kept on the
    // zero-inflated normal until we calibrate Poisson against them.
    case 'doubles':
      return 'integer_zero_inflated';
    case 'innings_pitched':
    case 'pitches_thrown':
      return 'continuous_normal';
    default:
      return 'integer_normal';
  }
}

function clampZero(n: number): number {
  return n < 0 ? 0 : n;
}

// Draw a single value from the chosen distribution.
function drawValue(shape: DistShape, mean: number, stddev: number): number {
  if (shape === 'poisson') {
    // Poisson uses the projection as λ directly — stddev is implied
    // by λ (var = λ for Poisson). Right-skewed by construction:
    // hard zero floor + long upper tail, exactly what HR/SB need.
    return poissonSample(Math.max(0, mean));
  }
  if (shape === 'continuous_normal') {
    return clampZero(normalSample(mean, stddev));
  }
  if (shape === 'integer_zero_inflated') {
    // Half-normal-style fallback for stats we haven't migrated to
    // Poisson yet (doubles): clamp at 0, round to int.
    return Math.max(0, Math.round(normalSample(mean, stddev)));
  }
  // integer_normal: standard normal, rounded to non-negative integer.
  return Math.max(0, Math.round(normalSample(mean, stddev)));
}

export type MonteCarloPercentiles = {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
};

export type MonteCarloResult = {
  draws: number;
  percentiles: MonteCarloPercentiles;
  mean: number;
  // Probability the line is hit in the chosen direction, derived from
  // the simulated distribution. May differ slightly from the engine's
  // normal-CDF probability — useful sanity check.
  simulatedProbability: number;
  // Identifies whether this pick has meaningful upside (P90 well
  // above line) vs realistic floor (P10 also above line). The mission
  // wants users to see floor/ceiling shape, not just a point estimate.
  ceilingTier: 'high' | 'medium' | 'low';
  floorTier: 'high' | 'medium' | 'low';
};

function percentile(sorted: number[], p: number): number {
  // Linear-interpolated percentile. sorted assumed ascending.
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

// Run the Monte Carlo simulation for a single leg.
//
// Inputs:
//   projection — point estimate from the deterministic engine
//   stddev     — the engine's blended stddev (or L10 stddev as
//                fallback). When undefined / zero, MC returns a
//                degenerate distribution (P10 == P50 == P90 ==
//                projection) to honor the mission's "no fake
//                completeness" rule rather than fabricating spread.
export function runMlbMonteCarlo(opts: {
  statKey: MlbStatKey;
  projection: number;
  stddev: number;
  line: number;
  direction: 'OVER' | 'UNDER';
}): MonteCarloResult {
  const shape = shapeFor(opts.statKey);
  // Degenerate distribution guard. If stddev is zero (e.g. all L10
  // values identical) we return point estimates for all percentiles.
  if (!Number.isFinite(opts.stddev) || opts.stddev <= 0) {
    return {
      draws: 0,
      percentiles: {
        p10: opts.projection, p25: opts.projection, p50: opts.projection,
        p75: opts.projection, p90: opts.projection,
      },
      mean: opts.projection,
      simulatedProbability: opts.projection > opts.line
        ? (opts.direction === 'OVER' ? 100 : 0)
        : opts.projection < opts.line
          ? (opts.direction === 'UNDER' ? 100 : 0)
          : 50,
      ceilingTier: 'low',
      floorTier: 'low',
    };
  }

  const samples: number[] = new Array(DRAWS);
  let sum = 0;
  let hits = 0;
  for (let i = 0; i < DRAWS; i++) {
    const v = drawValue(shape, opts.projection, opts.stddev);
    samples[i] = v;
    sum += v;
    // Direction-aware hit count. Push lines (v === line) excluded
    // from hits — same rule as the grader.
    if (opts.direction === 'OVER' && v > opts.line) hits += 1;
    else if (opts.direction === 'UNDER' && v < opts.line) hits += 1;
  }
  samples.sort((a, b) => a - b);
  const p10 = percentile(samples, 0.10);
  const p25 = percentile(samples, 0.25);
  const p50 = percentile(samples, 0.50);
  const p75 = percentile(samples, 0.75);
  const p90 = percentile(samples, 0.90);
  const mean = sum / DRAWS;
  const simulatedProbability = (hits / DRAWS) * 100;

  // Ceiling tier: how far P90 sits above the line as a fraction of
  // the line itself. Drives a "high upside / moderate / low" label
  // on the UI.
  const ceilingDelta = p90 - opts.line;
  const ceilingPctOfLine = opts.line === 0 ? Math.abs(ceilingDelta) : ceilingDelta / Math.abs(opts.line);
  const ceilingTier: 'high' | 'medium' | 'low' =
    ceilingPctOfLine >= 1.0 ? 'high'
    : ceilingPctOfLine >= 0.4 ? 'medium'
    : 'low';

  // Floor tier: how P10 sits relative to the line. For OVER picks,
  // a P10 above the line means even the bad-luck case clears it.
  // For UNDER picks, a P10 below the line is "high floor."
  const floorAboveLine = p10 - opts.line;
  const floorRatio = opts.line === 0 ? Math.abs(floorAboveLine) : floorAboveLine / Math.abs(opts.line);
  let floorTier: 'high' | 'medium' | 'low';
  if (opts.direction === 'OVER') {
    floorTier = floorRatio >= 0.2 ? 'high' : floorRatio >= -0.1 ? 'medium' : 'low';
  } else {
    // UNDER: floor is high when P10 is well BELOW line.
    floorTier = -floorRatio >= 0.2 ? 'high' : -floorRatio >= -0.1 ? 'medium' : 'low';
  }

  return {
    draws: DRAWS,
    percentiles: {
      p10: round2(p10),
      p25: round2(p25),
      p50: round2(p50),
      p75: round2(p75),
      p90: round2(p90),
    },
    mean: round2(mean),
    simulatedProbability: round1(simulatedProbability),
    ceilingTier,
    floorTier,
  };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

// Pure helpers exposed for tests.
export const _internal = { normalSample, percentile, shapeFor, poissonSample };
