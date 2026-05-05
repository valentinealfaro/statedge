import { describe, expect, test } from 'vitest';
import { buildLast10Report, isDoubleDoubleGame } from './last10.js';
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
    points: 25, rebounds: 8, oreb: 2, dreb: 6, assists: 7, steals: 1, blocks: 1, turnovers: 3,
    fgm: 9, fga: 18, fg3m: 2, fg3a: 5, ftm: 5, fta: 6,
    fgPct: 0.5, fg3Pct: 0.4, ftPct: 0.85,
    pf: 2,
    ...overrides,
  };
}

describe('isDoubleDoubleGame', () => {
  test('two 10+ counts', () => expect(isDoubleDoubleGame(pg({ points: 22, rebounds: 11 }))).toBe(true));
  test('one does not', () => expect(isDoubleDoubleGame(pg({ points: 22, rebounds: 4, assists: 4 }))).toBe(false));
});

describe('buildLast10Report (numeric stats)', () => {
  test('caps at 10 games', () => {
    const games = Array.from({ length: 15 }, (_, i) => pg({ gameId: `g${i}`, points: i * 2 }));
    const r = buildLast10Report(games, 'points');
    expect(r.gamesAnalyzed).toBe(10);
  });

  test('average / high / low / values for points', () => {
    const games = [
      pg({ points: 30 }), pg({ points: 20 }), pg({ points: 25 }),
      pg({ points: 15 }), pg({ points: 35 }),
    ];
    const r = buildLast10Report(games, 'points');
    if (r.selectedStat === 'double_double') throw new Error('expected numeric');
    expect(r.values).toEqual([30, 20, 25, 15, 35]);
    expect(r.high).toBe(35);
    expect(r.low).toBe(15);
    expect(r.average).toBe(25);
    expect(r.hitCountAboveAverage).toBe(2); // 30 and 35
  });

  test('combos work — pra', () => {
    const games = [pg({ points: 30, rebounds: 10, assists: 5 })];
    const r = buildLast10Report(games, 'pra');
    if (r.selectedStat === 'double_double') throw new Error('expected numeric');
    expect(r.values).toEqual([45]);
  });

  test('returns 0s for empty input', () => {
    const r = buildLast10Report([], 'points');
    if (r.selectedStat === 'double_double') throw new Error('expected numeric');
    expect(r.gamesAnalyzed).toBe(0);
    expect(r.average).toBe(0);
    expect(r.high).toBe(0);
    expect(r.low).toBe(0);
  });
});

describe('buildLast10Report (double_double)', () => {
  test('counts and rate match yes/no values', () => {
    const games = [
      pg({ points: 22, rebounds: 11 }),  // DD
      pg({ points: 14, rebounds: 5 }),   // no
      pg({ points: 30, rebounds: 8, assists: 12 }),  // DD
      pg({ points: 18, rebounds: 9, assists: 4 }),   // no
    ];
    const r = buildLast10Report(games, 'double_double');
    if (r.selectedStat !== 'double_double') throw new Error('expected dd');
    expect(r.doubleDouble.values).toEqual([true, false, true, false]);
    expect(r.doubleDouble.count).toBe(2);
    expect(r.doubleDouble.rate).toBe(50);
  });
});
