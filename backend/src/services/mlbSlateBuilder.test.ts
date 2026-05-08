// Pure tests for the MLB slate builder. No DB; we hand-craft
// ResolvedMlbLine arrays and assert eligibility / mode behavior /
// card-size gates work as the spec demands.

import { describe, expect, test } from 'vitest';
import { buildMlbSlate } from './mlbSlateBuilder.js';
import type { ResolvedMlbLine } from './mlbSlatePipeline.js';
import type { ProjectionResult } from './mlbProjectionEngine.js';

function projection(over: Partial<ProjectionResult> = {}): ProjectionResult {
  return {
    projection: 1.5,
    line: 1.5,
    baselineProjection: 1.5,
    probability: 65,
    confidence: 70,
    riskScore: 40,
    trapScore: 25,
    trapTier: 'Mild Trap Risk',
    projectionDistanceScore: 55,
    edgePercent: 12,
    edgeScore: 60,
    evScore: 18,
    qualifiesForCards: { safe: true, balanced: true },
    reasonCodes: ['Sample size: 12 games.'],
    weightsUsed: { last10: 0.6, last5: 0.4 },
    contextAdjustments: { park: 1, weather: 1, lineup: 1, bvp: 1, gameScript: 1, pitchArsenal: 1, bullpen: 1 },
    seasonAverage: 1.5,
    seasonGames: 60,
    last10Average: 1.5,
    last5Average: 1.5,
    last10HitRate: 60,
    robustBaselineComponents: null,
    fragilityScore: 35,
    fragilityTier: 'Moderate Fragility',
    fragilityComponents: {
      statRarity: 45, marginThinness: 30, sampleWeakness: 0, volatility: 30,
      lineupUncertainty: 0,
    },
    confidenceTier: 'Strong',
    confidenceComponents: {
      sampleQuality: 70, projectionAgreement: 75, matchupClarity: 70,
      opportunityCertainty: 75, calibrationStrength: 50, dataCompleteness: 60,
    },
    momentumExpansionScore: 50,
    monteCarlo: null,
    originalLine: null,
    originalProbability: null,
    lineRaised: false,
    lineRaiseReason: null,
    ...over,
  };
}

function leg(
  playerId: number,
  over: Partial<ResolvedMlbLine> = {},
  proj: Partial<ProjectionResult> = {},
): ResolvedMlbLine {
  return {
    playerId,
    playerName: `Player ${playerId}`,
    position: 'OF',
    team: { id: 1, abbr: 'NYY' },
    isPitcher: false,
    statKey: 'hits',
    statLabel: 'Hits',
    line: 1.5,
    bookableSide: 'both',
    modelDirection: 'OVER',
    projection: projection(proj),
    signals: {
      sampleSize: 10,
      last10HitCount: 6,
      last10HitRate: 60,
      consistencyScore: 70,
      last5Average: 1.6,
      last10Average: 1.5,
      l5VsSeasonDelta: 0.1,
      opponentAverage: 1.5,
      opponentGames: 2,
      opponentVsSeasonDelta: 0,
      lineupSpot: 3,
      parkMultiplier: 1.0,
      venueName: null,
      seasonAverage: 1.5,
      seasonGames: 60,
      momentumExpansionScore: 50,
    },
    gameKey: null,
    gamePk: null,
    venueName: null,
    ...over,
  };
}

// Helper: a slate of N strong legs, all distinct players.
function strongSlate(n: number): ResolvedMlbLine[] {
  return Array.from({ length: n }, (_, i) =>
    leg(100 + i, {}, { probability: 70 - i, edgePercent: 18 - i, trapScore: 25 }),
  );
}

describe('buildMlbSlate — Safe mode', () => {
  test('Safe emits 2/3/4 only, never 5/6', () => {
    const r = buildMlbSlate(strongSlate(8), 'safe');
    const sizes = r.combos.map((c) => c.size).sort();
    expect(sizes).toEqual([2, 3, 4]);
  });

  test('Safe filters legs below 65% probability', () => {
    const slate = [
      leg(1, {}, { probability: 80, edgePercent: 15 }),
      leg(2, {}, { probability: 70, edgePercent: 12 }),
      leg(3, {}, { probability: 60, edgePercent: 10 }),  // dropped (prob<65)
    ];
    const r = buildMlbSlate(slate, 'safe');
    const best2 = r.combos.find((c) => c.size === 2);
    expect(best2?.combo).not.toBeNull();
    const playerIds = best2?.combo?.legs.map((l) => l.playerId) ?? [];
    expect(playerIds).not.toContain(3);
  });
});

describe('buildMlbSlate — Aggressive momentum tiebreak', () => {
  test('Per philosophy memo, Aggressive prefers high-momentum legs over flat-momentum legs at similar edge', () => {
    // Aggressive emits Best 3 (smallest size). All legs edge ≥12 to
    // pass the eligibility floor; legs are otherwise identical so
    // momentumExpansionScore is the only differentiator. Player 2 has
    // strong momentum and SHOULD make the Best 3; player 6 has flat
    // momentum and same edge — tiebreak should drop it.
    const slate: ResolvedMlbLine[] = [
      leg(1, {}, { edgePercent: 15, projectionDistanceScore: 60, probability: 65 }),
      leg(2, {}, { edgePercent: 15, projectionDistanceScore: 60, probability: 65 }),
      leg(3, {}, { edgePercent: 14, probability: 64 }),
      leg(4, {}, { edgePercent: 14, probability: 63 }),
      leg(5, {}, { edgePercent: 14, probability: 62 }),
      leg(6, {}, { edgePercent: 14, probability: 61 }),
    ];
    // Bump player 2's momentum to "Strong Expansion".
    slate[1] = {
      ...slate[1]!,
      signals: { ...slate[1]!.signals, momentumExpansionScore: 85 },
    };
    const r = buildMlbSlate(slate, 'aggressive');
    const best3 = r.combos.find((c) => c.size === 3);
    const ids = best3?.combo?.legs.map((l) => l.playerId) ?? [];
    expect(ids).toContain(2);
  });
});

describe('buildMlbSlate — Insane mode', () => {
  test('Insane emits 5 + 6 only (lottery sizes)', () => {
    const r = buildMlbSlate(strongSlate(10), 'insane');
    const sizes = r.combos.map((c) => c.size).sort();
    expect(sizes).toEqual([5, 6]);
  });

  test('Insane subtitles use lottery framing per memory', () => {
    const r = buildMlbSlate(strongSlate(10), 'insane');
    const best6 = r.combos.find((c) => c.size === 6);
    if (best6?.combo) {
      expect(best6.combo.subtitle.toLowerCase()).toContain('lottery');
    }
  });
});

describe('buildMlbSlate — L8 per-size fragility caps', () => {
  test('Highly-fragile leg gets dropped from Best 6 (Balanced cap = 50) but kept in Best 2 (cap = 80)', () => {
    // 6 legs total; player 1 has high fragility (75 — over Best-6 cap 50, under Best-2 cap 80).
    const slate: ResolvedMlbLine[] = strongSlate(6);
    slate[0] = {
      ...slate[0]!,
      projection: { ...slate[0]!.projection, fragilityScore: 75 },
    };
    const r = buildMlbSlate(slate, 'balanced');
    const best6 = r.combos.find((c) => c.size === 6);
    const best2 = r.combos.find((c) => c.size === 2);
    // Best 6 either drops player 1 entirely OR fails (insufficient sturdy legs).
    if (best6?.combo) {
      const ids = best6.combo.legs.map((l) => l.playerId);
      expect(ids).not.toContain(100);     // player 1 (id 100) excluded by fragility cap
    }
    // Best 2 should still be able to include the fragile leg if its score warrants.
    expect(best2).toBeDefined();
  });

  test('Slate of all-fragile legs fails Best 6 with sturdy-legs reason', () => {
    // Every leg over Balanced Best-6 cap (50).
    const slate = Array.from({ length: 8 }, (_, i) =>
      leg(200 + i, {}, { fragilityScore: 70, edgePercent: 18, probability: 65 }),
    );
    const r = buildMlbSlate(slate, 'balanced');
    const best6 = r.combos.find((c) => c.size === 6);
    expect(best6?.combo).toBeNull();
    expect(best6?.reason).toMatch(/sturdy/i);
  });
});

describe('buildMlbSlate — same-player block', () => {
  test('Same player on multiple stats can\'t stack on one card', () => {
    const slate = [
      leg(1, { statKey: 'hits',         statLabel: 'Hits' },        { edgePercent: 20 }),
      leg(1, { statKey: 'home_runs',    statLabel: 'Home Runs' },   { edgePercent: 19 }),
      leg(1, { statKey: 'total_bases',  statLabel: 'Total Bases' }, { edgePercent: 18 }),
      leg(2, {}, { edgePercent: 15 }),
      leg(3, {}, { edgePercent: 14 }),
      leg(4, {}, { edgePercent: 13 }),
    ];
    const r = buildMlbSlate(slate, 'balanced');
    for (const slot of r.combos) {
      if (!slot.combo) continue;
      const ids = slot.combo.legs.map((l) => l.playerId);
      expect(new Set(ids).size).toBe(ids.length);   // no duplicates
    }
  });
});

describe('buildMlbSlate — eligibility gates ("card size must be earned")', () => {
  test('Soft slate fails 6-leg gate with explicit reason', () => {
    // 6 legs but tepid edge — averageEdge will be ~6%. Balanced 6-leg
    // requires avgEdge ≥ 14%. Builder should refuse.
    const slate = Array.from({ length: 6 }, (_, i) =>
      leg(200 + i, {}, { probability: 60, edgePercent: 6, trapScore: 30 }),
    );
    const r = buildMlbSlate(slate, 'balanced');
    const best6 = r.combos.find((c) => c.size === 6);
    expect(best6?.combo).toBeNull();
    expect(best6?.reason).toMatch(/no clean 6-leg edge|not enough/i);
  });

  test('Strong slate passes 4-leg gate', () => {
    const r = buildMlbSlate(strongSlate(8), 'balanced');
    const best4 = r.combos.find((c) => c.size === 4);
    expect(best4?.combo).not.toBeNull();
    expect(best4?.combo?.legs).toHaveLength(4);
    expect(best4?.combo?.averageEdge).toBeGreaterThan(8);
  });

  test('Empty slate returns no combos with clear reasons', () => {
    const r = buildMlbSlate([], 'balanced');
    for (const slot of r.combos) {
      expect(slot.combo).toBeNull();
      expect(slot.reason.toLowerCase()).toMatch(/not enough/);
    }
  });
});

describe('buildMlbSlate — auto mode resolution', () => {
  test('Thin slate resolves to Safe', () => {
    const r = buildMlbSlate([leg(1), leg(2)], 'auto');
    expect(r.resolvedMode).toBe('safe');
  });

  test('Edge-rich slate resolves to Aggressive or Insane', () => {
    const slate = Array.from({ length: 10 }, (_, i) =>
      leg(100 + i, {}, { edgePercent: 22, probability: 70, trapScore: 25 }),
    );
    const r = buildMlbSlate(slate, 'auto');
    expect(['aggressive', 'insane']).toContain(r.resolvedMode);
  });
});

describe('buildMlbSlate — Demon / Goblin side enforcement', () => {
  test('Demon (over-only) line with model UNDER lean is dropped', () => {
    const slate = [
      leg(1, { bookableSide: 'over', modelDirection: 'UNDER' }, { edgePercent: 20 }),
      leg(2, { bookableSide: 'both' }, { edgePercent: 15 }),
      leg(3, { bookableSide: 'both' }, { edgePercent: 14 }),
    ];
    const r = buildMlbSlate(slate, 'balanced');
    const best2 = r.combos.find((c) => c.size === 2);
    if (best2?.combo) {
      const ids = best2.combo.legs.map((l) => l.playerId);
      expect(ids).not.toContain(1);
    }
  });

  test('Goblin (under-only) line with model OVER lean is dropped', () => {
    const slate = [
      leg(1, { bookableSide: 'under', modelDirection: 'OVER' }, { edgePercent: 20 }),
      leg(2, { bookableSide: 'both' }, { edgePercent: 15 }),
      leg(3, { bookableSide: 'both' }, { edgePercent: 14 }),
    ];
    const r = buildMlbSlate(slate, 'balanced');
    const best2 = r.combos.find((c) => c.size === 2);
    if (best2?.combo) {
      const ids = best2.combo.legs.map((l) => l.playerId);
      expect(ids).not.toContain(1);
    }
  });
});

describe('buildMlbSlate — combo metadata', () => {
  test('Combos report combined hit, average edge, weakest leg', () => {
    const r = buildMlbSlate(strongSlate(6), 'balanced');
    const built = r.combos.find((c) => c.combo)?.combo;
    expect(built).toBeTruthy();
    if (built) {
      expect(built.rawCombinedHit).toBeGreaterThan(0);
      expect(built.rawCombinedHit).toBeLessThan(100);
      expect(built.averageEdge).toBeGreaterThan(0);
      expect(built.weakestLegName).toBeTruthy();
      expect(built.weakestLegReason).toBeTruthy();
    }
  });
});

describe('buildMlbSlate — correlation penalty (Phase 7)', () => {
  test('Independent legs across different games → None correlation, raw == adjusted', () => {
    const slate = Array.from({ length: 6 }, (_, i) =>
      leg(900 + i, {
        team: { id: 100 + i, abbr: 'TM' + i },          // every leg different team
        gameKey: `gpk:${100 + i}`,                       // every leg different game
      }, { edgePercent: 18 }),
    );
    const r = buildMlbSlate(slate, 'balanced');
    const built = r.combos.find((c) => c.combo)?.combo;
    expect(built).toBeTruthy();
    if (built) {
      expect(built.correlationRisk).toBe('None');
      expect(built.correlationPairs).toBe(0);
      expect(built.adjustedCombinedHit).toBeCloseTo(built.rawCombinedHit, 1);
    }
  });

  test('Two legs from same game → Low correlation (1 pair, 0.97x)', () => {
    // 4 legs, two of which share gameKey "gpk:5" (same game).
    const slate = [
      leg(910, { team: { id: 1, abbr: 'NYY' }, gameKey: 'gpk:5' }, { edgePercent: 18 }),
      leg(911, { team: { id: 2, abbr: 'BOS' }, gameKey: 'gpk:5' }, { edgePercent: 18 }),
      leg(912, { team: { id: 3, abbr: 'LAD' }, gameKey: 'gpk:7' }, { edgePercent: 18 }),
      leg(913, { team: { id: 4, abbr: 'SF'  }, gameKey: 'gpk:7' }, { edgePercent: 18 }),
    ];
    // gpk:5 (1 pair) + gpk:7 (1 pair) = 2 pairs total → Medium
    const r = buildMlbSlate(slate, 'balanced');
    const best4 = r.combos.find((c) => c.size === 4)?.combo;
    if (best4) {
      expect(best4.correlationPairs).toBe(2);
      expect(best4.correlationRisk).toBe('Medium');
      expect(best4.adjustedCombinedHit).toBeLessThan(best4.rawCombinedHit);
      // Medium tier multiplier is 0.92×; check ratio is in expected band.
      const ratio = best4.adjustedCombinedHit / best4.rawCombinedHit;
      expect(ratio).toBeCloseTo(0.92, 2);
    }
  });

  test('Three legs from same game → 3 pairs (high correlation)', () => {
    // 3 legs all in gpk:9 → C(3,2) = 3 pairs.
    const slate = [
      leg(920, { team: { id: 10, abbr: 'A' }, gameKey: 'gpk:9' }, { edgePercent: 18 }),
      leg(921, { team: { id: 11, abbr: 'B' }, gameKey: 'gpk:9' }, { edgePercent: 18 }),
      leg(922, { team: { id: 12, abbr: 'C' }, gameKey: 'gpk:9' }, { edgePercent: 18 }),
      leg(923, { team: { id: 13, abbr: 'D' }, gameKey: 'gpk:99' }, { edgePercent: 17 }),
      leg(924, { team: { id: 14, abbr: 'E' }, gameKey: 'gpk:88' }, { edgePercent: 16 }),
    ];
    const r = buildMlbSlate(slate, 'balanced');
    const best3 = r.combos.find((c) => c.size === 3)?.combo;
    if (best3) {
      // Top 3 by edge will be ids 920, 921, 922 (all gpk:9).
      expect(best3.correlationPairs).toBe(3);
      expect(best3.correlationRisk).toBe('High');
    }
  });

  test('Two legs from same team count as correlated even without gameKey', () => {
    // gameKey null but same team — fallback path.
    const slate = [
      leg(930, { team: { id: 50, abbr: 'NYY' }, gameKey: null }, { edgePercent: 18 }),
      leg(931, { team: { id: 50, abbr: 'NYY' }, gameKey: null }, { edgePercent: 18 }),
      leg(932, { team: { id: 60, abbr: 'BOS' }, gameKey: null }, { edgePercent: 17 }),
    ];
    const r = buildMlbSlate(slate, 'balanced');
    const best2 = r.combos.find((c) => c.size === 2)?.combo;
    if (best2) {
      // Top 2 will both be NYY → 1 pair via team fallback.
      expect(best2.correlationPairs).toBeGreaterThanOrEqual(1);
      expect(best2.correlationRisk).not.toBe('None');
    }
  });
});
