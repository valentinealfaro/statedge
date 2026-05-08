// Tests for the L2 momentumExpansionScore composite. Pure formula —
// no DB. Each component is independently exercised, and the
// renormalization-on-missing-input contract is checked.

import { describe, expect, test } from 'vitest';
import {
  computeMomentumExpansionScore,
  momentumExpansionLabel,
} from './mlbMomentumExpansion.js';

const baseInputs = {
  direction: 'OVER' as const,
  last10Average: 1.5,
  last5Average: 1.5,
  seasonAverage: 1.5,
  seasonGames: 60,
  projectionDistanceScore: 50,
  last10HitRate: 50,
};

describe('computeMomentumExpansionScore — neutral case', () => {
  test('All neutral inputs return 50', () => {
    expect(computeMomentumExpansionScore(baseInputs)).toBeCloseTo(50, 1);
  });
});

describe('computeMomentumExpansionScore — production lift (L5/L10)', () => {
  test('OVER + L5 above L10 raises score', () => {
    const score = computeMomentumExpansionScore({
      ...baseInputs,
      last5Average: 2.0,    // ratio 1.33
    });
    expect(score).toBeGreaterThan(55);
  });

  test('OVER + L5 below L10 lowers score', () => {
    const score = computeMomentumExpansionScore({
      ...baseInputs,
      last5Average: 1.0,    // ratio 0.67
    });
    expect(score).toBeLessThan(45);
  });

  test('UNDER + L5 below L10 raises score (cooling = good for UNDER)', () => {
    const score = computeMomentumExpansionScore({
      ...baseInputs,
      direction: 'UNDER',
      last5Average: 1.0,    // ratio 0.67
    });
    expect(score).toBeGreaterThan(55);
  });
});

describe('computeMomentumExpansionScore — season lift (L10/season)', () => {
  test('OVER + L10 above season raises score', () => {
    const score = computeMomentumExpansionScore({
      ...baseInputs,
      last10Average: 2.0,
      last5Average: 2.0,    // hold L5/L10 ratio neutral so we isolate season
      seasonAverage: 1.5,   // ratio 1.33
    });
    expect(score).toBeGreaterThan(55);
  });

  test('Season component drops when seasonGames < 10', () => {
    // OVER + season ABOVE L10 = "cooling off vs identity" → score down.
    // With seasonGames < 10 the season component drops, so the score
    // stops being dragged down → goes UP toward neutral.
    const withSeason = computeMomentumExpansionScore({
      ...baseInputs,
      seasonAverage: 3.0,   // L10/season = 0.5 → bearish for OVER
      seasonGames: 60,
    });
    const withoutSeason = computeMomentumExpansionScore({
      ...baseInputs,
      seasonAverage: 3.0,
      seasonGames: 5,       // below threshold → dropped
    });
    expect(withoutSeason).toBeGreaterThan(withSeason);
  });
});

describe('computeMomentumExpansionScore — projection separation', () => {
  test('High projection distance pushes score up', () => {
    const score = computeMomentumExpansionScore({
      ...baseInputs,
      projectionDistanceScore: 95,
    });
    expect(score).toBeGreaterThan(60);
  });

  test('Zero projection distance pulls score down', () => {
    const score = computeMomentumExpansionScore({
      ...baseInputs,
      projectionDistanceScore: 0,
    });
    expect(score).toBeLessThan(45);
  });
});

describe('computeMomentumExpansionScore — volume lift (L10 hit rate)', () => {
  test('OVER + 80% L10 hit rate raises score', () => {
    const score = computeMomentumExpansionScore({
      ...baseInputs,
      last10HitRate: 80,
    });
    expect(score).toBeGreaterThan(50);
  });

  test('UNDER + 20% L10 hit rate raises score (UNDER side hit 80% of L10)', () => {
    const score = computeMomentumExpansionScore({
      ...baseInputs,
      direction: 'UNDER',
      last10HitRate: 20,
    });
    expect(score).toBeGreaterThan(50);
  });

  test('Null hit rate drops the volume component (no inflated neutral)', () => {
    // With volumeLift dropped, separation still drives. Push separation
    // to 80 and verify the result reflects the now-larger weight on it.
    const score = computeMomentumExpansionScore({
      ...baseInputs,
      projectionDistanceScore: 80,
      last10HitRate: null,
    });
    expect(score).toBeGreaterThan(55);
  });
});

describe('computeMomentumExpansionScore — full-stack momentum', () => {
  test('OVER with L5 ↑ + L10 ↑ + projection separation + hit rate ↑ = strong score', () => {
    const score = computeMomentumExpansionScore({
      direction: 'OVER',
      last10Average: 2.0,
      last5Average: 2.4,
      seasonAverage: 1.6,
      seasonGames: 80,
      projectionDistanceScore: 75,
      last10HitRate: 70,
    });
    expect(score).toBeGreaterThan(70);
    expect(momentumExpansionLabel(score)).toMatch(/Expansion|Expanding/);
  });

  test('OVER with everything cold returns sub-30', () => {
    const score = computeMomentumExpansionScore({
      direction: 'OVER',
      last10Average: 2.0,
      last5Average: 1.2,
      seasonAverage: 2.5,
      seasonGames: 80,
      projectionDistanceScore: 10,
      last10HitRate: 20,
    });
    expect(score).toBeLessThan(30);
    expect(momentumExpansionLabel(score)).toMatch(/Cooling|Fading/);
  });
});

describe('momentumExpansionLabel — bands', () => {
  test('Strong Expansion at 75+', () => {
    expect(momentumExpansionLabel(80)).toBe('Strong Expansion');
  });
  test('Expanding at 60-74', () => {
    expect(momentumExpansionLabel(65)).toBe('Expanding');
  });
  test('Neutral at 40-59', () => {
    expect(momentumExpansionLabel(50)).toBe('Neutral');
  });
  test('Cooling at 25-39', () => {
    expect(momentumExpansionLabel(30)).toBe('Cooling');
  });
  test('Fading Hard below 25', () => {
    expect(momentumExpansionLabel(10)).toBe('Fading Hard');
  });
});
