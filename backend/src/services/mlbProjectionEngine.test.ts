// Tests for the pure formula in computeMlbProjection. No DB; all
// inputs are synthetic. The orchestrator (projectMlbStat) is just
// "load + compute" and doesn't need its own unit test — the SQL
// queries get exercised via the integration smoke test once the DB
// is seeded.

import { describe, expect, test } from 'vitest';
import {
  computeMlbProjection,
  STAT_TYPE_RISK,
  type ProjectionInputs,
} from './mlbProjectionEngine.js';
import type { MlbLast10Result } from './mlbLast10Engine.js';

function makeLast10(over: Partial<MlbLast10Result> = {}): MlbLast10Result {
  // Default: 10-game sample averaging 1.5 with σ=0.7.
  const values = over.values ?? [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  const sample = values.length;
  const avg = values.reduce((s, v) => s + v, 0) / sample;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / sample;
  return {
    playerId: 1,
    statKey: 'hits',
    playerType: 'hitter',
    values,
    games: values.map((v, i) => ({
      gameId: i + 1,
      gameDate: '2026-04-01',
      opponentTeamId: 99,
      isHome: i % 2 === 0,
      value: v,
    })),
    sampleSize: sample,
    average: avg,
    median: avg,
    high: Math.max(...values),
    low: Math.min(...values),
    stddev: Math.sqrt(variance),
    last5Average: values.slice(-5).reduce((s, v) => s + v, 0) / 5,
    last10Average: avg,
    trend: 0,
    consistencyScore: 70,
    riskScore: 30,
    ...over,
  };
}

function inputs(over: Partial<ProjectionInputs> = {}): ProjectionInputs {
  return {
    statKey: 'hits',
    playerType: 'hitter',
    line: 1.5,
    direction: 'OVER',
    last10: makeLast10(),
    seasonAverage: 1.5,
    seasonGames: 60,
    opponentAverage: 1.4,
    opponentGames: 4,
    homeAverage: 1.6,
    awayAverage: 1.4,
    isHome: true,
    ...over,
  };
}

describe('computeMlbProjection — empty / degenerate inputs', () => {
  test('zero sample returns neutral 50% with high trap + low confidence', () => {
    const r = computeMlbProjection(inputs({
      last10: makeLast10({ values: [], sampleSize: 0, last10Average: 0, last5Average: null, stddev: 0 }),
    }));
    expect(r.probability).toBe(50);
    expect(r.confidence).toBe(0);
    expect(r.trapScore).toBeGreaterThanOrEqual(60);
    expect(r.qualifiesForCards.safe).toBe(false);
    expect(r.qualifiesForCards.balanced).toBe(false);
    expect(r.reasonCodes.join(' ')).toContain('No game-log data');
  });
});

describe('computeMlbProjection — direction + line', () => {
  test('projection above line + OVER → probability > 50', () => {
    // L10 avg 2.0, σ 0.5, line 1.5 → projection sits ~1σ above line.
    const r = computeMlbProjection(inputs({
      line: 1.5,
      direction: 'OVER',
      last10: makeLast10({
        values: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
        last10Average: 2,
        last5Average: 2,
        stddev: 0.5,
      }),
      opponentAverage: 2.0,
      seasonAverage: 2.0,
      homeAverage: 2.0, awayAverage: 2.0,
    }));
    expect(r.probability).toBeGreaterThan(60);
    expect(r.projection).toBeGreaterThan(1.5);
    expect(r.edgePercent).toBeGreaterThan(10);
  });

  test('projection above line + UNDER → probability < 50', () => {
    const r = computeMlbProjection(inputs({
      line: 1.5,
      direction: 'UNDER',
      last10: makeLast10({
        values: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
        last10Average: 2,
        last5Average: 2,
        stddev: 0.5,
      }),
      opponentAverage: 2.0,
      seasonAverage: 2.0,
      homeAverage: 2.0, awayAverage: 2.0,
    }));
    expect(r.probability).toBeLessThan(50);
  });

  test('probability is soft-capped to [5, 95] — no fake locks', () => {
    // Extreme separation should still cap at 95.
    const r = computeMlbProjection(inputs({
      line: 0.5,                         // line way below projection
      direction: 'OVER',
      last10: makeLast10({
        values: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
        last10Average: 5,
        last5Average: 5,
        stddev: 0.1,
      }),
      seasonAverage: 5, opponentAverage: 5, homeAverage: 5, awayAverage: 5,
    }));
    expect(r.probability).toBeLessThanOrEqual(95);
    expect(r.probability).toBeGreaterThanOrEqual(85);
  });
});

describe('computeMlbProjection — sample size + confidence', () => {
  test('small sample drops confidence and raises trap score', () => {
    const r = computeMlbProjection(inputs({
      last10: makeLast10({
        values: [1, 2, 1],
        sampleSize: 3,
        last10Average: 4 / 3,
        last5Average: 4 / 3,
        stddev: 0.47,
      }),
      seasonGames: 3,
      opponentGames: 0, opponentAverage: null,
    }));
    expect(r.confidence).toBeLessThanOrEqual(30);
    expect(r.trapScore).toBeGreaterThanOrEqual(20);
    expect(r.reasonCodes.join(' ')).toMatch(/small[- ]sample/i);
  });

  test('full sample lifts confidence', () => {
    const r = computeMlbProjection(inputs());
    expect(r.confidence).toBeGreaterThan(60);
  });
});

describe('computeMlbProjection — trap score', () => {
  test('thin line margin raises trap score', () => {
    // Projection essentially at the line.
    const r = computeMlbProjection(inputs({
      line: 1.5,
      last10: makeLast10({
        values: [1, 2, 1, 2, 1, 2, 1, 2, 1, 2],
        last10Average: 1.5,
        last5Average: 1.5,
        stddev: 0.5,
      }),
      seasonAverage: 1.5,
    }));
    expect(r.trapScore).toBeGreaterThanOrEqual(20);
  });

  test('high CV raises trap score', () => {
    const r = computeMlbProjection(inputs({
      last10: makeLast10({
        values: [0, 5, 0, 0, 6, 0, 5, 0, 0, 0],
        last10Average: 1.6,
        last5Average: 1.0,
        stddev: 2.4,                      // CV ~1.5 — wildly volatile
      }),
    }));
    expect(r.trapScore).toBeGreaterThanOrEqual(20);
  });
});

describe('computeMlbProjection — eligibility gates', () => {
  test('clean strong pick qualifies for Safe + Balanced', () => {
    const r = computeMlbProjection(inputs({
      line: 1.5,
      direction: 'OVER',
      last10: makeLast10({
        values: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
        last10Average: 2,
        last5Average: 2,
        stddev: 0.5,
      }),
      seasonAverage: 2.0, opponentAverage: 2.0, homeAverage: 2.0, awayAverage: 2.0,
    }));
    expect(r.qualifiesForCards.safe).toBe(true);
    expect(r.qualifiesForCards.balanced).toBe(true);
  });

  test('low-probability pick fails Safe but may pass Balanced if edge present', () => {
    const r = computeMlbProjection(inputs({
      line: 2.5,
      direction: 'OVER',
      last10: makeLast10({
        values: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
        last10Average: 2,
        last5Average: 2,
        stddev: 0.5,
      }),
    }));
    // line 2.5, projection ~2.0 — under-the-line, low prob
    expect(r.qualifiesForCards.safe).toBe(false);
  });
});

describe('computeMlbProjection — stat-type risk floor', () => {
  test('high-variance stat (stolen_bases) keeps risk elevated', () => {
    const r = computeMlbProjection(inputs({
      statKey: 'stolen_bases',
      last10: makeLast10({
        values: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
        last10Average: 0.1,
        last5Average: 0.2,
        stddev: 0.3,
        riskScore: 20,                    // would be low without floor
      }),
    }));
    // Stat-type floor for SB = 90. Risk should reflect floor (90 * 0.6 = 54).
    expect(r.riskScore).toBeGreaterThanOrEqual(54);
  });

  test('low-variance stat (pitcher_outs) doesn\'t inflate risk', () => {
    const r = computeMlbProjection(inputs({
      statKey: 'pitcher_outs',
      playerType: 'pitcher',
      last10: makeLast10({
        values: [18, 18, 18, 18, 18, 18, 18, 18, 18, 18],
        last10Average: 18,
        last5Average: 18,
        stddev: 0.5,
        riskScore: 10,
      }),
    }));
    expect(r.riskScore).toBeLessThanOrEqual(35);
  });
});

describe('STAT_TYPE_RISK table', () => {
  test('high-variance stats sit above 80', () => {
    expect(STAT_TYPE_RISK.home_runs).toBeGreaterThanOrEqual(80);
    expect(STAT_TYPE_RISK.stolen_bases).toBeGreaterThanOrEqual(80);
    expect(STAT_TYPE_RISK.triples).toBeGreaterThanOrEqual(80);
  });
  test('low-variance stats sit below 50', () => {
    expect(STAT_TYPE_RISK.pitcher_outs).toBeLessThanOrEqual(40);
    expect(STAT_TYPE_RISK.innings_pitched).toBeLessThanOrEqual(40);
  });
});

describe('computeMlbProjection — weight renormalization', () => {
  test('missing opponent + venue + season inputs still produce a projection', () => {
    const r = computeMlbProjection(inputs({
      seasonAverage: null,
      seasonGames: 0,
      opponentAverage: null,
      opponentGames: 0,
      homeAverage: null,
      awayAverage: null,
      isHome: null,
    }));
    expect(Number.isFinite(r.projection)).toBe(true);
    expect(r.projection).toBeGreaterThan(0);
    // weights should renormalize across just last10 + last5
    expect(Object.keys(r.weightsUsed)).toContain('last10');
  });
});
