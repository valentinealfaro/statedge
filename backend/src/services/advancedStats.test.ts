import { describe, expect, test } from 'vitest';
import {
  calcTrendL5L10,
  calculateAdvancedStats,
  consistencyLabel,
  consistencyScore,
  homeAwaySplits,
  isDoubleDouble,
  isTripleDouble,
  performanceVsTeam,
} from './advancedStats.js';
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
    points: 25, rebounds: 7, assists: 8, steals: 1, blocks: 1, turnovers: 3,
    fgm: 9, fga: 18, fg3m: 2, fg3a: 5, ftm: 5, fta: 6,
    fgPct: 0.5, fg3Pct: 0.4, ftPct: 0.85,
    pf: 2,
    ...overrides,
  };
}

describe('isDoubleDouble', () => {
  test('two 10+ stats counts', () => {
    expect(isDoubleDouble(pg({ points: 22, rebounds: 11, assists: 4 }))).toBe(true);
  });
  test('one 10+ does not', () => {
    expect(isDoubleDouble(pg({ points: 22, rebounds: 5, assists: 4 }))).toBe(false);
  });
  test('exactly 10 counts', () => {
    expect(isDoubleDouble(pg({ points: 10, rebounds: 10, assists: 0 }))).toBe(true);
  });
});

describe('isTripleDouble', () => {
  test('three 10+ stats counts', () => {
    expect(isTripleDouble(pg({ points: 30, rebounds: 11, assists: 12 }))).toBe(true);
  });
  test('two 10+ does not', () => {
    expect(isTripleDouble(pg({ points: 30, rebounds: 11, assists: 9 }))).toBe(false);
  });
  test('blocks/steals can fill the third', () => {
    expect(isTripleDouble(pg({ points: 22, rebounds: 11, assists: 9, blocks: 10 }))).toBe(true);
  });
});

describe('consistencyScore', () => {
  test('100 for identical values', () => {
    expect(consistencyScore([20, 20, 20])).toBe(100);
  });
  test('0 for empty', () => {
    expect(consistencyScore([])).toBe(0);
  });
  test('clamps within 0-100', () => {
    const v = consistencyScore([1, 100, 1, 100]);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });
});

describe('consistencyLabel', () => {
  test('thresholds', () => {
    expect(consistencyLabel(90)).toBe('Very Consistent');
    expect(consistencyLabel(75)).toBe('Consistent');
    expect(consistencyLabel(55)).toBe('Moderate');
    expect(consistencyLabel(20)).toBe('Volatile');
  });
});

describe('calcTrendL5L10', () => {
  test('Not Enough Data when fewer than 5 values', () => {
    expect(calcTrendL5L10([10, 20]).label).toBe('Not Enough Data');
  });
  test('Trending Up when last5 is >10% higher than last10', () => {
    // Newest first per NBA api convention: [recent5..., older5...]
    const r = calcTrendL5L10([28, 28, 28, 28, 28, 18, 18, 18, 18, 18]);
    expect(r.label).toBe('Trending Up');
    expect(r.percentChange).toBeGreaterThan(10);
  });
  test('Trending Down', () => {
    const r = calcTrendL5L10([15, 15, 15, 15, 15, 25, 25, 25, 25, 25]);
    expect(r.label).toBe('Trending Down');
  });
  test('Stable within 10%', () => {
    expect(calcTrendL5L10([20, 21, 19, 20, 21, 20, 20, 20, 20, 20]).label).toBe('Stable');
  });
});

describe('performanceVsTeam', () => {
  test('Better vs Team when 10%+ above season', () => {
    expect(performanceVsTeam(27.5, 25).label).toBe('Better vs Team');
  });
  test('Worse vs Team when 10%+ below', () => {
    expect(performanceVsTeam(20, 25).label).toBe('Worse vs Team');
  });
  test('About Average within 10%', () => {
    expect(performanceVsTeam(26, 25).label).toBe('About Average');
  });
  test('Not Enough Data when seasonAvg is 0', () => {
    expect(performanceVsTeam(20, 0).label).toBe('Not Enough Data');
  });
});

describe('homeAwaySplits', () => {
  test('counts and averages each side', () => {
    const games = [
      pg({ isHome: true, points: 30 }),
      pg({ isHome: true, points: 20 }),
      pg({ isHome: false, points: 18 }),
    ];
    const r = homeAwaySplits(games, (g) => g.points);
    expect(r.homeAvg).toBe(25);
    expect(r.awayAvg).toBe(18);
    expect(r.betterLocation).toBe('Home');
    expect(r.homeGames).toBe(2);
    expect(r.awayGames).toBe(1);
  });
});

describe('calculateAdvancedStats', () => {
  test('full report shape', () => {
    const vsTeam = [
      pg({ isHome: true, points: 30, rebounds: 11, assists: 12 }),  // TD
      pg({ isHome: false, points: 22, rebounds: 10, assists: 4 }),  // DD
      pg({ isHome: true, points: 25, rebounds: 11, assists: 6 }),   // DD
    ];
    const season = vsTeam;
    const r = calculateAdvancedStats(vsTeam, season, 'points');
    expect(r.selectedStat).toBe('points');
    expect(r.gamesAnalyzed).toBe(3);
    expect(r.doubleDouble.count).toBe(3);
    expect(r.doubleDouble.rate).toBe(100);
    expect(r.tripleDouble.count).toBe(1);
    expect(r.tripleDouble.rate).toBe(33);
    expect(r.consistency.score).toBeGreaterThan(0);
    expect(r.homeAway.homeGames).toBe(2);
    expect(r.homeAway.awayGames).toBe(1);
    expect(r.performanceVsTeam.label).toBeDefined();
  });

  test('PRA selectedStat sums correctly', () => {
    const games = [pg({ points: 30, rebounds: 10, assists: 5 }), pg({ points: 20, rebounds: 6, assists: 7 })];
    const r = calculateAdvancedStats(games, games, 'PRA');
    // Both vs-team and season are same set, performanceVsTeam should be ~0% diff
    expect(r.performanceVsTeam.label).toBe('About Average');
  });
});
