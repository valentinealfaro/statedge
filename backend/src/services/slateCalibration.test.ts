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

  test('aggregates predicted vs actual correctly with Bayesian smoothing', () => {
    // 2 legs at 70% predicted; 1 hit, 1 miss. Raw actual = 50%.
    // Smoothed = (1 + 11) / (2 + 20) = 12/22 ≈ 54.5%.
    // Calibration error = 70 - 54.5 = 15.5 (overconfident).
    const r = computeCalibration([
      snap('2026-05-01', [
        leg({ probability: 70, outcome: 'hit', playerId: 1, statKey: 'points' }),
        leg({ probability: 70, outcome: 'miss', playerId: 2, statKey: 'rebounds' }),
      ]),
    ]);
    expect(r.legsAnalyzed).toBe(2);
    expect(r.overall.predictedAvg).toBe(70);
    expect(r.overall.actualHitRate).toBe(50);          // raw
    expect(r.overall.smoothedHitRate).toBeCloseTo(54.5, 0);
    expect(r.overall.calibrationError).toBeCloseTo(15.5, 0);
    expect(r.overall.gap).toBeCloseTo(15.5, 0);         // legacy alias
    expect(r.overall.sampleConfidence).toBe('Experimental');
    // 15.5 falls in the Poor Calibration range (13-20).
    expect(r.overall.status).toBe('Poor Calibration');
  });

  test('Bayesian smoothing pulls 1/1 toward the prior (not 100%)', () => {
    const r = computeCalibration([
      snap('2026-05-01', [
        leg({ probability: 80, outcome: 'hit', playerId: 1, statKey: 'points' }),
      ]),
    ]);
    // Raw 100%, smoothed (1 + 11) / (1 + 20) ≈ 57.1%.
    expect(r.overall.actualHitRate).toBe(100);
    expect(r.overall.smoothedHitRate).toBeCloseTo(57.1, 0);
  });

  test('Bayesian smoothing pulls 0/1 toward the prior (not 0%)', () => {
    const r = computeCalibration([
      snap('2026-05-01', [
        leg({ probability: 70, outcome: 'miss', playerId: 1, statKey: 'points' }),
      ]),
    ]);
    // Raw 0%, smoothed (0 + 11) / (1 + 20) ≈ 52.4%.
    expect(r.overall.actualHitRate).toBe(0);
    expect(r.overall.smoothedHitRate).toBeCloseTo(52.4, 0);
  });

  test('push counts as hit', () => {
    const r = computeCalibration([
      snap('2026-05-01', [
        leg({ probability: 60, outcome: 'push', playerId: 1, statKey: 'points' }),
      ]),
    ]);
    expect(r.overall.actualHitRate).toBe(100);
  });

  test('sampleConfidence reports tier from sample size', () => {
    // Single-leg sample → Experimental
    const r1 = computeCalibration([snap('2026-05-01', [leg({})])]);
    expect(r1.overall.sampleConfidence).toBe('Experimental');
    // 25 legs → Low Confidence
    const day25: CalibrationInput = {
      date: '2026-05-01',
      results: [
        combo(
          Array.from({ length: 25 }, (_, i) => leg({ playerId: i + 1, statKey: 'points' })),
        ),
      ],
    };
    const r25 = computeCalibration([day25]);
    expect(r25.overall.sampleConfidence).toBe('Low Confidence');
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

  test('tolerates legacy snapshots that use `pct` instead of `probability`', () => {
    // Pre-rewrite snapshots stored the predicted hit % under `pct`.
    // Without legacy-shape tolerance, these legs surface as undefined
    // probabilities, the bucket math NaN-cascades, and the JSON
    // response carries `null` numerics that crash the frontend.
    const legacyDay: CalibrationInput = {
      date: '2026-05-01',
      results: [
        {
          label: 'Best 6',
          tag: 'safe',
          legs: [
            // Legacy shape: pct present, probability missing.
            {
              playerId: 1,
              playerName: 'Legacy Player',
              team: 'NYK',
              opponentAbbr: 'PHI',
              statKey: 'points',
              statLabel: 'Points',
              line: 22.5,
              direction: 'OVER',
              pct: 70,
              actual: 28,
              outcome: 'hit',
            } as unknown as GradedLeg,
          ],
          predictedHit: 70,
          status: 'won',
          hitCount: 1,
          missCount: 0,
          pendingCount: 0,
        },
      ],
    };
    const r = computeCalibration([legacyDay]);
    expect(r.legsAnalyzed).toBe(1);
    expect(r.overall.predictedAvg).toBe(70);
    expect(r.overall.actualHitRate).toBe(100);
    // Crucially: no NaN. Math.round(NaN * ...) is NaN; JSON would
    // serialize that as null and crash the client's .toFixed().
    expect(Number.isFinite(r.overall.gap)).toBe(true);
  });

  test('buckets picks by risk tier when risk is present on legs', () => {
    const r = computeCalibration([
      snap('2026-05-01', [
        leg({ probability: 70, outcome: 'hit', playerId: 1, statKey: 'points', risk: 30 }),  // Low
        leg({ probability: 70, outcome: 'miss', playerId: 2, statKey: 'rebounds', risk: 50 }), // Medium
        leg({ probability: 70, outcome: 'hit', playerId: 3, statKey: 'assists', risk: 70 }),   // High
        leg({ probability: 70, outcome: 'miss', playerId: 4, statKey: 'steals', risk: 90 }),   // Extreme
      ]),
    ]);
    const populated = r.byRisk.filter((b) => b.sampleSize > 0).map((b) => b.label);
    expect(populated).toEqual(['Low Risk', 'Medium Risk', 'High Risk', 'Extreme Risk']);
  });

  test('legs without risk are excluded from byRisk panel', () => {
    const r = computeCalibration([
      snap('2026-05-01', [leg({ probability: 70, outcome: 'hit', playerId: 1 })]),
    ]);
    expect(r.byRisk.every((b) => b.sampleSize === 0)).toBe(true);
  });

  test('byArchetype groups legs by archetype label', () => {
    const r = computeCalibration([
      snap('2026-05-01', [
        leg({ probability: 70, outcome: 'hit', playerId: 1, archetype: 'Stable Producer' }),
        leg({ probability: 70, outcome: 'miss', playerId: 2, archetype: 'Stable Producer' }),
        leg({ probability: 70, outcome: 'hit', playerId: 3, archetype: 'Boom/Bust' }),
        leg({ probability: 70, outcome: 'miss', playerId: 4, archetype: 'Boom/Bust' }),
      ]),
    ]);
    const labels = r.byArchetype.map((b) => b.label);
    expect(labels).toContain('Stable Producer');
    expect(labels).toContain('Boom/Bust');
    const stable = r.byArchetype.find((b) => b.label === 'Stable Producer')!;
    expect(stable.sampleSize).toBe(2);
  });

  test('byArchetype is empty when legs have no archetype', () => {
    const r = computeCalibration([
      snap('2026-05-01', [leg({ probability: 70, outcome: 'hit', playerId: 1 })]),
    ]);
    expect(r.byArchetype).toEqual([]);
  });

  test('projectionError reports mean miss + over/under bias', () => {
    // 4 legs: actual − projected = +2, -3, +1, -4. Mean = -1.
    // Mean absolute = 2.5. 2 over-projected (negative), 2 under (positive).
    const legs = [
      leg({ probability: 70, outcome: 'hit', playerId: 1, projection: 26, actual: 28 }),
      leg({ probability: 70, outcome: 'miss', playerId: 2, projection: 28, actual: 25 }),
      leg({ probability: 70, outcome: 'hit', playerId: 3, projection: 24, actual: 25 }),
      leg({ probability: 70, outcome: 'miss', playerId: 4, projection: 30, actual: 26 }),
    ];
    const r = computeCalibration([snap('2026-05-01', legs)]);
    expect(r.projectionError).not.toBeNull();
    expect(r.projectionError!.sampleSize).toBe(4);
    expect(r.projectionError!.meanMiss).toBe(-1.0);          // signed
    expect(r.projectionError!.meanAbsoluteMiss).toBe(2.5);
    expect(r.projectionError!.underProjectionRate).toBe(50); // 2/4
    expect(r.projectionError!.overProjectionRate).toBe(50);
  });

  test('projectionError null when no legs carry projection + actual', () => {
    const r = computeCalibration([
      snap('2026-05-01', [leg({ probability: 70, outcome: 'hit', playerId: 1 })]),
    ]);
    expect(r.projectionError).toBeNull();
  });

  test('projectionError excludes double_double legs', () => {
    // DD legs have actual=0/1 binary — no meaningful unit gap.
    const legs = [
      leg({
        probability: 70, outcome: 'hit', playerId: 1,
        statKey: 'double_double', projection: 0.6, actual: 1,
      }),
    ];
    const r = computeCalibration([snap('2026-05-01', legs)]);
    expect(r.projectionError).toBeNull();
  });

  test('series emits one point per slate date, oldest first', () => {
    const r = computeCalibration([
      snap('2026-05-03', [leg({ probability: 70, outcome: 'hit', playerId: 1 })]),
      snap('2026-05-01', [leg({ probability: 70, outcome: 'miss', playerId: 2 })]),
      snap('2026-05-02', [leg({ probability: 70, outcome: 'hit', playerId: 3 })]),
    ]);
    expect(r.series.map((p) => p.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
    expect(r.series.every((p) => Number.isFinite(p.smoothedHitRate))).toBe(true);
  });

  test('series is empty when no legs are graded', () => {
    const r = computeCalibration([]);
    expect(r.series).toEqual([]);
  });

  test('windows.last7Days only includes legs within 7 calendar days of rangeEnd', () => {
    const days = (n: number, outcome: 'hit' | 'miss') => snap(`2026-05-${String(n).padStart(2, '0')}`, [
      leg({ probability: 70, outcome, playerId: n + 100 }),
    ]);
    // 10 legs across 10 days (May 1-10). With rangeEnd = 2026-05-10
    // and a 7-day window, we expect the legs from 2026-05-04 → 10
    // (7 days inclusive).
    const r = computeCalibration([
      days(1, 'miss'), days(2, 'miss'), days(3, 'miss'),
      days(4, 'hit'), days(5, 'hit'), days(6, 'hit'),
      days(7, 'hit'), days(8, 'hit'), days(9, 'hit'),
      days(10, 'hit'),
    ]);
    expect(r.rangeEnd).toBe('2026-05-10');
    expect(r.windows.last7Days.sampleSize).toBe(7);
    // Last 7 days legs are all 'hit' (May 4-10) → raw 100%, smoothed
    // toward the prior. Earlier days (May 1-3) outside the window.
    expect(r.windows.last7Days.actualHitRate).toBe(100);
  });

  test('windows.last100Picks bounds by leg count not days', () => {
    // 150 graded legs across many days → last100Picks should have
    // exactly 100, last500Picks should have all 150.
    const legs150 = Array.from({ length: 150 }, (_, i) =>
      snap(
        `2026-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        [leg({ probability: 70, outcome: 'hit', playerId: i + 1 })],
      ),
    );
    const r = computeCalibration(legs150);
    expect(r.windows.last100Picks.sampleSize).toBe(100);
    expect(r.windows.last500Picks.sampleSize).toBe(150);
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
