import { describe, expect, test } from 'vitest';
import {
  average,
  calcPA,
  calcPR,
  calcPRA,
  calcRA,
  calcStocks,
  calculateComboStats,
} from './statCombos.js';
import type { PlayerGame } from '../nba/client.js';

function pg(overrides: Partial<PlayerGame> = {}): PlayerGame {
  return {
    gameId: 'g',
    date: '2025-01-01',
    matchup: 'LAL vs. DEN',
    opponentAbbr: 'DEN',
    isHome: true,
    result: 'W',
    minutes: 35,
    points: 25,
    rebounds: 7,
    oreb: 2,
    dreb: 5,
    assists: 8,
    steals: 2,
    blocks: 1,
    turnovers: 3,
    fgm: 9, fga: 18, fg3m: 2, fg3a: 5, ftm: 5, fta: 6,
    fgPct: 0.5, fg3Pct: 0.4, ftPct: 0.85,
    pf: 2,
    ...overrides,
  };
}

describe('combo math per game', () => {
  const g = pg({ points: 30, rebounds: 10, assists: 5, blocks: 1, steals: 2 });
  test('PRA', () => expect(calcPRA(g)).toBe(45));
  test('PR',  () => expect(calcPR(g)).toBe(40));
  test('PA',  () => expect(calcPA(g)).toBe(35));
  test('RA',  () => expect(calcRA(g)).toBe(15));
  test('Stocks', () => expect(calcStocks(g)).toBe(3));
});

describe('average', () => {
  test('returns 0 for empty', () => expect(average([])).toBe(0));
  test('arithmetic mean', () => expect(average([10, 20, 30])).toBe(20));
});

describe('calculateComboStats', () => {
  test('averages each combo across games', () => {
    const games = [
      pg({ points: 30, rebounds: 10, assists: 5, blocks: 1, steals: 2 }),
      pg({ points: 20, rebounds: 6,  assists: 7, blocks: 0, steals: 1 }),
    ];
    const c = calculateComboStats(games);
    // PRA: (45 + 33) / 2 = 39
    expect(c.PRA).toBe(39);
    // PR: (40 + 26) / 2 = 33
    expect(c.PR).toBe(33);
    // PA: (35 + 27) / 2 = 31
    expect(c.PA).toBe(31);
    // RA: (15 + 13) / 2 = 14
    expect(c.RA).toBe(14);
    // Stocks: (3 + 1) / 2 = 2
    expect(c.STOCKS).toBe(2);
  });

  test('zero games returns zeros, not NaN', () => {
    const c = calculateComboStats([]);
    expect(c).toEqual({ PRA: 0, PR: 0, PA: 0, RA: 0, STOCKS: 0 });
  });
});
