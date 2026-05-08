// Tests for the pure helpers in the MLB calibration + grader stack.
// DB-touching paths (computeMlbCalibration, gradeMlbProjections) are
// exercised by the integration smoke test once the DB is seeded.

import { describe, expect, test } from 'vitest';
import { smoothedHitRate } from './mlbCalibration.js';
import { outcomeFor } from './mlbGrader.js';

describe('Bayesian-smoothed hit rate', () => {
  test('Empty sample returns the prior (~55%)', () => {
    expect(smoothedHitRate(0, 0)).toBeCloseTo(55, 0);
  });
  test('Thin sample stays near prior — no overclaiming', () => {
    // 1-for-1 hits would be 100% raw, but smoothing pulls it back.
    const rate = smoothedHitRate(1, 1);
    expect(rate).toBeLessThan(70);
    expect(rate).toBeGreaterThan(50);
  });
  test('Strong sample dominates the prior', () => {
    // 70 hits / 100 samples → smoothed should be near 70%.
    const rate = smoothedHitRate(70, 100);
    expect(rate).toBeGreaterThan(65);
    expect(rate).toBeLessThan(72);
  });
  test('Honest about misses: 0-of-50 doesn\'t claim 0%', () => {
    // Even a brutal 0/50 miss streak smooths up to ~16% (with the
    // 11-of-20 prior) — the model isn't allowed to admit total zero
    // confidence on thin tails.
    const rate = smoothedHitRate(0, 50);
    expect(rate).toBeGreaterThan(10);
    expect(rate).toBeLessThan(20);
  });
});

describe('outcomeFor (grader direction logic)', () => {
  test('OVER hits when actual > line', () => {
    expect(outcomeFor(1.5, 'OVER', 2)).toBe('hit');
    expect(outcomeFor(1.5, 'OVER', 1)).toBe('miss');
  });
  test('UNDER hits when actual < line', () => {
    expect(outcomeFor(1.5, 'UNDER', 1)).toBe('hit');
    expect(outcomeFor(1.5, 'UNDER', 2)).toBe('miss');
  });
  test('Equal-to-line is a push regardless of direction', () => {
    expect(outcomeFor(1.5, 'OVER', 1.5)).toBe('push');
    expect(outcomeFor(1.5, 'UNDER', 1.5)).toBe('push');
  });
  test('Whole-number lines: 6 actual on a 6 line is a push', () => {
    // PrizePicks treats whole-number lines as PUSH-eligible (e.g. the
    // Mitchell U6 FGM line on 2026-05-07 that pushed and reverted the
    // card). Calibration excludes these from accuracy.
    expect(outcomeFor(6, 'OVER', 6)).toBe('push');
    expect(outcomeFor(6, 'UNDER', 6)).toBe('push');
  });
});
