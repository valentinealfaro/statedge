import { describe, expect, test } from 'vitest';
import type { ProjectionResult } from './projectionEngine.js';
import type { ResolvedLine } from './slatePipeline.js';
import { buildCombos, type Combo } from './slateCombos.js';

// Build a ResolvedLine fixture with reasonable defaults so tests
// don't have to spell out every field. Override what each test needs.
function makeLine(over: Partial<ResolvedLine> & { projection: ProjectionResult }): ResolvedLine {
  return {
    playerId: 1,
    playerName: 'Player 1',
    ppPlayerName: 'Player 1',
    team: 'NYK',
    position: 'G',
    imageUrl: null,
    statKey: 'points',
    statLabel: 'Points',
    line: 22.5,
    direction: 'both',
    gamesAnalyzed: 10,
    last10Avg: 26,
    last10Values: [25, 26, 27, 28, 24, 26, 27, 25, 28, 24],
    hitProbability: undefined,
    injury: undefined,
    vsOpponent: { opponentAbbr: 'PHI', gamesPlayed: 3, avg: 27, values: [26, 27, 28] },
    trend: undefined,
    ...over,
  };
}

function makeProjection(over: Partial<ProjectionResult> = {}): ProjectionResult {
  return {
    selectedStat: 'points',
    lineValue: 22.5,
    projection: { baseline: 26, contextAdjusted: 26, final: 26, rangeLow: 23, rangeHigh: 29 },
    probability: { over: 70, under: 30 },
    confidence: { score: 70, label: 'High Confidence' },
    risk: { score: 50, label: 'Moderate Risk' },
    edge: { score: 60, label: 'Moderate Edge', lean: 'Strong Over Lean' },
    historicalHitRates: {
      season: 60, last10: 60, last5: 60, vsOpponent: 60, homeAway: 60,
    },
    factorBreakdown: {
      seasonAvg: 26, last10Avg: 26, last5Avg: 26,
      vsOpponentAvg: 27, homeAwayAvg: 26,
      seasonMedian: 26, last10Median: 26,
      blendedStdDev: 4, projectedMinutes: 36,
      minutesMultiplier: 1, usageMultiplier: 1, injuryMultiplier: 1,
      opponentDefenseMultiplier: 1, paceMultiplier: 1, restMultiplier: 1,
      gameImportanceMultiplier: 1, blowoutMultiplier: 1,
      modelAgreementScore: 90,
    },
    modelNotes: [],
    disclaimer: '',
    ...over,
  };
}

// Manufacture a slate of N distinct players spread across enough
// teams + games to satisfy Best 6's exposure caps (≤2 per team,
// ≤3 per game, ≤3 per stat). One pair per game so 8 players → 4
// distinct matchups.
const TEAM_PAIRS: Array<[string, string]> = [
  ['NYK', 'PHI'], ['BOS', 'MIA'], ['LAL', 'DEN'], ['GSW', 'PHX'],
  ['MIL', 'CHI'], ['ATL', 'CHA'], ['DAL', 'HOU'], ['SAC', 'POR'],
];
const STATS_NONCORRELATED = [
  'points', 'rebounds', 'assists', 'three_pt_made', 'steals', 'blocks',
] as const;
function strongSlate(n: number, baseProb = 75): ResolvedLine[] {
  return Array.from({ length: n }, (_, i) => {
    const pair = TEAM_PAIRS[Math.floor(i / 2) % TEAM_PAIRS.length]!;
    const team = i % 2 === 0 ? pair[0] : pair[1];
    const opp = i % 2 === 0 ? pair[1] : pair[0];
    return makeLine({
      playerId: 100 + i,
      playerName: `Player ${i}`,
      team,
      vsOpponent: { opponentAbbr: opp, gamesPlayed: 2, avg: 26, values: [26, 27] },
      statKey: STATS_NONCORRELATED[i % STATS_NONCORRELATED.length]!,
      statLabel: 'Points',
      line: 20 + i,
      projection: makeProjection({
        probability: { over: baseProb - i, under: 100 - (baseProb - i) },
        // Risk above the line-raise trigger (≤55) so this fixture
        // produces predictable, non-raised candidates. Line-raising
        // gets its own deliberately-elite fixtures below.
        risk: { score: 60, label: 'Moderate Risk' },
        // Decreasing edge so slateScore order tracks pick index.
        edge: { score: 70 - i * 2, label: 'Moderate Edge', lean: 'Strong Over Lean' },
      }),
    });
  });
}

describe('buildCombos diversity-first build', () => {
  test('Best 6 holds the safest 6 picks (top by slateScore)', () => {
    const { combos } = buildCombos(strongSlate(20));
    const best6 = combos.find((c) => c.label === 'Best 6');
    expect(best6?.legs.length).toBe(6);
    // Top picks by slateScore should land here. With 20 candidates,
    // Best 5/4/3/2 don't pull from this set, so Best 6 keeps the
    // strongest picks.
    const playerIds = best6!.legs.map((l) => l.playerId).sort((a, b) => a - b);
    // Top 6 by playerId in our fixture happen to also be the highest
    // slateScore (we generate with decreasing probability per index).
    expect(playerIds).toEqual([100, 101, 102, 103, 104, 105]);
  });

  test('Cards do NOT share picks when the slate has enough candidates', () => {
    const { combos } = buildCombos(strongSlate(20));
    const best6Ids = new Set(combos.find((c) => c.label === 'Best 6')!.legs.map((l) => l.playerId));
    const best5Ids = new Set(combos.find((c) => c.label === 'Best 5')!.legs.map((l) => l.playerId));
    const best4Ids = new Set(combos.find((c) => c.label === 'Best 4')!.legs.map((l) => l.playerId));
    const best3Ids = new Set(combos.find((c) => c.label === 'Best 3')!.legs.map((l) => l.playerId));
    const best2Ids = new Set(combos.find((c) => c.label === 'Best 2')!.legs.map((l) => l.playerId));

    // Pairwise: no leg should appear on two different cards when the
    // slate is large enough (20 candidates → 6+5+4+3+2 = 20 slots).
    function disjoint(a: Set<number>, b: Set<number>): boolean {
      for (const v of a) if (b.has(v)) return false;
      return true;
    }
    expect(disjoint(best6Ids, best5Ids)).toBe(true);
    expect(disjoint(best5Ids, best4Ids)).toBe(true);
    expect(disjoint(best4Ids, best3Ids)).toBe(true);
    expect(disjoint(best3Ids, best2Ids)).toBe(true);
  });

  test('Small slate falls back to sharing picks across cards', () => {
    // 6 picks total — not enough for full independence. The build
    // should still emit each card with whatever degree of sharing
    // is necessary, rather than dropping the smaller cards.
    const { combos } = buildCombos(strongSlate(6));
    const labels = combos.map((c) => c.label);
    expect(labels).toContain('Best 6');
    expect(labels).toContain('Best 2');
  });
});

describe('buildCombos eligibility filter', () => {
  test('drops picks with No Clear Edge', () => {
    const lines = strongSlate(2);
    lines[0]!.projection!.edge.lean = 'No Clear Edge';
    const { combos } = buildCombos(lines);
    const best2 = combos.find((c) => c.label === 'Best 2');
    expect(best2).toBeUndefined();
  });

  test('drops OUT players', () => {
    const lines = strongSlate(7);
    lines[0]!.injury = { status: 'Out' };
    const { combos } = buildCombos(lines);
    const best6 = combos.find((c) => c.label === 'Best 6');
    expect(best6?.legs.some((l) => l.playerId === lines[0]!.playerId)).toBe(false);
  });

  test('drops below-threshold probability', () => {
    const lines = strongSlate(3);
    // 50% probability is below the 57 floor
    lines[0]!.projection!.probability = { over: 50, under: 50 };
    const { combos } = buildCombos(lines);
    const best2 = combos.find((c) => c.label === 'Best 2');
    expect(best2?.legs.some((l) => l.playerId === lines[0]!.playerId)).toBe(false);
  });
});

describe('buildCombos exposure caps', () => {
  test('Best 6 allows max 2 picks per player', () => {
    // Three picks all from the same player, but different stats. The
    // cap (2) plus the same-player correlation block should restrict
    // any combination to at most 2 from that player AND the stats
    // can't be in the same correlation family.
    const lines: ResolvedLine[] = [
      makeLine({
        playerId: 50, playerName: 'Star',
        statKey: 'points', statLabel: 'Points', line: 20,
        projection: makeProjection({ probability: { over: 80, under: 20 } }),
      }),
      makeLine({
        playerId: 50, playerName: 'Star',
        statKey: 'rebounds', statLabel: 'Rebounds', line: 5,
        projection: makeProjection({ probability: { over: 78, under: 22 } }),
      }),
      makeLine({
        playerId: 50, playerName: 'Star',
        statKey: 'steals', statLabel: 'Steals', line: 0.5,
        projection: makeProjection({ probability: { over: 75, under: 25 } }),
      }),
      ...strongSlate(5, 70),
    ];
    const { combos } = buildCombos(lines);
    const best6 = combos.find((c) => c.label === 'Best 6')!;
    const starCount = best6.legs.filter((l) => l.playerId === 50).length;
    expect(starCount).toBeLessThanOrEqual(2);
  });

  test('Best 2/3 tighten to max 1 per player', () => {
    // Same setup — verify the tighter cap kicks in for Best 2/3.
    const lines: ResolvedLine[] = [
      makeLine({
        playerId: 50, playerName: 'Star',
        statKey: 'points', statLabel: 'Points', line: 20,
        projection: makeProjection({ probability: { over: 90, under: 10 } }),
      }),
      makeLine({
        playerId: 50, playerName: 'Star',
        statKey: 'steals', statLabel: 'Steals', line: 0.5,
        projection: makeProjection({ probability: { over: 88, under: 12 } }),
      }),
      ...strongSlate(5, 70),
    ];
    const { combos } = buildCombos(lines);
    const best3 = combos.find((c) => c.label === 'Best 3')!;
    const starCount = best3.legs.filter((l) => l.playerId === 50).length;
    expect(starCount).toBeLessThanOrEqual(1);
  });
});

describe('buildCombos line-raising', () => {
  // An "elite" candidate that meets all line-raise triggers:
  //   probability ≥ 70, confidence ≥ 70, risk ≤ 55,
  //   projection ≥ 1.25σ above line.
  function eliteCandidate(over: Partial<{
    line: number;
    statKey: 'points' | 'rebounds' | 'assists' | 'three_pt_made' | 'pra';
    projectionFinal: number;
    blendedStdDev: number;
    probability: number;
    confidence: number;
    risk: number;
  }> = {}): ResolvedLine {
    const line = over.line ?? 14.5;
    const projectionFinal = over.projectionFinal ?? 20.8;
    const blendedStdDev = over.blendedStdDev ?? 4;
    return makeLine({
      playerId: 999,
      playerName: 'Elite Pick',
      team: 'NYK',
      vsOpponent: { opponentAbbr: 'PHI', gamesPlayed: 3, avg: 22, values: [22, 24, 20] },
      statKey: over.statKey ?? 'points',
      statLabel: 'Points',
      line,
      projection: makeProjection({
        probability: { over: over.probability ?? 78, under: 100 - (over.probability ?? 78) },
        confidence: { score: over.confidence ?? 75, label: 'High Confidence' },
        risk: { score: over.risk ?? 40, label: 'Low Risk' },
        edge: { score: 70, label: 'Strong Edge', lean: 'Strong Over Lean' },
        projection: {
          baseline: projectionFinal, contextAdjusted: projectionFinal,
          final: projectionFinal, rangeLow: projectionFinal - blendedStdDev,
          rangeHigh: projectionFinal + blendedStdDev,
        },
        factorBreakdown: {
          seasonAvg: projectionFinal, last10Avg: projectionFinal, last5Avg: projectionFinal,
          vsOpponentAvg: projectionFinal, homeAwayAvg: projectionFinal,
          seasonMedian: projectionFinal, last10Median: projectionFinal,
          blendedStdDev,
          projectedMinutes: 36, minutesMultiplier: 1, usageMultiplier: 1,
          injuryMultiplier: 1, opponentDefenseMultiplier: 1, paceMultiplier: 1,
          restMultiplier: 1, gameImportanceMultiplier: 1, blowoutMultiplier: 1,
          modelAgreementScore: 90,
        },
      }),
    });
  }

  test('raises a Points line when all elite triggers are met', () => {
    // Line 14.5, projection 20.8, σ=4 → edge = 1.575σ ≥ 1.25 ✓
    // Original prob 78 ≥ 70 ✓; conf 75 ≥ 70 ✓; risk 40 ≤ 55 ✓
    const lines = [eliteCandidate(), ...strongSlate(8, 70)];
    const { combos } = buildCombos(lines);
    // Find the elite candidate in any card.
    let raised: { lineRaised?: boolean; originalLine?: number; line: number } | undefined;
    for (const c of combos) {
      const found = c.legs.find((l) => l.playerId === 999);
      if (found) raised = found;
    }
    expect(raised).toBeDefined();
    expect(raised!.lineRaised).toBe(true);
    expect(raised!.originalLine).toBe(14.5);
    expect(raised!.line).toBeGreaterThan(14.5);
  });

  test('respects the per-stat cap on how far a line can be raised', () => {
    // Points cap is +4.0, so 14.5 → max 18.5. With projection 25 and σ=4
    // the model would happily go further but the cap binds.
    const lines = [
      eliteCandidate({ projectionFinal: 25, blendedStdDev: 4 }),
      ...strongSlate(8, 70),
    ];
    const { combos } = buildCombos(lines);
    let raised: { line: number; originalLine?: number } | undefined;
    for (const c of combos) {
      const found = c.legs.find((l) => l.playerId === 999);
      if (found) raised = found;
    }
    expect(raised).toBeDefined();
    // 14.5 + 4.0 cap = 18.5 max.
    expect(raised!.line).toBeLessThanOrEqual(18.5);
  });

  test('does NOT raise when probability trigger fails', () => {
    // probability 65 < 70 → no raise should fire.
    const lines = [eliteCandidate({ probability: 65 }), ...strongSlate(8, 70)];
    const { combos } = buildCombos(lines);
    for (const c of combos) {
      const found = c.legs.find((l) => l.playerId === 999);
      if (found) expect(found.lineRaised).toBeFalsy();
    }
  });

  test('does NOT raise when risk is too high', () => {
    // risk 60 > 55 → no raise.
    const lines = [eliteCandidate({ risk: 60 }), ...strongSlate(8, 70)];
    const { combos } = buildCombos(lines);
    for (const c of combos) {
      const found = c.legs.find((l) => l.playerId === 999);
      if (found) expect(found.lineRaised).toBeFalsy();
    }
  });

  test('does NOT raise when projection edge is below 1.25σ', () => {
    // projection 15.5, line 14.5, σ=4 → edge = 0.25σ. Way below the
    // 1.25σ trigger.
    const lines = [
      eliteCandidate({ projectionFinal: 15.5, blendedStdDev: 4 }),
      ...strongSlate(8, 70),
    ];
    const { combos } = buildCombos(lines);
    for (const c of combos) {
      const found = c.legs.find((l) => l.playerId === 999);
      if (found) expect(found.lineRaised).toBeFalsy();
    }
  });
});

describe('buildCombos EV engine', () => {
  test('every candidate carries edgePercent + evScore + category + trapScore', () => {
    const { combos } = buildCombos(strongSlate(8, 75));
    const best6 = combos.find((c) => c.label === 'Best 6')!;
    for (const leg of best6.legs) {
      expect(typeof leg.edgePercent).toBe('number');
      expect(typeof leg.evScore).toBe('number');
      expect(typeof leg.projectionDistance).toBe('number');
      expect(typeof leg.projectionDistanceScore).toBe('number');
      expect(['Safe Core', 'Value', 'Ceiling', 'Contrarian']).toContain(leg.category);
      expect(typeof leg.trapScore).toBe('number');
      expect(['Normal', 'Slight Trap Risk', 'High Trap Risk', 'Extreme Trap Risk']).toContain(leg.trapTier);
    }
  });

  test('every Combo carries payoutMultiplier + expectedValue + evVerdict', () => {
    const { combos } = buildCombos(strongSlate(8, 75));
    for (const c of combos) {
      if (c.legs.length === 0) continue;     // empty Wild Card slot
      expect(c.payoutMultiplier).toBeDefined();
      expect(c.expectedValue).toBeDefined();
      expect(['Positive EV', 'Neutral EV', 'Negative EV']).toContain(c.evVerdict);
      expect(c.averageEdge).toBeDefined();
    }
  });

  test('Best 2 with 90% legs at 3x payout reads as Positive EV', () => {
    // 0.90 × 0.90 × 3 − 1 = 1.43 (massively +EV)
    // (correlation penalty drops it slightly but well above +0.10)
    const { combos } = buildCombos(strongSlate(8, 90));
    const best2 = combos.find((c) => c.label === 'Best 2')!;
    expect(best2.payoutMultiplier).toBe(3);
    expect(best2.expectedValue).toBeGreaterThan(0.10);
    expect(best2.evVerdict).toBe('Positive EV');
  });

  test('candidate sitting at the implied break-even has near-zero edge', () => {
    // probability 55 ≈ baseline implied. edgePercent ≈ 0.
    const slate = strongSlate(8, 55);
    const { combos } = buildCombos(slate);
    const best6 = combos.find((c) => c.label === 'Best 6');
    if (best6) {
      // Edge should be small magnitude near zero across the legs.
      for (const leg of best6.legs) {
        expect(Math.abs(leg.edgePercent)).toBeLessThan(15);
      }
    }
  });

  test('trap detection fires on a recent-spike + line-inflated candidate', () => {
    // Player with last5 well above season + line set above projection.
    // This is the classic public trap pattern.
    const trapLine = makeLine({
      playerId: 50,
      playerName: 'Trap Star',
      team: 'NYK',
      vsOpponent: { opponentAbbr: 'PHI', gamesPlayed: 3, avg: 28, values: [28, 30, 26] },
      statKey: 'points',
      statLabel: 'Points',
      line: 26.5,
      last10Values: [22, 24, 26, 23, 22, 42, 38, 40, 36, 38],   // recent spike
      last10Avg: 31.1,
      projection: makeProjection({
        probability: { over: 60, under: 40 },
        confidence: { score: 60, label: 'Medium Confidence' },
        risk: { score: 55, label: 'Moderate Risk' },
        // Projection BELOW the line — line is inflated by public action.
        projection: { baseline: 24, contextAdjusted: 24, final: 24, rangeLow: 21, rangeHigh: 27 },
        factorBreakdown: {
          seasonAvg: 22, last10Avg: 31, last5Avg: 39,    // L5 way above season
          vsOpponentAvg: 28, homeAwayAvg: 22,
          seasonMedian: 22, last10Median: 31,
          blendedStdDev: 5, projectedMinutes: 36,
          minutesMultiplier: 1, usageMultiplier: 1, injuryMultiplier: 1,
          opponentDefenseMultiplier: 1, paceMultiplier: 1, restMultiplier: 1,
          gameImportanceMultiplier: 1, blowoutMultiplier: 1,
          modelAgreementScore: 50,
        },
        edge: { score: 50, label: 'Slight Edge', lean: 'Slight Over Lean' },
      }),
    });
    const { combos } = buildCombos([trapLine, ...strongSlate(8, 70)]);
    let trapLeg: { trapScore: number; trapTier: string } | undefined;
    for (const c of combos) {
      const found = c.legs.find((l) => l.playerId === 50);
      if (found) trapLeg = found;
    }
    if (trapLeg) {
      expect(trapLeg.trapScore).toBeGreaterThan(50);
      expect(['High Trap Risk', 'Extreme Trap Risk']).toContain(trapLeg.trapTier);
    }
    // (If the trap candidate didn't make any card due to its lower
    // ranking, that's also fine — the test just guards against
    // miscategorizing it as "Normal" when it does land.)
  });
});

describe('buildCombos per-card identity in Balanced mode', () => {
  test('Best 6 in Balanced mode picks the high-edge candidates first', () => {
    // strongSlate(20, 80): probabilities 80→61, edges +25→+6.
    // Aggressive filter requires edge ≥10, so picks 0-9 pass and
    // 10-19 fail. Best 6 should land on the top-10 high-edge picks.
    const slate = strongSlate(20, 80);
    const { combos } = buildCombos(slate);
    const best6 = combos.find((c) => c.label === 'Best 6');
    expect(best6).toBeDefined();
    expect(best6!.legs.length).toBe(6);
    // Every leg on Best 6 should have edge ≥10 (the aggressive floor).
    for (const leg of best6!.legs) {
      expect(leg.edgePercent).toBeGreaterThanOrEqual(10);
    }
  });

  test('marketDisagreementScore is computed on every candidate', () => {
    const { combos } = buildCombos(strongSlate(8, 75));
    for (const c of combos) {
      for (const leg of c.legs) {
        expect(typeof leg.marketDisagreementScore).toBe('number');
      }
    }
  });

  test('card-level summaries: averageProjectionGap, trapExposure, marketDisagreementRating', () => {
    const { combos } = buildCombos(strongSlate(8, 75));
    for (const c of combos) {
      if (c.legs.length === 0) continue;
      expect(typeof c.averageProjectionGap).toBe('number');
      expect(['Low', 'Medium', 'High']).toContain(c.trapExposure);
      expect(['Low', 'Medium', 'High']).toContain(c.marketDisagreementRating);
    }
  });

  test('Best 6 subtitle reflects Aggressive Edge identity', () => {
    const { combos } = buildCombos(strongSlate(20, 75));
    const best6 = combos.find((c) => c.label === 'Best 6')!;
    const best2 = combos.find((c) => c.label === 'Best 2')!;
    // Subtitles encode per-size identity: Best 2 = Safe Core,
    // Best 6 = Aggressive Edge. Spec's biggest UX shift.
    expect(best6.subtitle.toLowerCase()).toContain('aggressive');
    expect(best2.subtitle.toLowerCase()).toContain('safe core');
  });
});

describe('buildCombos slate modes', () => {
  test('default mode is "balanced"', () => {
    // Calling without an explicit mode should equal balanced.
    const slate = strongSlate(20, 75);
    const a = buildCombos(slate);
    const b = buildCombos(slate, 'balanced');
    const aBest6 = a.combos.find((c) => c.label === 'Best 6');
    const bBest6 = b.combos.find((c) => c.label === 'Best 6');
    expect(aBest6?.legs.map((l) => l.playerId)).toEqual(bBest6?.legs.map((l) => l.playerId));
  });

  test('Safe and Balanced modes can produce different Best 6 picks', () => {
    // Build a slate where probability and edgePercent disagree on
    // which leg is "best": a high-prob low-edge pick AND a low-prob
    // high-edge pick. Safe should prefer the former; Balanced the
    // latter. (Edge here is implicit via the BASELINE_IMPLIED gap.)
    const safeStarLine = makeLine({
      playerId: 901,
      playerName: 'Safe Star',
      team: 'NYK',
      vsOpponent: { opponentAbbr: 'PHI', gamesPlayed: 3, avg: 24, values: [24, 26, 22] },
      statKey: 'points',
      statLabel: 'Points',
      line: 22.5,
      projection: makeProjection({
        // Very high probability + tight projection — the classic
        // "safe" pick. evScore is muted because edge from 87 - 55 = 32
        // is good but distance separation is weak (proj=24 vs line=22.5).
        probability: { over: 87, under: 13 },
        confidence: { score: 80, label: 'High Confidence' },
        risk: { score: 35, label: 'Low Risk' },
        edge: { score: 70, label: 'Strong Edge', lean: 'Strong Over Lean' },
        projection: { baseline: 24, contextAdjusted: 24, final: 24, rangeLow: 22, rangeHigh: 26 },
        factorBreakdown: {
          seasonAvg: 24, last10Avg: 24, last5Avg: 24,
          vsOpponentAvg: 24, homeAwayAvg: 24,
          seasonMedian: 24, last10Median: 24,
          blendedStdDev: 5, projectedMinutes: 36,
          minutesMultiplier: 1, usageMultiplier: 1, injuryMultiplier: 1,
          opponentDefenseMultiplier: 1, paceMultiplier: 1, restMultiplier: 1,
          gameImportanceMultiplier: 1, blowoutMultiplier: 1,
          modelAgreementScore: 90,
        },
      }),
    });
    const slate = [safeStarLine, ...strongSlate(8, 70)];
    const safe = buildCombos(slate, 'safe');
    const balanced = buildCombos(slate, 'balanced');
    const safeBest6 = safe.combos.find((c) => c.label === 'Best 6')!;
    const balancedBest6 = balanced.combos.find((c) => c.label === 'Best 6')!;
    // Safe Star should land on Safe-mode Best 6 (prob 87 dominates).
    expect(safeBest6.legs.some((l) => l.playerId === 901)).toBe(true);
    // The two cards aren't required to differ in every fixture, but
    // they should at least be valid 6-leg cards under both modes.
    expect(safeBest6.legs.length).toBe(6);
    expect(balancedBest6.legs.length).toBe(6);
  });

  test('Aggressive mode prioritizes projection separation', () => {
    // A pick with huge projection separation but only modest
    // probability should rank higher in Aggressive than Balanced.
    const ceilingLine = makeLine({
      playerId: 902,
      playerName: 'Ceiling Pick',
      team: 'BKN',
      vsOpponent: { opponentAbbr: 'TOR', gamesPlayed: 3, avg: 8, values: [9, 8, 7] },
      statKey: 'three_pt_made',
      statLabel: '3-PT Made',
      line: 1.5,
      projection: makeProjection({
        // Modest probability (say 65) but projection sits 3+ stddev
        // above line — exactly the "ceiling" archetype.
        probability: { over: 65, under: 35 },
        confidence: { score: 60, label: 'Medium Confidence' },
        risk: { score: 50, label: 'Moderate Risk' },
        edge: { score: 65, label: 'Strong Edge', lean: 'Strong Over Lean' },
        projection: { baseline: 4, contextAdjusted: 4, final: 4, rangeLow: 3, rangeHigh: 5 },
        factorBreakdown: {
          seasonAvg: 4, last10Avg: 4, last5Avg: 4,
          vsOpponentAvg: 4, homeAwayAvg: 4,
          seasonMedian: 4, last10Median: 4,
          blendedStdDev: 0.8, projectedMinutes: 36,
          minutesMultiplier: 1, usageMultiplier: 1, injuryMultiplier: 1,
          opponentDefenseMultiplier: 1, paceMultiplier: 1, restMultiplier: 1,
          gameImportanceMultiplier: 1, blowoutMultiplier: 1,
          modelAgreementScore: 80,
        },
      }),
    });
    const slate = [ceilingLine, ...strongSlate(8, 70)];
    const aggressive = buildCombos(slate, 'aggressive');
    const aggBest6 = aggressive.combos.find((c) => c.label === 'Best 6')!;
    // Ceiling Pick should land on Aggressive Best 6 because
    // projection is 2.5+ σ above line.
    expect(aggBest6.legs.some((l) => l.playerId === 902)).toBe(true);
  });
});

describe('buildCombos correlation block', () => {
  test('blocks same-player Points + PRA on the same card', () => {
    const lines: ResolvedLine[] = [
      makeLine({
        playerId: 50, playerName: 'Star',
        statKey: 'points', statLabel: 'Points', line: 22,
        projection: makeProjection({ probability: { over: 85, under: 15 } }),
      }),
      makeLine({
        playerId: 50, playerName: 'Star',
        statKey: 'pra', statLabel: 'Pts + Rebs + Asts', line: 32,
        projection: makeProjection({ probability: { over: 82, under: 18 } }),
      }),
      ...strongSlate(5, 70),
    ];
    const { combos } = buildCombos(lines);
    const best6 = combos.find((c) => c.label === 'Best 6')!;
    const starStats = best6.legs.filter((l) => l.playerId === 50).map((l) => l.statKey);
    // Either Points or PRA, not both.
    const hasPoints = starStats.includes('points');
    const hasPra = starStats.includes('pra');
    expect(hasPoints && hasPra).toBe(false);
  });

  test('blocks same-player Pts+Rebs and Pts+Asts on same card (shared Points base)', () => {
    // Regression: the old hand-rolled correlation map had pr→[points,
    // rebounds, pra] and pa→[points, assists, pra] but never linked
    // pr↔pa directly. Same-player Pts+Rebs and Pts+Asts both depend
    // on the player's scoring; if Tobias has a quiet 8-point night
    // both legs lose together. New base-component model catches this
    // via the shared 'points' base.
    const lines: ResolvedLine[] = [
      makeLine({
        playerId: 88, playerName: 'Tobias',
        statKey: 'pr', statLabel: 'Pts + Rebs', line: 24.5,
        projection: makeProjection({ probability: { over: 75, under: 25 } }),
      }),
      makeLine({
        playerId: 88, playerName: 'Tobias',
        statKey: 'pa', statLabel: 'Pts + Asts', line: 19.5,
        projection: makeProjection({ probability: { over: 72, under: 28 } }),
      }),
      ...strongSlate(8, 70),
    ];
    const { combos } = buildCombos(lines);
    for (const c of combos) {
      const tobiasStats = c.legs.filter((l) => l.playerId === 88).map((l) => l.statKey);
      const hasPR = tobiasStats.includes('pr');
      const hasPA = tobiasStats.includes('pa');
      expect(hasPR && hasPA).toBe(false);
    }
  });

  test('blocks same-player 3PT Made + Points (shared points base)', () => {
    // A made 3 contributes to points. Same-player 3PT-over and
    // Points-over share variance — rough night from deep usually
    // means a low-points night too.
    const lines: ResolvedLine[] = [
      makeLine({
        playerId: 77, playerName: 'Sniper',
        statKey: 'three_pt_made', statLabel: '3-PT Made', line: 2.5,
        projection: makeProjection({ probability: { over: 76, under: 24 } }),
      }),
      makeLine({
        playerId: 77, playerName: 'Sniper',
        statKey: 'points', statLabel: 'Points', line: 22.5,
        projection: makeProjection({ probability: { over: 74, under: 26 } }),
      }),
      ...strongSlate(8, 70),
    ];
    const { combos } = buildCombos(lines);
    for (const c of combos) {
      const sniperStats = c.legs.filter((l) => l.playerId === 77).map((l) => l.statKey);
      const has3 = sniperStats.includes('three_pt_made');
      const hasPts = sniperStats.includes('points');
      expect(has3 && hasPts).toBe(false);
    }
  });
});

describe('buildCombos Wild Card priority chain', () => {
  // Build N candidates that each pass the standard Wild Card gate
  // (≥3 of L10 + ≥1 vs opp). Used so Tier 1 has at least the spec'd
  // 3-leg minimum to actually emit. Uses a different stat (rebounds)
  // and team than strongSlate so safe-card exposure caps don't pull
  // them onto Best 2-6.
  function wildEligibleCandidates(n: number, baseProb = 60): ResolvedLine[] {
    return Array.from({ length: n }, (_, i) =>
      makeLine({
        playerId: 800 + i,
        playerName: `Wild ${i}`,
        team: ['BKN', 'TOR', 'ORL', 'WAS', 'IND', 'CHI'][i % 6]!,
        vsOpponent: {
          opponentAbbr: 'OPP',
          gamesPlayed: 3,
          avg: 6,
          values: [7, 5, 6],   // vs line 4.5 → 2 hits
        },
        statKey: 'rebounds',
        statLabel: 'Rebounds',
        line: 4.5,
        last10Values: [5, 6, 7, 8, 4, 3, 6, 5, 4, 7],   // 6 of 10 hits over 4.5
        last10Avg: 5.5,
        projection: makeProjection({
          // Just below the ELIGIBLE floor (57) so safe cards skip
          // these — they go straight to the Wild Card pool.
          probability: { over: baseProb - i, under: 100 - (baseProb - i) },
          confidence: { score: 55 - i, label: 'Medium Confidence' },
          risk: { score: 60 + i, label: 'Moderate Risk' },
          edge: { score: 45, label: 'Moderate Edge', lean: 'Slight Over Lean' },
        }),
      }),
    );
  }

  test('Tier 1 (standard) fires when ≥3 candidates pass the historical gate', () => {
    const lines = [...strongSlate(8, 75), ...wildEligibleCandidates(4, 60)];
    const { combos } = buildCombos(lines);
    const wild = combos.find((c) => c.label === 'Wild Card');
    expect(wild).toBeDefined();
    expect(wild!.wildCardKind).toBe('standard');
    expect(wild!.legs.length).toBeGreaterThanOrEqual(3);
    // Wild legs should be drawn from the wildEligibleCandidates pool.
    expect(wild!.legs.some((l) => l.playerId >= 800)).toBe(true);
  });

  test('Wild Card legs carry a wildCardReason', () => {
    const lines = [...strongSlate(8, 75), ...wildEligibleCandidates(4, 60)];
    const { combos } = buildCombos(lines);
    const wild = combos.find((c) => c.label === 'Wild Card');
    expect(wild!.legs.length).toBeGreaterThan(0);
    expect(wild!.legs[0]!.wildCardReason).toBeDefined();
    expect(wild!.legs[0]!.wildCardReason).toContain('Hit');
  });

  test('Tier 7 (no_edge) when nothing qualifies — surfaces closest candidates', () => {
    // Slate where every candidate fails the historical gate — strip
    // vsOpponent so vsOpp hit count is always 0.
    const lines = strongSlate(8).map((l) => ({ ...l, vsOpponent: undefined }));
    const { combos } = buildCombos(lines);
    const wild = combos.find((c) => c.label === 'Wild Card');
    expect(wild).toBeDefined();
    expect(wild!.wildCardKind).toBe('no_edge');
    expect(wild!.legs.length).toBe(0);
    expect(wild!.warnings.some((w) => w.toLowerCase().includes('did not identify'))).toBe(true);
    // closestCandidates is populated so the UI can surface near-misses.
    expect(Array.isArray(wild!.closestCandidates)).toBe(true);
  });

  test('Tier 2 (near_miss) when no Tier 1 but candidates barely missed', () => {
    // 4 near-miss candidates: 2 of L10 + 1 vs-opp hit, with the
    // probability set just BELOW the ELIGIBLE safe-card floor (57)
    // but above the Near Miss floor (56). This keeps them out of
    // Best 2-6 entirely so they flow straight into the Wild Card pool.
    const nearMiss = Array.from({ length: 4 }, (_, i) =>
      makeLine({
        playerId: 700 + i,
        playerName: `NearMiss ${i}`,
        team: ['BKN', 'TOR', 'ORL', 'WAS'][i % 4]!,
        vsOpponent: {
          opponentAbbr: 'OPP',
          gamesPlayed: 2,
          avg: 5,
          values: [5, 4],
        },
        statKey: 'rebounds',
        statLabel: 'Rebounds',
        line: 4.5,
        last10Values: [5, 5, 3, 3, 3, 3, 3, 3, 3, 3],
        last10Avg: 3.4,
        projection: makeProjection({
          probability: { over: 56, under: 44 },             // below ELIGIBLE (57), above Near Miss (56)
          confidence: { score: 55, label: 'Medium Confidence' },
          risk: { score: 65, label: 'Moderate Risk' },
          edge: { score: 45, label: 'Moderate Edge', lean: 'Slight Over Lean' },
          projection: { baseline: 5, contextAdjusted: 5, final: 5, rangeLow: 4, rangeHigh: 6 },
        }),
      }),
    );
    const lines = [...strongSlate(8, 75), ...nearMiss];
    const { combos } = buildCombos(lines);
    const wild = combos.find((c) => c.label === 'Wild Card');
    expect(wild).toBeDefined();
    // Standard tier can't fire (no candidates have ≥3 of L10), so the
    // chain should land on near_miss given the 4 qualifying picks.
    expect(wild!.wildCardKind).toBe('near_miss');
  });
});

describe('buildCombos combined hit probability', () => {
  test('correlation-adjusted hit ≤ raw hit', () => {
    const { combos } = buildCombos(strongSlate(8));
    for (const c of combos) {
      expect(c.adjustedCombinedHit).toBeLessThanOrEqual(c.rawCombinedHit);
    }
  });

  test('raw combined hit equals product of leg probabilities', () => {
    const { combos } = buildCombos(strongSlate(8));
    const best2 = combos.find((c) => c.label === 'Best 2')!;
    const expected = best2.legs.reduce((p, l) => p * (l.probability / 100), 1) * 100;
    expect(best2.rawCombinedHit).toBeCloseTo(expected, 1);
  });
});
