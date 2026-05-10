// Tests for the L9→L6 calibration feedback module. Pure functions —
// no DB. We pass synthetic calibration reports and assert the
// adjustment + strength behavior.

import { describe, expect, test } from 'vitest';
import {
  applyCalibrationAdjustment,
  computeCalibrationStrength,
} from './mlbCalibrationFeedback.js';
import type { MlbCalibrationReport, MlbCalibrationBucket } from './mlbCalibration.js';

function bucket(over: Partial<MlbCalibrationBucket> & { label: string }): MlbCalibrationBucket {
  return {
    label: over.label,
    predictedAverage: over.predictedAverage ?? 70,
    observedHitRate: over.observedHitRate ?? 70,
    smoothedHitRate: over.smoothedHitRate ?? 70,
    graded: over.graded ?? 50,
    hits: over.hits ?? 35,
    misses: over.misses ?? 15,
    sampleTier: over.sampleTier ?? 'medium',
  };
}

function report(over: Partial<MlbCalibrationReport> = {}): MlbCalibrationReport {
  return {
    windowDays: 30,
    totalGraded: 200,
    totalHits: 110,
    totalMisses: 90,
    overallHitRate: 55,
    smoothedHitRate: 55,
    averagePredicted: 60,
    calibrationGap: -5,
    byProbability: [],
    byStatType: [],
    byRiskTier: [],
    byCardType: [],
    failureArchetypes: [],
    ...over,
  };
}

describe('applyCalibrationAdjustment — bucket matching', () => {
  test('Predicted prob inside a populated bucket → adjustment fires', () => {
    const r = report({
      byProbability: [
        bucket({
          label: '70-75%',
          predictedAverage: 72,
          smoothedHitRate: 65,            // model overclaims by 7
          graded: 80,
        }),
      ],
    });
    const adj = applyCalibrationAdjustment(72, r);
    expect(adj.shift).toBeLessThan(0);     // tempered
    expect(adj.adjustedProbability).toBeLessThan(72);
    expect(adj.reason).toMatch(/tempered/i);
  });

  test('Predicted prob outside any bucket → no adjustment', () => {
    const r = report({
      byProbability: [bucket({ label: '70-75%', graded: 50 })],
    });
    const adj = applyCalibrationAdjustment(40, r);
    expect(adj.shift).toBe(0);
  });
});

describe('applyCalibrationAdjustment — sample guards', () => {
  test('Bucket sample below threshold → no adjustment', () => {
    const r = report({
      byProbability: [
        bucket({ label: '70-75%', smoothedHitRate: 50, graded: 10 }),
      ],
    });
    const adj = applyCalibrationAdjustment(72, r);
    expect(adj.shift).toBe(0);
    expect(adj.bucketSample).toBe(10);
  });

  test('Tiny gap (< 1.5pt) → no adjustment', () => {
    const r = report({
      byProbability: [
        bucket({ label: '70-75%', smoothedHitRate: 71.5, graded: 100 }),
      ],
    });
    const adj = applyCalibrationAdjustment(72, r);
    expect(adj.shift).toBe(0);
  });

  test('Cap at ±15pts even when gap is huge (raised from 7pp after May 2026 audit)', () => {
    const r = report({
      byProbability: [
        bucket({ label: '70-75%', smoothedHitRate: 30, graded: 100 }),
      ],
    });
    const adj = applyCalibrationAdjustment(72, r);
    // Raw shift = 30 - 72 = -42, cap at -15.
    expect(adj.shift).toBe(-15);
    expect(adj.adjustedProbability).toBe(57);
  });
});

describe('applyCalibrationAdjustment — per-stat bucket preferred', () => {
  // Per the May 2026 audit, per-stat gaps were the dominant signal:
  // singles -68pp, doubles -95pp, strikeouts -55pp. The feedback layer
  // now prefers stat-type buckets over probability-range buckets when
  // both have ≥30 samples.
  test('Stat-type bucket overrides probability bucket when statKey matches', () => {
    const r = report({
      byProbability: [
        bucket({ label: '85%+', smoothedHitRate: 84, graded: 100 }),  // tight
      ],
      byStatType: [
        bucket({ label: 'singles', smoothedHitRate: 25, graded: 158 }), // huge gap
      ],
    });
    const adj = applyCalibrationAdjustment(88, r, 'singles');
    // Per-stat shift dominates: target = 25, predicted = 88 → cap -15.
    expect(adj.shift).toBe(-15);
    expect(adj.reason).toMatch(/stat-type singles/);
  });

  test('Falls back to probability bucket when stat-type lacks sample', () => {
    const r = report({
      byProbability: [
        bucket({ label: '85%+', smoothedHitRate: 70, graded: 200 }),
      ],
      byStatType: [
        bucket({ label: 'home_runs', smoothedHitRate: 50, graded: 12 }), // thin
      ],
    });
    const adj = applyCalibrationAdjustment(88, r, 'home_runs');
    // Stat bucket below 30-sample floor → falls through to prob bucket.
    expect(adj.shift).toBe(-15);   // prob bucket: target 70, predicted 88, cap -15
    expect(adj.reason).toMatch(/bucket 85%\+/);
  });

  test('No statKey → existing per-probability path unchanged', () => {
    const r = report({
      byProbability: [
        bucket({ label: '70-75%', smoothedHitRate: 65, graded: 80 }),
      ],
    });
    const adj = applyCalibrationAdjustment(72, r);
    expect(adj.shift).toBeLessThan(0);
    expect(adj.reason).toMatch(/bucket 70-75%/);
  });
});

describe('applyCalibrationAdjustment — bucket label parsing', () => {
  test('<50% bucket matches sub-50 probabilities', () => {
    const r = report({
      byProbability: [
        bucket({ label: '<50%', smoothedHitRate: 30, graded: 80 }),
      ],
    });
    const adj = applyCalibrationAdjustment(40, r);
    expect(adj.shift).toBeLessThan(0);
  });

  test('85%+ bucket matches 85+ probabilities', () => {
    const r = report({
      byProbability: [
        bucket({ label: '85%+', smoothedHitRate: 75, graded: 60 }),
      ],
    });
    const adj = applyCalibrationAdjustment(88, r);
    expect(adj.shift).toBeLessThan(0);
  });
});

describe('computeCalibrationStrength', () => {
  test('Zero data → neutral 50', () => {
    expect(computeCalibrationStrength(report({ totalGraded: 0 }))).toBe(50);
  });

  test('Tight calibration + ample sample → high score', () => {
    const score = computeCalibrationStrength(report({
      totalGraded: 250,
      calibrationGap: 1.5,
    }));
    expect(score).toBeGreaterThanOrEqual(95);
  });

  test('Wide calibration gap penalizes even with sample', () => {
    const tight = computeCalibrationStrength(report({
      totalGraded: 200,
      calibrationGap: 1,
    }));
    const wide = computeCalibrationStrength(report({
      totalGraded: 200,
      calibrationGap: 10,
    }));
    expect(wide).toBeLessThan(tight);
  });

  test('Sample grows toward 80 at 200 graded rows', () => {
    const score = computeCalibrationStrength(report({
      totalGraded: 200,
      calibrationGap: 4,
    }));
    // 80 (sample cap) + 12 (gap < 5) = 92
    expect(score).toBe(92);
  });
});
