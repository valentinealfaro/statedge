import { describe, expect, test } from 'vitest';
import type { PlayerGame } from '../nba/client.js';
import type { Combo } from './slateCombos.js';
import { gradeCombo, gradeLeg } from './slateGrade.js';

function game(overrides: Partial<PlayerGame> = {}): PlayerGame {
  return {
    gameId: 'g1',
    date: '2026-05-06',
    matchup: 'NYK vs. PHI',
    opponentAbbr: 'PHI',
    isHome: true,
    result: 'W',
    minutes: 36,
    points: 28,
    rebounds: 5,
    oreb: 1,
    dreb: 4,
    assists: 7,
    steals: 1,
    blocks: 0,
    turnovers: 3,
    fgm: 10,
    fga: 20,
    fg3m: 3,
    fg3a: 7,
    ftm: 5,
    fta: 6,
    fgPct: 0.5,
    fg3Pct: 0.43,
    ftPct: 0.83,
    pf: 2,
    ...overrides,
  };
}

const baseLeg = {
  playerId: 1,
  playerName: 'Test Player',
  team: 'NYK',
  opponentAbbr: 'PHI',
  gameKey: 'NYK-PHI',
  statKey: 'points' as const,
  statLabel: 'Points',
  probability: 75,
  confidence: 70,
  risk: 50,
  edgeScore: 60,
  projection: 28,
  confidenceLabel: 'Strong',
  slateScore: 60,
  l10Avg: 26,
  vsOppAvg: null,
  injuryStatus: null,
  last10HitCount: 6,
  last10HitRate: 60,
  vsOpponentGames: 2,
  vsOpponentHitCount: 1,
  vsOpponentHitRate: 50,
  statVolatility: 0.2,
};

describe('gradeLeg', () => {
  test('OVER hit when actual > line', () => {
    const r = gradeLeg(
      { ...baseLeg, line: 22.5, direction: 'OVER' },
      [game({ points: 28 })],
      '2026-05-06',
    );
    expect(r.outcome).toBe('hit');
    expect(r.actual).toBe(28);
  });

  test('OVER miss when actual < line', () => {
    const r = gradeLeg(
      { ...baseLeg, line: 30.5, direction: 'OVER' },
      [game({ points: 28 })],
      '2026-05-06',
    );
    expect(r.outcome).toBe('miss');
  });

  test('UNDER hit when actual < line', () => {
    const r = gradeLeg(
      { ...baseLeg, line: 30.5, direction: 'UNDER' },
      [game({ points: 28 })],
      '2026-05-06',
    );
    expect(r.outcome).toBe('hit');
  });

  test('push when actual exactly equals line', () => {
    const r = gradeLeg(
      { ...baseLeg, line: 28, direction: 'OVER' },
      [game({ points: 28 })],
      '2026-05-06',
    );
    expect(r.outcome).toBe('push');
  });

  test('no_game when no game on slate date', () => {
    const r = gradeLeg(
      { ...baseLeg, line: 22.5, direction: 'OVER' },
      [game({ date: '2026-05-04', points: 30 })],
      '2026-05-06',
    );
    expect(r.outcome).toBe('no_game');
    expect(r.actual).toBeNull();
  });

  test('double_double OVER hit when player had a DD', () => {
    const r = gradeLeg(
      {
        ...baseLeg,
        statKey: 'double_double',
        line: 0.5,
        direction: 'OVER',
      },
      [game({ points: 24, rebounds: 11 })],
      '2026-05-06',
    );
    expect(r.outcome).toBe('hit');
    expect(r.actual).toBe(1);
  });

  test('double_double OVER miss when no DD', () => {
    const r = gradeLeg(
      {
        ...baseLeg,
        statKey: 'double_double',
        line: 0.5,
        direction: 'OVER',
      },
      [game({ points: 24, rebounds: 8, assists: 9 })],
      '2026-05-06',
    );
    expect(r.outcome).toBe('miss');
  });
});

describe('gradeCombo parlay status', () => {
  const combo: Combo = {
    label: 'Best 2',
    subtitle: 'Safest Core',
    tag: 'safe',
    rawCombinedHit: 60,
    adjustedCombinedHit: 60,
    correlationRisk: 'None',
    warnings: [],
    legs: [
      { ...baseLeg, line: 22.5, direction: 'OVER', playerId: 1 },
      { ...baseLeg, line: 5.5, direction: 'OVER', playerId: 2, statKey: 'rebounds', statLabel: 'Rebounds' },
    ],
  };

  test('all hits → won', () => {
    const games = new Map<number, PlayerGame[]>([
      [1, [game({ points: 28 })]],
      [2, [game({ rebounds: 9 })]],
    ]);
    const g = gradeCombo(combo, games, '2026-05-06');
    expect(g.status).toBe('won');
    expect(g.hitCount).toBe(2);
  });

  test('one miss → lost', () => {
    const games = new Map<number, PlayerGame[]>([
      [1, [game({ points: 28 })]],
      [2, [game({ rebounds: 3 })]],
    ]);
    const g = gradeCombo(combo, games, '2026-05-06');
    expect(g.status).toBe('lost');
    expect(g.hitCount).toBe(1);
    expect(g.missCount).toBe(1);
  });

  test('one missing game, no misses → pending', () => {
    const games = new Map<number, PlayerGame[]>([
      [1, [game({ points: 28 })]],
      // playerId 2 has no game on slate date
      [2, []],
    ]);
    const g = gradeCombo(combo, games, '2026-05-06');
    expect(g.status).toBe('pending');
    expect(g.pendingCount).toBe(1);
  });

  test('miss takes precedence over pending', () => {
    const games = new Map<number, PlayerGame[]>([
      [1, [game({ points: 5 })]], // miss
      [2, []],                     // pending
    ]);
    const g = gradeCombo(combo, games, '2026-05-06');
    expect(g.status).toBe('lost');
  });

  test('push counts as survival, not loss', () => {
    const games = new Map<number, PlayerGame[]>([
      [1, [game({ points: 22.5 })]], // push (treat as numeric equality)
      [2, [game({ rebounds: 9 })]],   // hit
    ]);
    const g = gradeCombo(combo, games, '2026-05-06');
    expect(g.status).toBe('won');
    // hitCount counts pushes too:
    expect(g.hitCount).toBe(2);
  });
});
