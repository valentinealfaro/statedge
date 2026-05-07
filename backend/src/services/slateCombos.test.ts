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
