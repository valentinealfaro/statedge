import { describe, expect, test } from 'vitest';
import { computeCalibration, type CalibrationInput } from './slateCalibration.js';
import type { GradedCombo, GradedLeg } from './slateGrade.js';

function leg(over: Partial<GradedLeg>): GradedLeg {
  return {
    playerId: 1,
    playerName: 'P',
    team: 'NYK',
    opponentAbbr: 'PHI',
    statKey: 'points',
    statLabel: 'Points',
    line: 22.5,
    direction: 'OVER',
    probability: 70,
    actual: 28,
    outcome: 'hit',
    ...over,
  };
}

function combo(legs: GradedLeg[]): GradedCombo {
  return {
    label: 'Best 6',
    tag: 'safe',
    legs,
    predictedHit: 60,
    status: 'won',
    hitCount: legs.filter((l) => l.outcome !== 'miss').length,
    missCount: legs.filter((l) => l.outcome === 'miss').length,
    pendingCount: 0,
  };
}

function snap(date: string, legs: GradedLeg[]): CalibrationInput {
  return { date, results: [combo(legs)] };
}

describe('computeCalibration', () => {
  test('empty input → zero report', () => {
    const r = computeCalibration([]);
    expect(r.legsAnalyzed).toBe(0);
    expect(r.daysAnalyzed).toBe(0);
    expect(r.overall.sampleSize).toBe(0);
  });

  test('aggregates predicted vs actual correctly', () => {
    // 2 legs at 70% predicted; 1 hit, 1 miss → actual hit rate 50%
    const r = computeCalibration([
      snap('2026-05-01', [
        leg({ probability: 70, outcome: 'hit', playerId: 1, statKey: 'points' }),
        leg({ probability: 70, outcome: 'miss', playerId: 2, statKey: 'rebounds' }),
      ]),
    ]);
    expect(r.legsAnalyzed).toBe(2);
    expect(r.overall.predictedAvg).toBe(70);
    expect(r.overall.actualHitRate).toBe(50);
    expect(r.overall.gap).toBe(20);     // overconfident
  });

  test('push counts as hit', () => {
    const r = computeCalibration([
      snap('2026-05-01', [
        leg({ probability: 60, outcome: 'push', playerId: 1, statKey: 'points' }),
      ]),
    ]);
    expect(r.overall.actualHitRate).toBe(100);
  });

  test('no_game / unknown_stat outcomes excluded', () => {
    const r = computeCalibration([
      snap('2026-05-01', [
        leg({ probability: 70, outcome: 'hit', playerId: 1, statKey: 'points' }),
        leg({ probability: 70, outcome: 'no_game', playerId: 2, statKey: 'rebounds' }),
        leg({ probability: 70, outcome: 'unknown_stat', playerId: 3, statKey: 'assists' }),
      ]),
    ]);
    expect(r.legsAnalyzed).toBe(1);     // only the 'hit' leg counts
  });

  test('dedupes legs that appear on multiple cards in the same day', () => {
    // Same leg on Best 6 and Best 5 — should count once.
    const sharedLeg = leg({ probability: 80, outcome: 'hit', playerId: 1, statKey: 'points', line: 22.5, direction: 'OVER' });
    const day: CalibrationInput = {
      date: '2026-05-01',
      results: [
        combo([sharedLeg]),
        combo([sharedLeg]),
        combo([sharedLeg]),
      ],
    };
    const r = computeCalibration([day]);
    expect(r.legsAnalyzed).toBe(1);
  });

  test('buckets picks by probability range', () => {
    const r = computeCalibration([
      snap('2026-05-01', [
        leg({ probability: 55, playerId: 1, statKey: 'points' }),
        leg({ probability: 65, playerId: 2, statKey: 'rebounds' }),
        leg({ probability: 75, playerId: 3, statKey: 'assists' }),
        leg({ probability: 85, playerId: 4, statKey: 'three_pt_made' }),
        leg({ probability: 95, playerId: 5, statKey: 'steals' }),
      ]),
    ]);
    const labels = r.byProbability.filter((b) => b.sampleSize > 0).map((b) => b.label);
    expect(labels).toEqual(['50-59%', '60-69%', '70-79%', '80-89%', '90-100%']);
  });

  test('range start/end track first and last graded date', () => {
    const r = computeCalibration([
      snap('2026-05-01', [leg({ playerId: 1 })]),
      snap('2026-05-03', [leg({ playerId: 2 })]),
      snap('2026-05-02', [leg({ playerId: 3 })]),
    ]);
    expect(r.rangeStart).toBe('2026-05-01');
    expect(r.rangeEnd).toBe('2026-05-03');
    expect(r.daysAnalyzed).toBe(3);
  });
});
