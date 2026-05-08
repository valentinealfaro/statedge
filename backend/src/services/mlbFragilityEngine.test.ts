// Tests for the L5 fragility engine. Pure formula — no DB. Each
// component independently exercised; tier banding pinned.

import { describe, expect, test } from 'vitest';
import {
  computeFragility,
  fragilityTier,
} from './mlbFragilityEngine.js';

const baseInputs = {
  statKey: 'hits' as const,
  playerType: 'hitter' as const,
  projection: 1.5,
  line: 1.5,
  stddev: 0.5,
  sampleStrength: 1.0,
  lineupConfirmed: true,
};

describe('computeFragility — stat rarity dominates rare-event props', () => {
  test('Home runs (rare) score higher fragility than hits at same setup', () => {
    const hitsRes = computeFragility(baseInputs);
    const hrRes = computeFragility({
      ...baseInputs,
      statKey: 'home_runs',
      projection: 0.5, line: 0.5,
    });
    expect(hrRes.fragility).toBeGreaterThan(hitsRes.fragility);
  });

  test('Triples (rarest) score higher than hits', () => {
    const hitsRes = computeFragility(baseInputs);
    const triplesRes = computeFragility({
      ...baseInputs,
      statKey: 'triples',
      projection: 0.5, line: 0.5,
    });
    expect(triplesRes.fragility).toBeGreaterThan(hitsRes.fragility);
  });
});

describe('computeFragility — margin thinness', () => {
  test('Projection right on the line scores high margin thinness', () => {
    const r = computeFragility({ ...baseInputs, projection: 1.5, line: 1.5 });
    expect(r.components.marginThinness).toBe(100);
  });

  test('Big projection separation scores low margin thinness', () => {
    const r = computeFragility({ ...baseInputs, projection: 3.0, line: 1.5 });
    expect(r.components.marginThinness).toBeLessThan(20);
  });
});

describe('computeFragility — sample weakness via Bayesian sampleStrength', () => {
  test('Full sample (strength=1) → 0 sample weakness', () => {
    const r = computeFragility({ ...baseInputs, sampleStrength: 1 });
    expect(r.components.sampleWeakness).toBe(0);
  });

  test('Half sample (strength=0.5) → 50 sample weakness', () => {
    const r = computeFragility({ ...baseInputs, sampleStrength: 0.5 });
    expect(r.components.sampleWeakness).toBe(50);
  });

  test('No sample data (strength=0) → 100 sample weakness', () => {
    const r = computeFragility({ ...baseInputs, sampleStrength: 0 });
    expect(r.components.sampleWeakness).toBe(100);
  });

  test('Null sampleStrength → neutral 50', () => {
    const r = computeFragility({ ...baseInputs, sampleStrength: null });
    expect(r.components.sampleWeakness).toBe(50);
  });
});

describe('computeFragility — volatility', () => {
  test('Low CV (stddev << projection) → low volatility', () => {
    const r = computeFragility({ ...baseInputs, stddev: 0.1, projection: 2.0 });
    expect(r.components.volatility).toBeLessThan(20);
  });

  test('High CV (stddev ≈ projection) → 100 volatility', () => {
    const r = computeFragility({ ...baseInputs, stddev: 2.0, projection: 2.0 });
    expect(r.components.volatility).toBe(100);
  });
});

describe('computeFragility — lineup uncertainty', () => {
  test('Confirmed lineup → 0 (no fragility added)', () => {
    const r = computeFragility({ ...baseInputs, lineupConfirmed: true });
    expect(r.components.lineupUncertainty).toBe(0);
  });

  test('Unconfirmed lineup → 60 (meaningful but not catastrophic)', () => {
    const r = computeFragility({ ...baseInputs, lineupConfirmed: false });
    expect(r.components.lineupUncertainty).toBe(60);
  });

  test('Pitcher → null (component dropped)', () => {
    const r = computeFragility({
      ...baseInputs,
      statKey: 'ks',
      playerType: 'pitcher',
      lineupConfirmed: null,
    });
    expect(r.components.lineupUncertainty).toBeNull();
  });
});

describe('computeFragility — full-stack scenarios', () => {
  test('Solid hits prop with confirmed lineup + full sample = Solid Floor', () => {
    const r = computeFragility({
      ...baseInputs,
      statKey: 'hits',
      projection: 1.7,
      line: 1.5,                  // some margin
      stddev: 0.4,
      sampleStrength: 1.0,
      lineupConfirmed: true,
    });
    expect(r.tier).toMatch(/Solid Floor|Moderate Fragility/);
    expect(r.fragility).toBeLessThan(50);
  });

  test('Walk-dependent + small sample + thin margin = Fragile or worse', () => {
    const r = computeFragility({
      ...baseInputs,
      statKey: 'walks',
      projection: 0.55,
      line: 0.5,                   // razor-thin margin
      stddev: 0.6,                 // high CV
      sampleStrength: 0.2,         // weak sample
      lineupConfirmed: false,      // unconfirmed
    });
    expect(r.fragility).toBeGreaterThan(50);
    expect(r.tier).toMatch(/Fragile|Very Fragile/);
  });
});

describe('fragilityTier — bands', () => {
  test('0-25 Solid Floor', () => {
    expect(fragilityTier(0)).toBe('Solid Floor');
    expect(fragilityTier(25)).toBe('Solid Floor');
  });
  test('26-50 Moderate Fragility', () => {
    expect(fragilityTier(26)).toBe('Moderate Fragility');
    expect(fragilityTier(50)).toBe('Moderate Fragility');
  });
  test('51-75 Fragile', () => {
    expect(fragilityTier(51)).toBe('Fragile');
    expect(fragilityTier(75)).toBe('Fragile');
  });
  test('76-100 Very Fragile', () => {
    expect(fragilityTier(76)).toBe('Very Fragile');
    expect(fragilityTier(100)).toBe('Very Fragile');
  });
});
