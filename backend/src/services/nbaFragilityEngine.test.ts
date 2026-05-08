// Tests for the NBA fragility engine. Pure formula — no DB.

import { describe, expect, test } from 'vitest';
import {
  computeNbaFragility,
  nbaFragilityTier,
} from './nbaFragilityEngine.js';

const baseInputs = {
  statKey: 'points' as const,
  projection: 24,
  line: 22.5,
  stddev: 5,
  last10Size: 10,
  projectedMinutes: 35,
};

describe('computeNbaFragility — base scenarios', () => {
  test('Solid points prop with full sample + locked-in role = Solid Floor / Moderate', () => {
    const r = computeNbaFragility(baseInputs);
    expect(r.fragility).toBeLessThan(50);
    expect(r.tier).toMatch(/Solid Floor|Moderate Fragility/);
  });

  test('Rare-event blocks prop with thin margin + foul-trouble minutes = Fragile or worse', () => {
    const r = computeNbaFragility({
      ...baseInputs,
      statKey: 'blocks',
      projection: 1.0,
      line: 0.5,                  // razor margin (gap on small absolute)
      stddev: 1.2,
      last10Size: 8,
      projectedMinutes: 22,        // role uncertainty
    });
    expect(r.fragility).toBeGreaterThan(40);
    expect(r.components.statRarity).toBe(80);
    expect(r.components.minutesUncertainty).toBeGreaterThanOrEqual(50);
  });
});

describe('computeNbaFragility — minutes uncertainty bands', () => {
  test('30+ projected mins → 0', () => {
    expect(computeNbaFragility({ ...baseInputs, projectedMinutes: 32 }).components.minutesUncertainty).toBe(0);
  });
  test('25-30 → 25', () => {
    expect(computeNbaFragility({ ...baseInputs, projectedMinutes: 26 }).components.minutesUncertainty).toBe(25);
  });
  test('20-25 → 50', () => {
    expect(computeNbaFragility({ ...baseInputs, projectedMinutes: 21 }).components.minutesUncertainty).toBe(50);
  });
  test('< 20 → 80 (rotation player risk)', () => {
    expect(computeNbaFragility({ ...baseInputs, projectedMinutes: 15 }).components.minutesUncertainty).toBe(80);
  });
  test('null projectedMinutes → 60 (unknown role)', () => {
    expect(computeNbaFragility({ ...baseInputs, projectedMinutes: null }).components.minutesUncertainty).toBe(60);
  });
});

describe('computeNbaFragility — stat rarity', () => {
  test('Volume stats (points) score ≤ 35', () => {
    expect(computeNbaFragility(baseInputs).components.statRarity).toBe(35);
  });
  test('Three-pointers made score 70 (one swing decides)', () => {
    expect(computeNbaFragility({ ...baseInputs, statKey: 'three_pt_made' }).components.statRarity).toBe(70);
  });
  test('Blocks score 80 (rarest)', () => {
    expect(computeNbaFragility({ ...baseInputs, statKey: 'blocks' }).components.statRarity).toBe(80);
  });
  test('PRA scores 30 (combined volume = stable)', () => {
    expect(computeNbaFragility({ ...baseInputs, statKey: 'pra' }).components.statRarity).toBe(30);
  });
});

describe('nbaFragilityTier — bands match MLB so UI is consistent', () => {
  test('0-25 Solid Floor', () => {
    expect(nbaFragilityTier(20)).toBe('Solid Floor');
  });
  test('26-50 Moderate Fragility', () => {
    expect(nbaFragilityTier(45)).toBe('Moderate Fragility');
  });
  test('51-75 Fragile', () => {
    expect(nbaFragilityTier(70)).toBe('Fragile');
  });
  test('76-100 Very Fragile', () => {
    expect(nbaFragilityTier(85)).toBe('Very Fragile');
  });
});
