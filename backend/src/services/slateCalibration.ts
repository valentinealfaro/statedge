// Calibration analysis — reads graded snapshots from slate_results
// and reports how well the model's predicted hit % matches the actual
// hit rate, broken down by probability bucket, stat, and confidence
// tier. The data is exactly what the History tab grades into the
// `results` JSONB column, so this service just aggregates without
// fetching any new state.
//
// Why this matters: if the model says "72%" but historical 70-79%
// picks only hit 63%, the projection is overconfident. Calibration
// is the truth-telling mirror that turns predicted probabilities into
// honest ones, and it's the foundation for any future ML feedback
// loop. Per the platform vision, we're tracking long-term predictive
// integrity, not flashy headline numbers.

import type { Last10StatId } from './last10.js';
import type { GradedCombo, GradedLeg } from './slateGrade.js';
import { LAST10_LABELS } from './last10.js';

// Sample-size confidence tier (spec §"Sample Size Confidence"). Tells
// the UI whether a bucket's calibration number is statistically
// meaningful or experimental noise.
export type SampleConfidence =
  | 'Experimental'        // 0-24 samples
  | 'Low Confidence'      // 25-99
  | 'Stabilizing'         // 100-499
  | 'Strong'              // 500-1999
  | 'Highly Stable';      // 2000+

// Calibration status label (spec §"Calibration Status Labels" +
// "Overconfidence Labels"). Combines magnitude of error with sign:
// positive = overconfident, negative = underconfident.
export type CalibrationStatus =
  | 'Excellent Calibration'        // ±0-3
  | 'Good Calibration'             // ±4-7
  | 'Moderate Drift'               // ±8-12
  | 'Poor Calibration'             // ±13-20
  | 'Dangerously Overconfident'    // > 20 (positive only)
  | 'Underconfident';              // ≤ -8 (model under-sold)

export type CalibrationBucket = {
  label: string;
  // Sample size — how many distinct (date, player, stat, line, dir)
  // legs landed in this bucket.
  sampleSize: number;
  sampleConfidence: SampleConfidence;
  // Average probability we predicted across legs in this bucket.
  predictedAvg: number;
  // Raw actual hit rate (push counts as hit, mirroring the parlay
  // grader). Useful for honesty but unstable on tiny samples.
  actualHitRate: number;
  // Bayesian-smoothed actual hit rate (spec §"Bayesian Calibration
  // Smoothing"). Default prior: 11 hits over 20 samples (≈55%).
  // Pulls 0/1 → 52.4% and 1/1 → 57.1% rather than the 0%/100%
  // raw values that crash a calibration view. This is the figure
  // we use for the gap calculation and the status label.
  smoothedHitRate: number;
  // predictedAvg − smoothedHitRate. Positive = overconfident,
  // negative = underconfident. Renamed from `gap` per spec.
  calibrationError: number;
  // Backward-compat alias; some old frontends still read `gap`.
  gap: number;
  status: CalibrationStatus;
};

// Projection-error summary (spec §"Projection Error Distribution"):
// per-leg miss = actual − projected. Surfaces whether the model
// systematically over- or under-projects, separate from whether it's
// well-calibrated on hit %.
export type ProjectionErrorSummary = {
  // How many legs had both an actual and a projected value (DD legs
  // and legacy snapshots without `projection` are excluded).
  sampleSize: number;
  // Average signed miss (actual − projected). Positive = we
  // under-projected; negative = we over-projected.
  meanMiss: number;
  medianMiss: number;
  // Average |actual − projected| — pure accuracy, ignoring direction.
  meanAbsoluteMiss: number;
  // Bias breakdown: % of legs where we under- vs over-projected.
  // Sums (with the "exact" rate) to 100. Useful for spotting
  // systematic skew the meanMiss might smooth over.
  underProjectionRate: number;     // actual > projected
  overProjectionRate: number;      // actual < projected
};

export type CalibrationReport = {
  overall: CalibrationBucket;
  byProbability: CalibrationBucket[];
  byStat: CalibrationBucket[];
  byConfidence: CalibrationBucket[];
  // Risk-tier calibration (spec §"Risk Tier Calibration") — verifies
  // the risk engine is actually predicting risk. Picks tagged "High
  // Risk" should hit less often than "Low Risk" picks.
  byRisk: CalibrationBucket[];
  // Volatility-archetype calibration (spec §"Volatility Archetype
  // Accuracy") — surfaces which archetypes break the model. Boom/Bust
  // legs missing isn't the same kind of miss as Stable Producers.
  byArchetype: CalibrationBucket[];
  // Projection-error distribution. Null when the dataset has no legs
  // carrying a projected stat value (very early days / legacy only).
  projectionError: ProjectionErrorSummary | null;
  daysAnalyzed: number;
  legsAnalyzed: number;          // distinct legs after dedupe
  rangeStart: string | null;
  rangeEnd: string | null;
};

// Snapshot row shape we read from. Loose typing because the JSONB is
// untyped at the DB layer; we narrow at the boundary here.
export type CalibrationInput = {
  date: string;                  // YYYY-MM-DD
  results: unknown;              // GradedCombo[] | null
};

const PROBABILITY_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '50-59%', min: 50, max: 60 },
  { label: '60-69%', min: 60, max: 70 },
  { label: '70-79%', min: 70, max: 80 },
  { label: '80-89%', min: 80, max: 90 },
  { label: '90-100%', min: 90, max: 101 },
];

const CONFIDENCE_TIERS = ['Elite', 'Strong', 'Medium', 'Low'] as const;

type DedupedLeg = {
  probability: number;
  statKey: Last10StatId;
  confidenceLabel: string | null;
  riskScore: number | null;        // 0-100; null when missing on legacy snapshots
  // Projected stat value at lock time. Only present on snapshots
  // written after the projection-echo change; null on legacy.
  projection: number | null;
  // Actual stat value at game end. Already on GradedLeg via the
  // grader's stat lookup; needed here for projection-error math.
  // double_double legs return 0/1 — we exclude those from projection
  // error since the "line" doesn't have meaningful units there.
  actual: number | null;
  archetype: string | null;        // volatility archetype label, or null
  outcome: 'hit' | 'miss' | 'push';
};

// Bayesian smoothing prior (spec §"Prior Settings"). 11 hits over 20
// samples encodes a baseline expectation of ~55% — close to the
// long-run hit rate of NBA props at typical PrizePicks lines. With
// these priors:
//   - 0/1 hits  → smoothed 11/21 = 52.4%
//   - 1/1 hits  → smoothed 12/21 = 57.1%
//   - 30/50 hits→ smoothed 41/70 = 58.6%
//   - 300/500   → smoothed 311/520 = 59.8% (prior fading)
const PRIOR_HITS = 11;
const PRIOR_SAMPLES = 20;

function sampleConfidence(n: number): SampleConfidence {
  if (n >= 2000) return 'Highly Stable';
  if (n >= 500) return 'Strong';
  if (n >= 100) return 'Stabilizing';
  if (n >= 25) return 'Low Confidence';
  return 'Experimental';
}

// Map a calibration error (predicted − actual smoothed) to a status
// label. Magnitude bands match the spec; sign decides over- vs
// under-confidence.
function calibrationStatus(error: number): CalibrationStatus {
  const abs = Math.abs(error);
  if (error > 20) return 'Dangerously Overconfident';
  if (error <= -8) return 'Underconfident';
  if (abs <= 3) return 'Excellent Calibration';
  if (abs <= 7) return 'Good Calibration';
  if (abs <= 12) return 'Moderate Drift';
  return 'Poor Calibration';
}

// Risk-tier bucketing matches the projection engine's risk-score
// labels. Ranges chosen to align with the spec's tier ladder.
function riskTier(score: number): 'Low Risk' | 'Medium Risk' | 'High Risk' | 'Extreme Risk' {
  if (score < 40) return 'Low Risk';
  if (score < 60) return 'Medium Risk';
  if (score < 80) return 'High Risk';
  return 'Extreme Risk';
}
const RISK_TIERS = ['Low Risk', 'Medium Risk', 'High Risk', 'Extreme Risk'] as const;

// Outcome → 0/1 for hit-rate accumulation. Push counts as 1 to mirror
// the parlay grader's "survival" semantics. no_game / unknown_stat
// legs are filtered out before reaching this function.
function outcomeAsHit(o: DedupedLeg['outcome']): number {
  return o === 'miss' ? 0 : 1;
}

// Walk all snapshots, extract legs that have a final outcome (hit /
// miss / push), and dedupe across cards within the same day. The
// same pick on Best 6 and Best 5 is the same prediction with the
// same outcome — counting twice would inflate the sample.
function collectDedupedLegs(snapshots: CalibrationInput[]): {
  legs: DedupedLeg[];
  daysAnalyzed: number;
  rangeStart: string | null;
  rangeEnd: string | null;
} {
  const legs: DedupedLeg[] = [];
  const days = new Set<string>();
  let rangeStart: string | null = null;
  let rangeEnd: string | null = null;

  for (const snap of snapshots) {
    const combos = snap.results as GradedCombo[] | null;
    if (!combos || !Array.isArray(combos)) continue;
    if (combos.every((c) => c.legs.length === 0)) continue;

    days.add(snap.date);
    if (!rangeStart || snap.date < rangeStart) rangeStart = snap.date;
    if (!rangeEnd || snap.date > rangeEnd) rangeEnd = snap.date;

    // Dedup within the day on (player, stat, line, direction). Old
    // snapshots (pre-rewrite) stored `pct` instead of `probability`;
    // we accept either so the calibration view works across schema
    // generations. Without this, undefined values cascade to NaN and
    // eventually serialize as null in the JSON response, crashing
    // the frontend on .toFixed().
    const seen = new Set<string>();
    for (const combo of combos) {
      for (const leg of combo.legs as GradedLeg[]) {
        if (
          leg.outcome !== 'hit' &&
          leg.outcome !== 'miss' &&
          leg.outcome !== 'push'
        ) continue;
        const lp = leg as {
          probability?: number; pct?: number; risk?: number;
          projection?: number; archetype?: string;
        };
        const probability =
          typeof lp.probability === 'number' ? lp.probability
          : typeof lp.pct === 'number' ? lp.pct
          : null;
        if (probability === null || !Number.isFinite(probability)) continue;

        const key = `${leg.playerId}-${leg.statKey}-${leg.line}-${leg.direction}`;
        if (seen.has(key)) continue;
        seen.add(key);

        legs.push({
          probability,
          statKey: leg.statKey,
          confidenceLabel: leg.confidenceLabel ?? null,
          riskScore:
            typeof lp.risk === 'number' && Number.isFinite(lp.risk) ? lp.risk : null,
          projection:
            typeof lp.projection === 'number' && Number.isFinite(lp.projection)
              ? lp.projection
              : null,
          actual:
            typeof leg.actual === 'number' && Number.isFinite(leg.actual)
              ? leg.actual
              : null,
          archetype:
            typeof lp.archetype === 'string' && lp.archetype.length > 0
              ? lp.archetype
              : null,
          outcome: leg.outcome,
        });
      }
    }
  }

  return {
    legs,
    daysAnalyzed: days.size,
    rangeStart,
    rangeEnd,
  };
}

function aggregateBucket(label: string, legs: DedupedLeg[]): CalibrationBucket {
  if (legs.length === 0) {
    // Empty bucket — render an honest zero rather than NaN. Status is
    // "Excellent" by default so empty rows don't paint everything red.
    return {
      label,
      sampleSize: 0,
      sampleConfidence: sampleConfidence(0),
      predictedAvg: 0,
      actualHitRate: 0,
      smoothedHitRate: 0,
      calibrationError: 0,
      gap: 0,
      status: 'Excellent Calibration',
    };
  }
  const predictedSum = legs.reduce((s, l) => s + l.probability, 0);
  const hitSum = legs.reduce((s, l) => s + outcomeAsHit(l.outcome), 0);
  const predictedAvg = predictedSum / legs.length;
  const actualHitRate = (hitSum / legs.length) * 100;
  // Bayesian-smoothed hit rate — pulls tiny samples toward the prior
  // (≈55%) so 0/1 ≠ 0% and 1/1 ≠ 100%. As `legs.length` grows, the
  // prior fades and smoothed → raw.
  const smoothedHitRate =
    ((hitSum + PRIOR_HITS) / (legs.length + PRIOR_SAMPLES)) * 100;
  const calibrationError = predictedAvg - smoothedHitRate;
  return {
    label,
    sampleSize: legs.length,
    sampleConfidence: sampleConfidence(legs.length),
    predictedAvg: round1(predictedAvg),
    actualHitRate: round1(actualHitRate),
    smoothedHitRate: round1(smoothedHitRate),
    calibrationError: round1(calibrationError),
    gap: round1(calibrationError),     // legacy alias
    status: calibrationStatus(calibrationError),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeCalibration(snapshots: CalibrationInput[]): CalibrationReport {
  const { legs, daysAnalyzed, rangeStart, rangeEnd } = collectDedupedLegs(snapshots);

  const overall = aggregateBucket('Overall', legs);

  // Probability buckets — fixed boundaries so the UI is stable across
  // sample-size growth.
  const byProbability = PROBABILITY_BUCKETS.map((b) =>
    aggregateBucket(
      b.label,
      legs.filter((l) => l.probability >= b.min && l.probability < b.max),
    ),
  );

  // Stat buckets — one row per stat that has data, sorted by sample
  // size descending so the most-tested stats float to the top.
  const statGroups = new Map<Last10StatId, DedupedLeg[]>();
  for (const l of legs) {
    const arr = statGroups.get(l.statKey) ?? [];
    arr.push(l);
    statGroups.set(l.statKey, arr);
  }
  const byStat = Array.from(statGroups.entries())
    .map(([key, arr]) => aggregateBucket(LAST10_LABELS[key] ?? String(key), arr))
    .sort((a, b) => b.sampleSize - a.sampleSize);

  // Confidence tiers — only the four canonical labels. Legacy legs
  // without a label are bucketed under "Unknown" so we don't drop them.
  const byConfidence = CONFIDENCE_TIERS.map((tier) =>
    aggregateBucket(tier, legs.filter((l) => l.confidenceLabel === tier)),
  );
  const unknown = legs.filter((l) =>
    !l.confidenceLabel || !CONFIDENCE_TIERS.includes(l.confidenceLabel as (typeof CONFIDENCE_TIERS)[number]),
  );
  if (unknown.length > 0) {
    byConfidence.push(aggregateBucket('Unknown', unknown));
  }

  // Risk tiers — only legs that carry a risk score (newer snapshots).
  // Legacy snapshots without risk get nothing here, which is fine —
  // the panel only renders rows with samples.
  const byRisk = RISK_TIERS.map((tier) =>
    aggregateBucket(
      tier,
      legs.filter((l) => l.riskScore !== null && riskTier(l.riskScore) === tier),
    ),
  );

  // Volatility archetype — answers "which archetypes break the
  // model?" (spec §"Volatility Archetype Accuracy"). One row per
  // archetype that has data; archetype-less legs (legacy, or DD with
  // 'Insufficient Data') get bucketed into "Unknown" if they exist.
  const archetypeGroups = new Map<string, DedupedLeg[]>();
  for (const l of legs) {
    if (!l.archetype) continue;
    const arr = archetypeGroups.get(l.archetype) ?? [];
    arr.push(l);
    archetypeGroups.set(l.archetype, arr);
  }
  const byArchetype = Array.from(archetypeGroups.entries())
    .map(([key, arr]) => aggregateBucket(key, arr))
    .sort((a, b) => b.sampleSize - a.sampleSize);

  // Projection-error distribution — drops DD (binary, no meaningful
  // unit gap) and any leg without both a projection and an actual.
  const projErrorLegs = legs.filter(
    (l) =>
      l.statKey !== 'double_double'
      && l.projection !== null
      && l.actual !== null,
  );
  const projectionError = computeProjectionError(projErrorLegs);

  return {
    overall,
    byProbability,
    byStat,
    byConfidence,
    byRisk,
    byArchetype,
    projectionError,
    daysAnalyzed,
    legsAnalyzed: legs.length,
    rangeStart,
    rangeEnd,
  };
}

function computeProjectionError(
  legs: DedupedLeg[],
): ProjectionErrorSummary | null {
  if (legs.length === 0) return null;
  const misses: number[] = [];
  for (const l of legs) {
    if (l.projection === null || l.actual === null) continue;
    misses.push(l.actual - l.projection);
  }
  if (misses.length === 0) return null;
  const meanMiss = misses.reduce((a, b) => a + b, 0) / misses.length;
  const meanAbsoluteMiss =
    misses.reduce((a, b) => a + Math.abs(b), 0) / misses.length;
  // Median: sort + middle.
  const sorted = [...misses].sort((a, b) => a - b);
  const m = sorted.length;
  const medianMiss =
    m % 2 === 1 ? sorted[(m - 1) / 2] : (sorted[m / 2 - 1] + sorted[m / 2]) / 2;
  const underCount = misses.filter((x) => x > 0).length;     // actual > projected
  const overCount = misses.filter((x) => x < 0).length;      // actual < projected
  return {
    sampleSize: misses.length,
    meanMiss: round1(meanMiss),
    medianMiss: round1(medianMiss),
    meanAbsoluteMiss: round1(meanAbsoluteMiss),
    underProjectionRate: round1((underCount / misses.length) * 100),
    overProjectionRate: round1((overCount / misses.length) * 100),
  };
}
