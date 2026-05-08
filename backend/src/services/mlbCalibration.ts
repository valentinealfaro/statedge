// MLB calibration aggregator. Reads graded rows from
// mlb_projection_history and surfaces:
//
//   - Overall accuracy + sample
//   - Probability buckets (60-65%, 65-70%, etc.) with predicted vs
//     observed hit rates and Bayesian-smoothed confidence
//   - Stat-type buckets (where does the model do well? where does
//     it struggle?)
//   - Risk tier buckets
//   - Card-type buckets (Best 2/3/4/5/6 — does small-card calibration
//     differ from large-card?)
//
// Mission alignment:
//   - "Truth and accountability" — this IS the surface.
//   - Bayesian smoothing prevents overclaiming with thin data:
//     5/10 hits at 50% projects close to 50%, not 50% with bravado.
//   - Predicted - observed delta surfaced so users see WHERE the
//     model is overconfident or underconfident.

import { listMlbProjections, type StoredProjection } from './mlbProjectionHistory.js';

// Bayesian prior — the pseudo-count we assume before any data, modeling
// the expectation that a reasonable model lands ~55% on average. Same
// approach as the NBA calibration so we stay honest in low-sample
// regimes (a 1-for-1 bucket doesn't claim 100% accuracy).
const PRIOR_HITS = 11;
const PRIOR_SAMPLES = 20;     // ~55% prior

export type MlbCalibrationBucket = {
  label: string;
  // Inputs to the bucket. predictedAverage = mean of stored
  // probability values; observedHitRate = % of graded rows that hit.
  // Bayesian smoothing pulls thin samples toward the prior.
  predictedAverage: number;
  observedHitRate: number;
  smoothedHitRate: number;     // (hits + prior) / (samples + priorSamples)
  graded: number;              // hits + misses (excludes pushes)
  hits: number;
  misses: number;
  // Sample-size band so the UI can render confidence cues without
  // re-deriving them.
  sampleTier: 'thin' | 'small' | 'medium' | 'strong';
};

export type MlbCalibrationReport = {
  windowDays: number;
  totalGraded: number;
  totalHits: number;
  totalMisses: number;
  overallHitRate: number;
  smoothedHitRate: number;
  // Predicted vs observed delta (positive = model underclaimed,
  // negative = model overclaimed). Useful flag for "are we lying?"
  averagePredicted: number;
  calibrationGap: number;
  // Buckets: predicted-probability ranges, stat types, risk tiers,
  // card sizes. All driven by the same graded sample.
  byProbability: MlbCalibrationBucket[];
  byStatType: MlbCalibrationBucket[];
  byRiskTier: MlbCalibrationBucket[];
  byCardType: MlbCalibrationBucket[];
};

// Probability ranges. Boundaries chosen to align with how PrizePicks
// usually prices lines (50%-90% of model probabilities fall in 55-85%).
const PROB_BUCKETS: Array<{ label: string; lo: number; hi: number }> = [
  { label: '<50%',     lo: 0,   hi: 50  },
  { label: '50-55%',   lo: 50,  hi: 55  },
  { label: '55-60%',   lo: 55,  hi: 60  },
  { label: '60-65%',   lo: 60,  hi: 65  },
  { label: '65-70%',   lo: 65,  hi: 70  },
  { label: '70-75%',   lo: 70,  hi: 75  },
  { label: '75-80%',   lo: 75,  hi: 80  },
  { label: '80-85%',   lo: 80,  hi: 85  },
  { label: '85%+',     lo: 85,  hi: 101 },
];

function sampleTier(graded: number): MlbCalibrationBucket['sampleTier'] {
  if (graded < 10) return 'thin';
  if (graded < 30) return 'small';
  if (graded < 100) return 'medium';
  return 'strong';
}

function bucketize(
  rows: StoredProjection[],
  label: string,
): MlbCalibrationBucket {
  // Drop pushes from accuracy math (they aren't hits or misses).
  const graded = rows.filter((r) => r.hitOrMiss !== null);
  const hits = graded.filter((r) => r.hitOrMiss === true).length;
  const misses = graded.length - hits;
  const observedHitRate = graded.length === 0 ? 0 : (hits / graded.length) * 100;
  const predictedAverage =
    graded.length === 0
      ? 0
      : graded.reduce((s, r) => s + r.probability, 0) / graded.length;
  const smoothedHitRate =
    ((hits + PRIOR_HITS) / (graded.length + PRIOR_SAMPLES)) * 100;
  return {
    label,
    predictedAverage: round1(predictedAverage),
    observedHitRate: round1(observedHitRate),
    smoothedHitRate: round1(smoothedHitRate),
    graded: graded.length,
    hits,
    misses,
    sampleTier: sampleTier(graded.length),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function computeMlbCalibration(opts?: {
  windowDays?: number;
}): Promise<MlbCalibrationReport> {
  const windowDays = opts?.windowDays ?? 30;
  // Pull both graded + ungraded so totals reflect "rows in window."
  // Calibration math itself uses only graded.
  const all = await listMlbProjections({ windowDays, graded: 'all' });
  const graded = all.filter((r) => r.hitOrMiss !== null);
  const hits = graded.filter((r) => r.hitOrMiss === true).length;
  const misses = graded.length - hits;
  const overallHitRate = graded.length === 0 ? 0 : (hits / graded.length) * 100;
  const smoothedHitRate =
    ((hits + PRIOR_HITS) / (graded.length + PRIOR_SAMPLES)) * 100;
  const averagePredicted =
    graded.length === 0
      ? 0
      : graded.reduce((s, r) => s + r.probability, 0) / graded.length;
  const calibrationGap = round1(overallHitRate - averagePredicted);

  // Probability buckets
  const byProbability: MlbCalibrationBucket[] = PROB_BUCKETS.map((b) =>
    bucketize(
      graded.filter((r) => r.probability >= b.lo && r.probability < b.hi),
      b.label,
    ),
  ).filter((b) => b.graded > 0 || b.label.startsWith('60'));   // always show 60-65 anchor

  // Stat-type buckets
  const statKeys = uniq(graded.map((r) => r.selectedStat));
  const byStatType: MlbCalibrationBucket[] = statKeys
    .map((key) => bucketize(graded.filter((r) => r.selectedStat === key), key))
    .sort((a, b) => b.graded - a.graded);

  // Risk tiers — bucket by riskScore quintiles.
  const byRiskTier: MlbCalibrationBucket[] = [
    { label: 'Low risk (<30)',     filter: (r: StoredProjection) => (r.riskScore ?? 50) < 30 },
    { label: 'Moderate (30-50)',   filter: (r: StoredProjection) => (r.riskScore ?? 50) >= 30 && (r.riskScore ?? 50) < 50 },
    { label: 'Elevated (50-70)',   filter: (r: StoredProjection) => (r.riskScore ?? 50) >= 50 && (r.riskScore ?? 50) < 70 },
    { label: 'High (70+)',         filter: (r: StoredProjection) => (r.riskScore ?? 50) >= 70 },
  ].map((b) => bucketize(graded.filter(b.filter), b.label));

  // Card type
  const cardTypes = uniq(graded.map((r) => r.cardType ?? 'Unknown'));
  const byCardType: MlbCalibrationBucket[] = cardTypes
    .map((c) => bucketize(graded.filter((r) => (r.cardType ?? 'Unknown') === c), c))
    .sort((a, b) => b.graded - a.graded);

  return {
    windowDays,
    totalGraded: graded.length,
    totalHits: hits,
    totalMisses: misses,
    overallHitRate: round1(overallHitRate),
    smoothedHitRate: round1(smoothedHitRate),
    averagePredicted: round1(averagePredicted),
    calibrationGap,
    byProbability,
    byStatType,
    byRiskTier,
    byCardType,
  };
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// Pure helper exported for tests — Bayesian-smoothed hit rate.
export function smoothedHitRate(hits: number, samples: number): number {
  return ((hits + PRIOR_HITS) / (samples + PRIOR_SAMPLES)) * 100;
}
