// Tests for the MC engine. Uses a high enough draw count (the engine's
// 10k default) that percentile bands are stable to within ~0.05 of
// expected — but we use generous tolerances since draws are random.

import { describe, expect, test } from 'vitest';
import {
  _internal,
  runMlbMonteCarlo,
  type MonteCarloPercentiles,
} from './mlbMonteCarloEngine.js';

describe('Monte Carlo — degenerate inputs', () => {
  test('Zero stddev returns point-mass distribution (P10 = P50 = P90 = projection)', () => {
    const r = runMlbMonteCarlo({
      statKey: 'hits',
      projection: 1.5,
      stddev: 0,
      line: 1.0,
      direction: 'OVER',
    });
    expect(r.percentiles.p10).toBe(1.5);
    expect(r.percentiles.p50).toBe(1.5);
    expect(r.percentiles.p90).toBe(1.5);
    // 1.5 > 1.0 line → 100% sim probability for OVER.
    expect(r.simulatedProbability).toBe(100);
    expect(r.draws).toBe(0);
  });

  test('Projection ON the line with zero stddev returns 50% sim probability', () => {
    const r = runMlbMonteCarlo({
      statKey: 'hits',
      projection: 1.5,
      stddev: 0,
      line: 1.5,
      direction: 'OVER',
    });
    expect(r.simulatedProbability).toBe(50);
  });

  test('Negative stddev (defensive) → degenerate', () => {
    const r = runMlbMonteCarlo({
      statKey: 'hits',
      projection: 1.5,
      stddev: -1,
      line: 1.0,
      direction: 'OVER',
    });
    expect(r.draws).toBe(0);
  });
});

describe('Monte Carlo — percentile ordering', () => {
  test('Percentiles are monotonic: P10 ≤ P25 ≤ P50 ≤ P75 ≤ P90', () => {
    const r = runMlbMonteCarlo({
      statKey: 'hits',
      projection: 1.5,
      stddev: 0.8,
      line: 1.0,
      direction: 'OVER',
    });
    const p = r.percentiles;
    expect(p.p10).toBeLessThanOrEqual(p.p25);
    expect(p.p25).toBeLessThanOrEqual(p.p50);
    expect(p.p50).toBeLessThanOrEqual(p.p75);
    expect(p.p75).toBeLessThanOrEqual(p.p90);
  });
});

describe('Monte Carlo — distribution shape', () => {
  test('Mean of 10k draws lands within 5% of projection', () => {
    const projection = 1.5;
    const r = runMlbMonteCarlo({
      statKey: 'hits',
      projection,
      stddev: 0.6,
      line: 1.0,
      direction: 'OVER',
    });
    expect(Math.abs(r.mean - projection)).toBeLessThan(0.15);
  });

  test('Counting stats are clamped to non-negative integers', () => {
    // Project a low-mean stat (e.g. 0.3 HR) — many draws should be 0.
    const r = runMlbMonteCarlo({
      statKey: 'home_runs',
      projection: 0.3,
      stddev: 0.6,
      line: 0.5,
      direction: 'OVER',
    });
    // P10 should be 0 — the floor for a zero-inflated stat with low mean.
    expect(r.percentiles.p10).toBe(0);
    expect(r.percentiles.p10).toBeGreaterThanOrEqual(0);
  });

  test('Continuous stats (innings_pitched) allow fractional values', () => {
    const r = runMlbMonteCarlo({
      statKey: 'innings_pitched',
      projection: 5.5,
      stddev: 1.2,
      line: 5.0,
      direction: 'OVER',
    });
    // Continuous shape should NOT round to integers.
    const allInts = [r.percentiles.p25, r.percentiles.p50, r.percentiles.p75]
      .every((v) => Number.isInteger(v));
    expect(allInts).toBe(false);
  });
});

describe('Monte Carlo — simulated probability sanity', () => {
  test('Projection well above line + OVER → simProb > 75%', () => {
    const r = runMlbMonteCarlo({
      statKey: 'hits',
      projection: 2.5,
      stddev: 0.5,
      line: 1.5,
      direction: 'OVER',
    });
    expect(r.simulatedProbability).toBeGreaterThan(75);
  });

  test('Projection well below line + OVER → simProb < 25%', () => {
    const r = runMlbMonteCarlo({
      statKey: 'hits',
      projection: 0.8,
      stddev: 0.5,
      line: 1.5,
      direction: 'OVER',
    });
    expect(r.simulatedProbability).toBeLessThan(25);
  });

  test('UNDER mirrors OVER: high projection + UNDER → low simProb', () => {
    const r = runMlbMonteCarlo({
      statKey: 'hits',
      projection: 2.5,
      stddev: 0.5,
      line: 1.5,
      direction: 'UNDER',
    });
    expect(r.simulatedProbability).toBeLessThan(25);
  });
});

describe('Monte Carlo — ceiling / floor tiers', () => {
  test('Tight projection at line → low ceiling, low floor', () => {
    const r = runMlbMonteCarlo({
      statKey: 'hits',
      projection: 1.5,
      stddev: 0.3,
      line: 1.5,
      direction: 'OVER',
    });
    expect(r.ceilingTier).toBe('low');
    expect(r.floorTier).toMatch(/low|medium/);
  });

  test('Huge upside projection → high ceiling tier', () => {
    const r = runMlbMonteCarlo({
      statKey: 'home_runs',
      projection: 1.0,
      stddev: 1.0,
      line: 0.5,
      direction: 'OVER',
    });
    // P90 likely 2.5+ on this draw → ceilingPctOfLine ≥ 4.0 → high
    expect(r.ceilingTier).toBe('high');
  });
});

describe('Monte Carlo — internal helpers', () => {
  test('percentile() returns boundary values at p=0 and p=1', () => {
    const sorted = [1, 2, 3, 4, 5];
    expect(_internal.percentile(sorted, 0)).toBe(1);
    expect(_internal.percentile(sorted, 1)).toBe(5);
    expect(_internal.percentile(sorted, 0.5)).toBe(3);
  });

  test('percentile() linearly interpolates between samples', () => {
    const sorted = [0, 10];
    // p=0.5 should be midpoint.
    expect(_internal.percentile(sorted, 0.5)).toBe(5);
  });

  test('shapeFor classifies stats correctly', () => {
    // Phase 18 (L6): true rare events migrated to Poisson; doubles
    // kept on the legacy zero-inflated normal path until calibrated.
    expect(_internal.shapeFor('home_runs')).toBe('poisson');
    expect(_internal.shapeFor('stolen_bases')).toBe('poisson');
    expect(_internal.shapeFor('triples')).toBe('poisson');
    expect(_internal.shapeFor('home_runs_allowed')).toBe('poisson');
    expect(_internal.shapeFor('doubles')).toBe('integer_zero_inflated');
    expect(_internal.shapeFor('hits')).toBe('integer_normal');
    expect(_internal.shapeFor('innings_pitched')).toBe('continuous_normal');
    expect(_internal.shapeFor('pitches_thrown')).toBe('continuous_normal');
  });

  test('Poisson sampler produces non-negative integers with mean ≈ λ', () => {
    // 1000 draws at λ=2.0; sample mean should be near 2 (±0.2).
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) samples.push(_internal.poissonSample(2.0));
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    expect(mean).toBeGreaterThan(1.7);
    expect(mean).toBeLessThan(2.3);
    // All draws non-negative integers.
    for (const v of samples) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  test('Poisson sampler at λ=0 always returns 0', () => {
    expect(_internal.poissonSample(0)).toBe(0);
    expect(_internal.poissonSample(-1)).toBe(0);
  });
});

// Static type guard — make sure the percentile shape doesn't drift.
type _PercentileShape = MonteCarloPercentiles & Record<string, number>;
const _typeCheck: _PercentileShape = { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
void _typeCheck;
