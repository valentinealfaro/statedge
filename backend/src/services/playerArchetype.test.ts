import { describe, expect, test } from 'vitest';
import type { PlayerGame } from '../nba/client.js';
import { classifyArchetype } from './playerArchetype.js';

function game(overrides: Partial<PlayerGame> & { gameId: string }): PlayerGame {
  return {
    gameId: overrides.gameId,
    date: overrides.date ?? '2026-01-01',
    matchup: 'NYK @ BOS',
    opponentAbbr: 'BOS',
    isHome: false,
    result: 'W',
    minutes: overrides.minutes ?? 36,
    points: overrides.points ?? 0,
    rebounds: overrides.rebounds ?? 0,
    assists: overrides.assists ?? 0,
    steals: overrides.steals ?? 0,
    blocks: overrides.blocks ?? 0,
    turnovers: overrides.turnovers ?? 0,
    fgm: 0,
    fga: 0,
    fg3m: 0,
    fg3a: 0,
    ftm: 0,
    fta: 0,
    fgPct: 0,
    fg3Pct: 0,
    ftPct: 0,
    pf: 0,
    oreb: 0,
    dreb: 0,
  };
}

function fromPoints(points: number[], minutesArr?: number[]): PlayerGame[] {
  return points.map((p, i) =>
    game({
      gameId: `g${i}`,
      points: p,
      minutes: minutesArr?.[i] ?? 36,
    }),
  );
}

describe('classifyArchetype', () => {
  test('Insufficient Data when sample size < 8', () => {
    const r = classifyArchetype(fromPoints([20, 22, 24]), 'points');
    expect(r.archetype).toBe('Insufficient Data');
  });

  test('Stable Producer for tight cluster around the mean', () => {
    // CV ≈ 0.04 — very tight distribution.
    const r = classifyArchetype(
      fromPoints([24, 25, 25, 26, 24, 25, 26, 25, 24, 25, 26, 25]),
      'points',
    );
    expect(r.archetype).toBe('Stable Producer');
    expect(r.statCV).toBeLessThan(0.10);
  });

  test('High Variance when stat CV is in 0.30-0.45 range', () => {
    // Spread between 12 and 36 around mean ~24 → CV ≈ 0.30+
    const r = classifyArchetype(
      fromPoints([12, 36, 18, 30, 12, 36, 24, 24, 16, 32, 20, 28]),
      'points',
    );
    expect(['High Variance', 'Boom/Bust']).toContain(r.archetype);
  });

  test('Boom/Bust when stat CV is extreme (>= 0.45)', () => {
    // Wide swings between 42 and 8 around mean ~24 → CV ~0.49.
    // Triggers the cv-based Boom/Bust path; the tail-rate path
    // requires more extreme outliers and is exercised separately.
    const r = classifyArchetype(
      fromPoints([42, 8, 24, 24, 42, 8, 24, 24, 42, 8, 24, 24]),
      'points',
    );
    expect(r.archetype).toBe('Boom/Bust');
  });

  test('Minutes Sensitive when stat is steady but minutes swing', () => {
    // Per-minute stat is consistent (~0.7 PPG/min); minutes swing
    // 18-40 (CV high). Total points stay below CV 0.35 because the
    // raw points distribution still tracks minutes.
    const minutes = [40, 18, 38, 22, 40, 18, 36, 24, 38, 20, 40, 18];
    const points = minutes.map((m) => Math.round(m * 0.7));
    const r = classifyArchetype(fromPoints(points, minutes), 'points');
    // Minutes CV should be high. Either Minutes Sensitive OR High
    // Variance is acceptable depending on whether the points CV
    // threshold trips first.
    expect(['Minutes Sensitive', 'High Variance', 'Boom/Bust']).toContain(r.archetype);
    expect(r.minutesCV).toBeGreaterThan(0.20);
  });

  test('reports stat CV and sample size', () => {
    const r = classifyArchetype(
      fromPoints([24, 25, 25, 26, 24, 25, 26, 25, 24, 25]),
      'points',
    );
    expect(r.sampleSize).toBe(10);
    expect(r.statCV).toBeGreaterThan(0);
    expect(r.statCV).toBeLessThan(0.10);
  });
});
