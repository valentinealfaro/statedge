// NBA calibration feedback — Layer 9 → Layer 6 loop, parallel to
// mlbCalibrationFeedback.ts. Reads the calibration report produced
// by slateCalibration.computeCalibration (which aggregates graded
// slate_results rows) and:
//
//   1. Returns a probability adjustment for any predicted probability,
//      driven by per-bucket historical actual-vs-predicted gap. Per-stat
//      bucket preferred over per-probability bucket when both have
//      ≥30 samples.
//   2. Returns a calibrationStrength score for use in NBA confidence.
//
// Why this exists: NBA had no projection-time calibration feedback until
// now. The slateCalibration aggregator has been producing the data for
// the History page for months — the model just wasn't reading from it.
// MLB's identical-shape feedback layer demonstrably tightened MLB's
// per-stat overclaim gaps (singles 88→24, doubles 95→0). NBA's
// calibration page shows the same kind of bucket drift — wiring this in
// closes the loop the same way.
//
// Cached for 5 minutes — calibration is a slow-moving signal and we
// don't want to re-query slate_results per leg in a slate.

import { listSlateSnapshotsFromDb } from '../db.js';
import { LAST10_LABELS, type Last10StatId } from './last10.js';
import {
  computeCalibration,
  type CalibrationBucket,
  type CalibrationReport,
} from './slateCalibration.js';

// ----- Cache -----

const TTL_MS = 5 * 60 * 1000;
let cached: { report: CalibrationReport; expiresAt: number } | null = null;

export async function getNbaCalibrationFeedbackCached(): Promise<CalibrationReport> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.report;
  // 90 days mirrors the slate.ts /calibration endpoint's window.
  const rows = await listSlateSnapshotsFromDb(90);
  const report = computeCalibration(
    rows.map((r) => ({ date: r.date, results: r.results })),
  );
  cached = { report, expiresAt: now + TTL_MS };
  return report;
}

// Test-only: reset the cache between unit tests.
export function _resetNbaCalibrationCache(): void {
  cached = null;
}

// ----- Probability adjustment -----
//
// Same Bayesian-weighted shift logic MLB uses. The aggregator labels
// are different (NBA: '50-59%', '60-69%', ..., '90-100%'; MLB: '<50%',
// '70-75%', '85%+') so the bucket-finding parser is NBA-specific.

const MIN_BUCKET_SAMPLES = 30;

// Sample-tiered cap — same reasoning as MLB iter 6: at large sample
// the Bayesian-smoothed observation is reliable and the cap can lift
// without fearing thin-bucket overcorrection.
//
//   - Sample 30-99   → cap 15pp (small sample, conservative)
//   - Sample 100-499 → cap 25pp (decent sample, large correction OK)
//   - Sample 500+    → cap 35pp (trust the data, close the gap)
function maxShiftForSample(graded: number): number {
  if (graded < 100) return 15;
  if (graded < 500) return 25;
  return 35;
}

function findProbabilityBucket(
  buckets: CalibrationBucket[],
  prob: number,
): CalibrationBucket | null {
  for (const b of buckets) {
    if (probInLabel(prob, b.label)) return b;
  }
  return null;
}

function probInLabel(prob: number, label: string): boolean {
  // NBA's slateCalibration uses fixed boundaries: 50-59%, 60-69%,
  // 70-79%, 80-89%, 90-100%. Each bucket aggregates `[min, max)` so
  // 60% lands in 60-69%, 70% lands in 70-79%, etc. 100% lands in
  // 90-100% (the last bucket's `max` is 101 in the aggregator).
  const m = /^(\d+)-(\d+)%$/.exec(label);
  if (!m) return false;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  // The 90-100% bucket needs to include 100; aggregator's max is 101
  // for that range so use hi+1 only on the last bucket. We can detect
  // that simply by checking hi === 100.
  const upper = hi === 100 ? 101 : hi + 1;
  return prob >= lo && prob < upper;
}

// Per-stat bucket lookup. The aggregator labels stat buckets via
// LAST10_LABELS (e.g. statKey 'points' → label 'Points'). Map back
// from statKey to label, then exact-match.
function findStatBucket(
  buckets: CalibrationBucket[],
  statKey: Last10StatId,
): CalibrationBucket | null {
  const label = LAST10_LABELS[statKey] ?? String(statKey);
  return buckets.find((b) => b.label === label) ?? null;
}

export type NbaCalibrationAdjustment = {
  adjustedProbability: number;
  shift: number;                 // +/- percentage points applied
  reason: string | null;
  bucketSample: number;
};

// Apply per-bucket adjustment. Returns the adjusted probability + a
// reason string for the projection's modelNotes. When `statKey` is
// provided, prefers the per-stat-type bucket over the probability-range
// bucket — same precedence MLB uses.
export function applyNbaCalibrationAdjustment(
  predictedProbability: number,
  report: CalibrationReport,
  statKey?: Last10StatId,
): NbaCalibrationAdjustment {
  const statBucket = statKey
    ? findStatBucket(report.byStat, statKey)
    : null;
  const useStatBucket = statBucket !== null && statBucket.sampleSize >= MIN_BUCKET_SAMPLES;

  const probBucket = findProbabilityBucket(report.byProbability, predictedProbability);
  const useProbBucket = probBucket !== null && probBucket.sampleSize >= MIN_BUCKET_SAMPLES;

  const chosen = useStatBucket ? statBucket! : useProbBucket ? probBucket! : null;
  const source: 'stat' | 'prob' | null = useStatBucket ? 'stat' : useProbBucket ? 'prob' : null;
  if (!chosen || !source) {
    const reportedSample = (statBucket?.sampleSize ?? probBucket?.sampleSize ?? 0);
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
  const cap = maxShiftForSample(chosen.sampleSize);
  const cappedShift = Math.max(-cap, Math.min(cap, rawShift));
  // Don't bother adjusting tiny gaps — calibration is fine there.
  if (Math.abs(cappedShift) < 1.5) {
    return {
      adjustedProbability: predictedProbability,
      shift: 0,
      reason: null,
      bucketSample: chosen.sampleSize,
    };
  }
  const adjusted = predictedProbability + cappedShift;
  const direction = cappedShift > 0 ? 'lifted' : 'tempered';
  const sourceLabel = source === 'stat' ? `stat ${chosen.label}` : `bucket ${chosen.label}`;
  return {
    adjustedProbability: adjusted,
    shift: Math.round(cappedShift * 10) / 10,
    reason:
      `Calibration ${direction} ${cappedShift.toFixed(1)}pt: ` +
      `${sourceLabel} historically hits ${chosen.smoothedHitRate.toFixed(0)}% ` +
      `(${chosen.sampleSize} graded).`,
    bucketSample: chosen.sampleSize,
  };
}

// ----- Calibration strength score -----
//
// 0..100 — how much we trust the calibration data:
//   - 0 graded legs total → 50 (neutral; no signal)
//   - sample grows toward 200 graded legs → strength rises
//   - At 200+ graded legs, strength peaks at 100 IF the overall
//     calibrationError is small (< 3pts).
//   - When error is large (> 8pts), strength drops — we have data,
//     but the model is misaligned.
export function computeNbaCalibrationStrength(
  report: CalibrationReport,
): number {
  const graded = report.legsAnalyzed;
  if (graded === 0) return 50;
  const sampleStrength = Math.min(80, (graded / 200) * 80);
  const error = Math.abs(report.overall.calibrationError);
  let alignmentBonus: number;
  if (error < 3) alignmentBonus = 20;
  else if (error < 5) alignmentBonus = 12;
  else if (error < 8) alignmentBonus = 5;
  else alignmentBonus = -10;
  return Math.max(0, Math.min(100, Math.round(sampleStrength + alignmentBonus)));
}
