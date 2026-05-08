// Tests for the L1 robust baseline + Bayesian regression engine.
// Pure formula — no DB. Each helper independently exercised; the
// renormalization-on-missing-input contract is checked.

import { describe, expect, test } from 'vitest';
import {
  applyBayesianRegression,
  computeRobustBaseline,
  getStabilizationGames,
  median,
  trimmedMean,
  windowAverage,
} from './mlbBaselineEngine.js';

// 30 ordered values, most-recent first. Mean = 1.5, with intentional
// recent uptick so L5 > L10 > L20 > L30.
const SAMPLE_30 = [
  3, 2, 2, 3, 2,    // L5 mean = 2.4
  2, 1, 2, 1, 2,    // L10 mean = 2.0
  1, 2, 1, 2, 1, 1, 2, 1, 1, 1,    // L20 mean = 1.55
  1, 1, 2, 0, 1, 1, 0, 1, 2, 1,    // L30 mean ≈ 1.43
];

describe('windowAverage', () => {
  test('Returns mean of first N values', () => {
    expect(windowAverage([2, 4, 6, 8], 2)).toBe(3);
    expect(windowAverage([2, 4, 6, 8], 4)).toBe(5);
  });

  test('Returns null when sample is below the min-games threshold', () => {
    expect(windowAverage([1, 2], 10, 5)).toBeNull();
  });

  test('Default min-games defaults to min(window, 3)', () => {
    expect(windowAverage([1, 2], 10)).toBeNull();        // need ≥3
    expect(windowAverage([1, 2, 3], 10)).toBeCloseTo(2);  // 3 satisfies default
  });
});

describe('median', () => {
  test('Odd-length returns middle', () => {
    expect(median([1, 2, 3, 4, 5])).toBe(3);
  });
  test('Even-length averages the two middles', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  test('Empty returns null', () => {
    expect(median([])).toBeNull();
  });
  test('Order-independent', () => {
    expect(median([5, 1, 4, 2, 3])).toBe(3);
  });
});

describe('trimmedMean', () => {
  test('Trims top + bottom 10% by default', () => {
    // 10 values; 10% trim → cut 0 from each end → plain mean.
    expect(trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(5.5);
    // 20 values; 10% → cut 1 from each end → mean of middle 18
    const arr20 = Array.from({ length: 20 }, (_, i) => i + 1);
    // mean of 2..19 = (2+19)/2 = 10.5
    expect(trimmedMean(arr20)).toBeCloseTo(10.5);
  });

  test('Outliers get cut at 10% trim — robust to one extreme', () => {
    // [1,2,3,4,5,6,7,8,9,1000]: plain mean = 104.5; trim drops 1000+1 ⇒ mean(2..9) = 5.5
    const plain = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000];
    const trimmed = trimmedMean(plain, 0.20)!;     // 20% → cut 1 each end
    expect(trimmed).toBeCloseTo(5.5);
  });

  test('Falls back to plain mean for tiny samples', () => {
    expect(trimmedMean([1, 2, 3])).toBeCloseTo(2);
  });

  test('Empty returns null', () => {
    expect(trimmedMean([])).toBeNull();
  });
});

describe('computeRobustBaseline', () => {
  test('Empty values returns 0 robust + all-null components', () => {
    const r = computeRobustBaseline([]);
    expect(r.robust).toBe(0);
    expect(r.components.seasonAverage).toBeNull();
    expect(r.components.last10Average).toBeNull();
  });

  test('Full 30-game sample populates every component', () => {
    const r = computeRobustBaseline(SAMPLE_30);
    expect(r.components.seasonAverage).not.toBeNull();
    expect(r.components.last30Average).not.toBeNull();
    expect(r.components.last20Average).not.toBeNull();
    expect(r.components.last10Average).not.toBeNull();
    expect(r.components.last5Average).not.toBeNull();
    expect(r.components.median).not.toBeNull();
    expect(r.components.trimmedMean).not.toBeNull();
  });

  test('Recent uptick (L5 > L10 > L20) pushes robust ABOVE season mean', () => {
    const r = computeRobustBaseline(SAMPLE_30);
    expect(r.robust).toBeGreaterThan(r.components.seasonAverage!);
  });

  test('Renormalizes when narrower windows drop out', () => {
    // Only 8 games — L30 and L20 both null; L10 (min 5), L5 (min 3),
    // season, median, trimmedMean still present.
    const eight = [3, 2, 2, 3, 2, 2, 1, 2];
    const r = computeRobustBaseline(eight);
    expect(r.components.last30Average).toBeNull();
    expect(r.components.last20Average).toBeNull();
    expect(r.components.last10Average).not.toBeNull();
    // Weights should sum to 1.0 across whatever components remain.
    const totalW = Object.values(r.weightsUsed).reduce((s, v) => s + v, 0);
    expect(totalW).toBeCloseTo(1.0, 1);
  });

  test('Single game falls back to that value', () => {
    const r = computeRobustBaseline([2]);
    expect(r.robust).toBeCloseTo(2);
  });
});

describe('applyBayesianRegression', () => {
  test('Above threshold → trusts recent fully', () => {
    const reg = applyBayesianRegression({
      recent: 3.0, anchor: 1.5, gamesPlayed: 80, threshold: 20,
    });
    expect(reg.sampleStrength).toBeCloseTo(1.0);
    expect(reg.blended).toBeCloseTo(3.0);
  });

  test('Below threshold → blends toward anchor', () => {
    const reg = applyBayesianRegression({
      recent: 3.0, anchor: 1.5, gamesPlayed: 5, threshold: 20,
    });
    // 5/20 = 0.25 → blended = 3.0*0.25 + 1.5*0.75 = 0.75 + 1.125 = 1.875
    expect(reg.sampleStrength).toBeCloseTo(0.25);
    expect(reg.blended).toBeCloseTo(1.875);
  });

  test('Zero games → pure anchor', () => {
    const reg = applyBayesianRegression({
      recent: 3.0, anchor: 1.5, gamesPlayed: 0, threshold: 20,
    });
    expect(reg.sampleStrength).toBe(0);
    expect(reg.blended).toBeCloseTo(1.5);
  });

  test('At threshold → sampleStrength = 1', () => {
    const reg = applyBayesianRegression({
      recent: 3.0, anchor: 1.5, gamesPlayed: 20, threshold: 20,
    });
    expect(reg.sampleStrength).toBe(1);
    expect(reg.blended).toBeCloseTo(3.0);
  });
});

describe('getStabilizationGames', () => {
  test('Hits stabilizes around 20 games (~80 PA / 4)', () => {
    expect(getStabilizationGames('hits')).toBe(20);
  });
  test('HR needs more games (~180 PA / 4 = 45)', () => {
    expect(getStabilizationGames('home_runs')).toBe(45);
  });
  test('Pitcher Outs stabilizes early (~250 BF / 25 = 10)', () => {
    expect(getStabilizationGames('pitcher_outs')).toBe(10);
  });
});
