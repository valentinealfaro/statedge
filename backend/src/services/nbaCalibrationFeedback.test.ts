// Tests for the NBA L9→L6 calibration feedback module. Pure functions
// — no DB. We pass synthetic CalibrationReports and assert the
// adjustment + strength behavior. Mirrors mlbCalibrationFeedback.test.ts
// so future tweaks can compare across sports easily.

import { describe, expect, test } from 'vitest';
import {
  applyNbaCalibrationAdjustment,
  computeNbaCalibrationStrength,
} from './nbaCalibrationFeedback.js';
import type {
  CalibrationBucket,
  CalibrationReport,
} from './slateCalibration.js';

function bucket(over: Partial<CalibrationBucket> & { label: string }): CalibrationBucket {
  return {
    label: over.label,
    sampleSize: over.sampleSize ?? 50,
    sampleConfidence: over.sampleConfidence ?? 'Low Confidence',
    predictedAvg: over.predictedAvg ?? 70,
    actualHitRate: over.actualHitRate ?? 70,
    smoothedHitRate: over.smoothedHitRate ?? 70,
    calibrationError: over.calibrationError ?? 0,
    gap: over.gap ?? 0,
    status: over.status ?? 'Excellent Calibration',
  };
}

function report(over: Partial<CalibrationReport> = {}): CalibrationReport {
  return {
    overall: bucket({ label: 'Overall', sampleSize: 200, predictedAvg: 60, smoothedHitRate: 55, calibrationError: 5, gap: 5 }),
    byProbability: [],
    byStat: [],
    byConfidence: [],
    byRisk: [],
    byArchetype: [],
    projectionError: null,
    series: [],
    windows: {
      last7Days: bucket({ label: 'Last 7 days', sampleSize: 0 }),
      last30Days: bucket({ label: 'Last 30 days', sampleSize: 0 }),
      last100Picks: bucket({ label: 'Last 100 picks', sampleSize: 0 }),
      last500Picks: bucket({ label: 'Last 500 picks', sampleSize: 0 }),
    },
    daysAnalyzed: 30,
    legsAnalyzed: 200,
    rangeStart: '2026-04-01',
    rangeEnd: '2026-05-01',
    ...over,
  };
}

describe('applyNbaCalibrationAdjustment — bucket matching', () => {
  test('Predicted prob inside a populated bucket → tempered shift fires', () => {
    const r = report({
      byProbability: [
        bucket({
          label: '70-79%',
          predictedAvg: 75,
          smoothedHitRate: 65,             // model overclaims by 10
          sampleSize: 80,
        }),
      ],
    });
    const adj = applyNbaCalibrationAdjustment(75, r);
    expect(adj.shift).toBeLessThan(0);
    expect(adj.adjustedProbability).toBeLessThan(75);
    expect(adj.reason).toMatch(/tempered/i);
  });

  test('Predicted prob outside any populated bucket → no adjustment', () => {
    const r = report({
      byProbability: [bucket({ label: '70-79%', sampleSize: 50 })],
    });
    // 55 lands in 50-59% which we didn't populate.
    const adj = applyNbaCalibrationAdjustment(55, r);
    expect(adj.shift).toBe(0);
  });

  test('100% lands in the 90-100% bucket (last bucket inclusive)', () => {
    const r = report({
      byProbability: [
        bucket({
          label: '90-100%',
          predictedAvg: 95,
          smoothedHitRate: 70,
          sampleSize: 100,
        }),
      ],
    });
    const adj = applyNbaCalibrationAdjustment(100, r);
    expect(adj.shift).toBeLessThan(0);
    expect(adj.bucketSample).toBe(100);
  });
});

describe('applyNbaCalibrationAdjustment — sample guards', () => {
  test('Bucket sample below threshold → no adjustment', () => {
    const r = report({
      byProbability: [
        bucket({ label: '70-79%', smoothedHitRate: 50, sampleSize: 10 }),
      ],
    });
    const adj = applyNbaCalibrationAdjustment(75, r);
    expect(adj.shift).toBe(0);
    expect(adj.bucketSample).toBe(10);
  });

  test('Tiny gap (< 1.5pt) → no adjustment', () => {
    const r = report({
      byProbability: [
        bucket({ label: '70-79%', smoothedHitRate: 74, sampleSize: 100 }),
      ],
    });
    const adj = applyNbaCalibrationAdjustment(75, r);
    expect(adj.shift).toBe(0);
  });
});

describe('applyNbaCalibrationAdjustment — sample-tiered cap', () => {
  test('30-99 sample bucket → 15pp cap', () => {
    const r = report({
      byProbability: [
        bucket({ label: '90-100%', smoothedHitRate: 50, sampleSize: 50 }),
      ],
    });
    const adj = applyNbaCalibrationAdjustment(95, r);
    // Raw -45, capped at -15 for the 30-99 tier.
    expect(adj.shift).toBe(-15);
    expect(adj.adjustedProbability).toBe(80);
  });

  test('100-499 sample bucket → 25pp cap', () => {
    const r = report({
      byProbability: [
        bucket({ label: '90-100%', smoothedHitRate: 50, sampleSize: 250 }),
      ],
    });
    const adj = applyNbaCalibrationAdjustment(95, r);
    expect(adj.shift).toBe(-25);
    expect(adj.adjustedProbability).toBe(70);
  });

  test('500+ sample bucket → 35pp cap', () => {
    const r = report({
      byProbability: [
        bucket({ label: '90-100%', smoothedHitRate: 55, sampleSize: 1500 }),
      ],
    });
    const adj = applyNbaCalibrationAdjustment(95, r);
    // Raw -40, capped at -35.
    expect(adj.shift).toBe(-35);
    expect(adj.adjustedProbability).toBe(60);
  });
});

describe('applyNbaCalibrationAdjustment — per-stat bucket preferred', () => {
  test('Stat bucket overrides probability bucket when statKey matches', () => {
    const r = report({
      byProbability: [
        bucket({ label: '80-89%', smoothedHitRate: 78, sampleSize: 100 }), // tight
      ],
      byStat: [
        bucket({ label: 'Points', smoothedHitRate: 50, sampleSize: 200 }), // wide
      ],
    });
    const adj = applyNbaCalibrationAdjustment(85, r, 'points');
    // Per-stat shift dominates: target = 50, predicted = 85 → cap -25 (200 samples).
    expect(adj.shift).toBe(-25);
    expect(adj.reason).toMatch(/stat Points/);
  });

  test('Falls back to probability bucket when stat-type lacks sample', () => {
    const r = report({
      byProbability: [
        bucket({ label: '80-89%', smoothedHitRate: 70, sampleSize: 200 }),
      ],
      byStat: [
        bucket({ label: '3-PT Made', smoothedHitRate: 50, sampleSize: 12 }), // thin
      ],
    });
    const adj = applyNbaCalibrationAdjustment(85, r, 'three_pt_made');
    // Stat bucket below 30-sample floor → falls through to prob bucket.
    expect(adj.shift).toBe(-15);
    expect(adj.reason).toMatch(/bucket 80-89%/);
  });

  test('No statKey → existing per-probability path unchanged', () => {
    const r = report({
      byProbability: [
        bucket({ label: '70-79%', smoothedHitRate: 65, sampleSize: 80 }),
      ],
    });
    const adj = applyNbaCalibrationAdjustment(75, r);
    expect(adj.shift).toBeLessThan(0);
    expect(adj.reason).toMatch(/bucket 70-79%/);
  });
});

describe('computeNbaCalibrationStrength', () => {
  test('Zero data → neutral 50', () => {
    const r = report({ legsAnalyzed: 0 });
    expect(computeNbaCalibrationStrength(r)).toBe(50);
  });

  test('Tight calibration + ample sample → high score', () => {
    const r = report({
      legsAnalyzed: 250,
      overall: bucket({ label: 'Overall', sampleSize: 250, calibrationError: 1.5 }),
    });
    expect(computeNbaCalibrationStrength(r)).toBeGreaterThanOrEqual(95);
  });

  test('Wide calibration error penalizes even with sample', () => {
    const tight = computeNbaCalibrationStrength(report({
      legsAnalyzed: 200,
      overall: bucket({ label: 'Overall', sampleSize: 200, calibrationError: 1 }),
    }));
    const wide = computeNbaCalibrationStrength(report({
      legsAnalyzed: 200,
      overall: bucket({ label: 'Overall', sampleSize: 200, calibrationError: 10 }),
    }));
    expect(wide).toBeLessThan(tight);
  });
});
