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
    contextAdjustments: { park: 1, weather: 1, lineup: 1, bvp: 1, pitchArsenal: 1, bullpen: 1 },
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
