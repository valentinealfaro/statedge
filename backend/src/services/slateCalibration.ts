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

export type CalibrationBucket = {
  label: string;
  // Sample size — how many distinct (date, player, stat, line, dir)
  // legs landed in this bucket. Buckets with n < 10 should be read
  // with caution; the UI surfaces an indicator.
  sampleSize: number;
  // Average probability we predicted across legs in this bucket.
  predictedAvg: number;
  // Actual hit rate (push counts as hit, mirroring the parlay grader).
  actualHitRate: number;
  // predictedAvg − actualHitRate. Positive means we were overconfident
  // (claimed more than we delivered); negative means we under-sold.
  gap: number;
};

export type CalibrationReport = {
  overall: CalibrationBucket;
  byProbability: CalibrationBucket[];
  byStat: CalibrationBucket[];
  byConfidence: CalibrationBucket[];
  daysAnalyzed: number;
  legsAnalyzed: number;          // distinct legs after dedupe
  // First and last slate dates contributing to the report. Useful for
  // the UI to render a date range.
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
  outcome: 'hit' | 'miss' | 'push';
};

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
        const lp = leg as { probability?: number; pct?: number };
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
    return { label, sampleSize: 0, predictedAvg: 0, actualHitRate: 0, gap: 0 };
  }
  const predictedSum = legs.reduce((s, l) => s + l.probability, 0);
  const hitSum = legs.reduce((s, l) => s + outcomeAsHit(l.outcome), 0);
  const predictedAvg = predictedSum / legs.length;
  const actualHitRate = (hitSum / legs.length) * 100;
  return {
    label,
    sampleSize: legs.length,
    predictedAvg: round1(predictedAvg),
    actualHitRate: round1(actualHitRate),
    gap: round1(predictedAvg - actualHitRate),
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

  return {
    overall,
    byProbability,
    byStat,
    byConfidence,
    daysAnalyzed,
    legsAnalyzed: legs.length,
    rangeStart,
    rangeEnd,
  };
}
