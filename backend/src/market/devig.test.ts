// Tests for the de-vigging math. Pure functions — no DB, no network.

import { describe, expect, test } from 'vitest';
import {
  devigPair,
  devigSingleSide,
  trueProbForSide,
} from './devig.js';

describe('devigPair — symmetric markets', () => {
  test('-110 / -110 → 50/50 with 4.8% vig', () => {
    // -110 odds → raw implied 52.4% per side (1.10/2.10).
    const r = devigPair(52.4, 52.4);
    expect(r.trueOver).toBe(50);
    expect(r.trueUnder).toBe(50);
    expect(r.vigPct).toBe(4.8);
    expect(r.method).toBe('multiplicative');
  });

  test('-115 / -115 → 50/50', () => {
    // -115 odds → raw implied ~53.5% per side.
    const r = devigPair(53.5, 53.5);
    expect(r.trueOver).toBe(50);
    expect(r.trueUnder).toBe(50);
  });
});

describe('devigPair — asymmetric markets', () => {
  test('-150 / +125 favorite stays favored but margin shrinks', () => {
    // -150 → 60.0%; +125 → 44.4%. Sum 104.4% (4.4% vig).
    // De-vigged: 60.0/104.4 = 57.5%, 44.4/104.4 = 42.5%.
    const r = devigPair(60.0, 44.4);
    expect(r.trueOver).toBe(57.5);
    expect(r.trueUnder).toBe(42.5);
    expect(r.vigPct).toBe(4.4);
  });

  test('Heavy favorite -300 / +220 → de-vigged ~73/27', () => {
    // -300 → 75.0%; +220 → 31.3%. Sum 106.3%.
    // De-vigged: 75.0/106.3 ≈ 70.6%, 31.3/106.3 ≈ 29.4%.
    const r = devigPair(75.0, 31.3);
    expect(r.trueOver).toBeCloseTo(70.6, 1);
    expect(r.trueUnder).toBeCloseTo(29.4, 1);
    expect(r.trueOver + r.trueUnder).toBeCloseTo(100, 1);
  });
});

describe('devigPair — sums to 100', () => {
  test('Any pair de-vigs to a normalized 100% market', () => {
    const r = devigPair(58.3, 47.6);
    expect(r.trueOver + r.trueUnder).toBeCloseTo(100, 1);
  });
});

describe('devigPair — guards', () => {
  test('Non-finite input throws', () => {
    expect(() => devigPair(NaN, 50)).toThrow();
    expect(() => devigPair(50, Infinity)).toThrow();
  });
  test('Zero or negative input throws', () => {
    expect(() => devigPair(0, 50)).toThrow();
    expect(() => devigPair(50, -1)).toThrow();
  });
});

describe('devigSingleSide', () => {
  test('Default 4.5% vig → subtracts 2.25pp', () => {
    expect(devigSingleSide(52.4)).toBe(50.2);   // 52.4 - 2.25 → round1 50.2
    expect(devigSingleSide(60)).toBe(57.8);
  });

  test('Custom vig override', () => {
    // 6% total vig → 3pp per side.
    expect(devigSingleSide(55, 6)).toBe(52);
  });

  test('Clamps at the 1..99 sane band', () => {
    // Tiny raw → underflow; expect floor of 1.
    expect(devigSingleSide(2)).toBe(1);
    // Massive raw → cap at 99. Need input > 101.25 (= 99 + halfVig)
    // to actually exercise the upper clamp; 105 - 2.25 = 102.75 → 99.
    expect(devigSingleSide(105)).toBe(99);
  });

  test('Throws on bad input', () => {
    expect(() => devigSingleSide(0)).toThrow();
    expect(() => devigSingleSide(NaN)).toThrow();
    expect(() => devigSingleSide(-5)).toThrow();
  });
});

describe('trueProbForSide', () => {
  test('Returns the over true prob for OVER', () => {
    const r = devigPair(60, 44.4);
    expect(trueProbForSide(r, 'OVER')).toBe(r.trueOver);
  });

  test('Returns the under true prob for UNDER', () => {
    const r = devigPair(60, 44.4);
    expect(trueProbForSide(r, 'UNDER')).toBe(r.trueUnder);
  });
});
