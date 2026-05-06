import { describe, expect, test } from 'vitest';
import {
  calculateConsistencyScore,
  calculateTrendDirection,
  calculatePlayerVsTeam,
  calculatePlayerVsPlayer,
  calculateTeamVsTeam,
  computeHitProbability,
} from './comparisonEngine.js';
import type { PlayerGame, TeamGame } from '../nba/client.js';

describe('calculateConsistencyScore', () => {
  test('returns 100 for identical values', () => {
    expect(calculateConsistencyScore([20, 20, 20])).toBe(100);
  });

  test('returns 0 for empty input', () => {
    expect(calculateConsistencyScore([])).toBe(0);
  });

  test('lower for higher variance', () => {
    const stable = calculateConsistencyScore([20, 21, 19, 20, 21]);
    const wild = calculateConsistencyScore([5, 35, 10, 30, 15]);
    expect(stable).toBeGreaterThan(wild);
  });

  test('clamps to 0-100', () => {
    const result = calculateConsistencyScore([1, 100, 1, 100]);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });
});

describe('calculateTrendDirection', () => {
  test('Stable for too few values', () => {
    expect(calculateTrendDirection([10, 20])).toBe('Stable');
  });

  test('Trending Up when second half higher', () => {
    // values are most-recent-first per NBA API; engine reverses internally.
    // [30,30,10,10] → chronological [10,10,30,30] → trending up
    expect(calculateTrendDirection([30, 30, 10, 10])).toBe('Trending Up');
  });

  test('Trending Down when second half lower', () => {
    expect(calculateTrendDirection([10, 10, 30, 30])).toBe('Trending Down');
  });

  test('Stable when within 10% band', () => {
    expect(calculateTrendDirection([20, 21, 19, 20])).toBe('Stable');
  });
});

function pgame(overrides: Partial<PlayerGame> = {}): PlayerGame {
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
    steals: 1,
    blocks: 1,
    turnovers: 3,
    fgm: 9, fga: 18, fg3m: 2, fg3a: 5, ftm: 5, fta: 6,
    fgPct: 0.5, fg3Pct: 0.4, ftPct: 0.85,
    pf: 2,
    ...overrides,
  };
}

describe('calculatePlayerVsTeam', () => {
  test('filters games by opponent abbreviation', () => {
    const games = [
      pgame({ gameId: '1', opponentAbbr: 'DEN', points: 30 }),
      pgame({ gameId: '2', opponentAbbr: 'BOS', points: 10 }),
      pgame({ gameId: '3', opponentAbbr: 'DEN', points: 20 }),
    ];
    const r = calculatePlayerVsTeam(games, 'DEN', { range: 'season', playerId: 1, teamId: 2 });
    expect(r.gamesAgainstTeam).toHaveLength(2);
    expect(r.vsTeam.points.avg).toBe(25);
    expect(r.seasonAverage.points).toBe(20);
    expect(r.delta.points).toBe(5);
  });

  test('respects last5 range', () => {
    const games = Array.from({ length: 10 }, (_, i) =>
      pgame({ gameId: `g${i}`, opponentAbbr: 'DEN', points: i * 2 }),
    );
    const r = calculatePlayerVsTeam(games, 'DEN', { range: 'last5', playerId: 1, teamId: 2 });
    expect(r.gamesAgainstTeam).toHaveLength(5);
  });
});

describe('calculatePlayerVsPlayer', () => {
  test('produces independent summaries with delta', () => {
    const a = [pgame({ points: 30 }), pgame({ points: 30 })];
    const b = [pgame({ points: 20 }), pgame({ points: 20 })];
    const r = calculatePlayerVsPlayer(a, b, 'season');
    expect(r.a.summaries.points.avg).toBe(30);
    expect(r.b.summaries.points.avg).toBe(20);
    expect(r.delta.points).toBe(10);
  });
});

function tgame(overrides: Partial<TeamGame> = {}): TeamGame {
  return {
    gameId: 'g',
    date: '2025-01-01',
    matchup: 'LAL vs. DEN',
    opponentAbbr: 'DEN',
    isHome: true,
    result: 'W',
    points: 110,
    rebounds: 45,
    assists: 25,
    steals: 7,
    blocks: 5,
    turnovers: 14,
    fgm: 40, fga: 85, fg3m: 12, fg3a: 33, ftm: 18, fta: 24,
    fgPct: 0.48, fg3Pct: 0.36, ftPct: 0.78,
    pf: 18,
    ...overrides,
  };
}

describe('calculateTeamVsTeam', () => {
  test('summarizes both teams over chosen range', () => {
    const a = [tgame({ points: 110 }), tgame({ points: 120 })];
    const b = [tgame({ points: 100 }), tgame({ points: 90 })];
    const r = calculateTeamVsTeam(a, b, 'season');
    expect(r.a.summaries.points.avg).toBe(115);
    expect(r.b.summaries.points.avg).toBe(95);
    expect(r.delta.points).toBe(20);
  });
});

describe('computeHitProbability', () => {
  test('blend matches reference example (spec acceptance criterion)', () => {
    const r = computeHitProbability([20, 21, 28, 19, 17, 13, 17, 18, 26, 20], 14.5);
    expect(r.lean).toBe('OVER');
    expect(r.mightHitPct).toBe(90);
    expect(r.hitOver).toBeCloseTo(0.9, 3);
  });

  test('extreme line above all values leans UNDER 100%', () => {
    const r = computeHitProbability([10, 12, 11, 9, 13], 100);
    expect(r.lean).toBe('UNDER');
    expect(r.mightHitPct).toBeGreaterThanOrEqual(95);
  });

  test('identical values do not divide by zero', () => {
    const r = computeHitProbability([20, 20, 20, 20, 20], 14.5);
    expect(r.lean).toBe('OVER');
    expect(Number.isFinite(r.pOver)).toBe(true);
  });

  test('empty input returns coin-flip', () => {
    const r = computeHitProbability([], 10);
    expect(r.mightHitPct).toBe(50);
  });
});
