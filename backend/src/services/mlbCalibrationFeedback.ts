// Layer 9 → Layer 6 feedback loop. Per the StatEdge MLB Intelligence
// Engine spec:
//
//   "Static models die. Adaptive models survive."
//   "If certain props consistently underperform, automatically:
//    reduce confidence, increase variance, increase trap weighting."
//
// This module reads the calibration report (already produced by
// mlbCalibration.ts from graded mlb_projection_history rows) and:
//
//   1. Returns a probability adjustment for any predicted probability,
//      driven by per-bucket historical actual-vs-predicted gap.
//   2. Returns a calibrationStrength score for the L10 confidence
//      composite.
//
// Cached for 5 minutes — calibration is a slow-moving signal and we
// don't want to re-query mlb_projection_history per leg in a slate.

import {
  computeMlbCalibration,
  type MlbCalibrationBucket,
  type MlbCalibrationReport,
} from './mlbCalibration.js';

// ----- Cache -----

const TTL_MS = 5 * 60 * 1000;
let cached: { report: MlbCalibrationReport; expiresAt: number } | null = null;

export async function getCalibrationFeedbackCached(): Promise<MlbCalibrationReport> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.report;
  const report = await computeMlbCalibration({ windowDays: 30 });
  cached = { report, expiresAt: now + TTL_MS };
  return report;
}

// Test-only: reset the cache between unit tests.
export function _resetCalibrationCache(): void {
  cached = null;
}

// ----- Probability adjustment -----
//
// For a predicted probability P, find the matching bucket (by
// `[lo, hi)` ranges that mirror what the calibration aggregator
// uses) and apply a Bayesian-weighted shift toward the observed
// hit rate. When the leg's statKey is known, we ALSO check the
// per-stat-type bucket and prefer its shift — per-stat is more
// surgical than per-probability when both have data.
//
// Guards:
//   - Only adjust when the bucket has ≥ MIN_BUCKET_SAMPLES graded
//     rows. Below that, we don't trust the historical hit rate
//     enough to overrule the model.
//   - Cap the adjustment to ± MAX_SHIFT percentage points so a
//     freaky bucket can't wildly distort the projection.
//   - Blend smoothed (Bayesian-prior) hit rate, not raw observed —
//     same prior the aggregator uses for its bucket display.

const MIN_BUCKET_SAMPLES = 30;
// Sample-tiered cap. Iter 2 raised from 7 → 15 after the May 2026
// calibration showed a -23.5% global gap and -68pp / -95pp / -55pp
// per-stat gaps. With 158-sample singles bucket sitting at 24%
// observed vs 88% predicted, even the 15pp cap left 49pp of bias.
//
// Iter 6 makes the cap proportional to bucket sample size, on the
// reasoning that large-sample buckets have already been Bayesian-
// smoothed and the residual signal is reliable enough to trust:
//
//   - Sample 30-99   → cap 15pp (existing — small sample, conservative)
//   - Sample 100-499 → cap 25pp (decent sample, large correction OK)
//   - Sample 500+    → cap 35pp (trust the data, close the gap)
//
// At 100 samples Bayesian smoothing pulls the observed only ~17%
// toward the 55% prior; at 500 samples only ~4%. So when the cap
// is below the observed-vs-predicted gap, the cap is the bottleneck,
// not noise. Tiering lets large-sample structural gaps close without
// risking thin-bucket overcorrection.
function maxShiftForSample(graded: number): number {
  if (graded < 100)  return 15;
  if (graded < 500)  return 25;
  return 35;
}

function findBucket(
  buckets: MlbCalibrationBucket[],
  prob: number,
): MlbCalibrationBucket | null {
  // Bucket labels follow the form '60-65%', '85%+', '<50%'. Reverse-
  // map by label since the aggregator doesn't expose the lo/hi
  // boundaries directly. Cheaper than re-deriving them.
  for (const b of buckets) {
    if (probInLabel(prob, b.label)) return b;
  }
  return null;
}

function probInLabel(prob: number, label: string): boolean {
  if (label === '<50%')  return prob < 50;
  if (label === '85%+')  return prob >= 85;
  const m = /^(\d+)-(\d+)%$/.exec(label);
  if (!m) return false;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  return prob >= lo && prob < hi;
}

export type CalibrationAdjustment = {
  adjustedProbability: number;
  shift: number;                 // +/- percentage points applied
  reason: string | null;
  bucketSample: number;
};

// Apply per-bucket adjustment. Returns the adjusted probability + a
// reason string for the projection's reasonCodes.
//
// When `statKey` is provided, we prefer the per-stat-type bucket
// over the probability-range bucket — stats with structural model
// errors (the May 2026 audit found doubles 95→0%, singles 88→20%,
// strikeouts 95→39% gaps) are best corrected with per-stat shifts
// rather than diluted into the global probability buckets.
export function applyCalibrationAdjustment(
  predictedProbability: number,
  report: MlbCalibrationReport,
  statKey?: string,
): CalibrationAdjustment {
  // Per-stat-type bucket — only when statKey is provided and the
  // bucket has enough sample. The aggregator labels stat buckets by
  // their statKey verbatim, so a direct find() is enough.
  const statBucket = statKey
    ? report.byStatType.find((b) => b.label === statKey) ?? null
    : null;
  const useStatBucket = statBucket !== null && statBucket.graded >= MIN_BUCKET_SAMPLES;

  // Probability-range bucket (existing path).
  const probBucket = findBucket(report.byProbability, predictedProbability);
  const useProbBucket = probBucket !== null && probBucket.graded >= MIN_BUCKET_SAMPLES;

  // Choose the more specific signal. Per-stat wins when available;
  // probability bucket is the fallback. Falling through both yields
  // no-op — same as before this layer existed.
  const chosen = useStatBucket ? statBucket! : useProbBucket ? probBucket! : null;
  const source: 'stat' | 'prob' | null = useStatBucket ? 'stat' : useProbBucket ? 'prob' : null;
  if (!chosen || !source) {
    // Prefer reporting the per-stat bucket sample when present (so
    // the caller sees how close we are to the 30-sample floor),
    // else the probability bucket. Mirrors the original contract.
    const reportedSample = (statBucket?.graded ?? probBucket?.graded ?? 0);
    return {
      adjustedProbability: predictedProbability,
      shift: 0,
      reason: null,
      bucketSample: reportedSample,
    };
  }

  // Bayesian-smoothed hit rate already pulls thin buckets toward the
  // ~55% prior. Use it as the target.
  const target = chosen.smoothedHitRate;
  const rawShift = target - predictedProbability;
  // Sample-tiered cap — see maxShiftForSample for the reasoning.
  // Iter 6 lets large buckets (≥100, ≥500 samples) close gaps that
  // the previous flat 15pp cap couldn't.
  const cap = maxShiftForSample(chosen.graded);
  const cappedShift = Math.max(-cap, Math.min(cap, rawShift));
  // Don't bother adjusting tiny gaps — calibration is fine there.
  if (Math.abs(cappedShift) < 1.5) {
    return {
      adjustedProbability: predictedProbability,
      shift: 0,
      reason: null,
      bucketSample: chosen.graded,
    };
  }
  const adjusted = predictedProbability + cappedShift;
  const direction = cappedShift > 0 ? 'lifted' : 'tempered';
  const sourceLabel = source === 'stat' ? `stat-type ${chosen.label}` : `bucket ${chosen.label}`;
  return {
    adjustedProbability: adjusted,
    shift: Math.round(cappedShift * 10) / 10,
    reason:
      `Calibration ${direction} ${cappedShift.toFixed(1)}pt: ` +
      `${sourceLabel} historically hits ${chosen.smoothedHitRate.toFixed(0)}% ` +
      `(${chosen.graded} graded).`,
    bucketSample: chosen.graded,
  };
}

// ----- Calibration strength score for L10 confidence -----
//
// 0..100 — how much we trust the calibration data:
//   - 0 graded rows total → 50 (neutral; no signal)
//   - sample grows toward 200 graded rows → strength rises
//   - At 200+ graded rows, strength peaks at 100 IF the overall
//     calibrationGap is small (< 3pts).
//   - When gap is large (> 8pts), strength caps at 60 — we have
//     data, but the model is misaligned.
//
// Lets L10 confidence use a real number once we have history,
// neutral 50 in the meantime.
export function computeCalibrationStrength(
  report: MlbCalibrationReport,
): number {
  const graded = report.totalGraded;
  if (graded === 0) return 50;
  // Sample-strength curve: linear to 80 at 200 graded rows.
  const sampleStrength = Math.min(80, (graded / 200) * 80);
  // Alignment bonus: how close is overall predicted vs observed?
  const gap = Math.abs(report.calibrationGap);
  let alignmentBonus: number;
  if (gap < 3)       alignmentBonus = 20;       // perfect → full bonus
  else if (gap < 5)  alignmentBonus = 12;
  else if (gap < 8)  alignmentBonus = 5;
  else               alignmentBonus = -10;       // wildly miscalibrated → penalty
  return Math.max(0, Math.min(100, Math.round(sampleStrength + alignmentBonus)));
}
