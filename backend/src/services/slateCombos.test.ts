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
    vsOpponent: { opponentAbbr: 'PHI', gamesPlayed: 3, avg: 27 },
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
      vsOpponent: { opponentAbbr: opp, gamesPlayed: 2, avg: 26 },
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

describe('buildCombos top-down progressive', () => {
  test('Best 5 is a strict subset of Best 6', () => {
    const { combos } = buildCombos(strongSlate(8));
    const best6 = combos.find((c) => c.label === 'Best 6');
    const best5 = combos.find((c) => c.label === 'Best 5');
    expect(best6?.legs.length).toBe(6);
    expect(best5?.legs.length).toBe(5);
    const six = new Set(best6!.legs.map((l) => l.playerId));
    for (const l of best5!.legs) expect(six.has(l.playerId)).toBe(true);
  });

  test('Best 4/3/2 are subsets of the next-larger card', () => {
    const { combos } = buildCombos(strongSlate(8));
    const best5 = combos.find((c) => c.label === 'Best 5')!;
    const best4 = combos.find((c) => c.label === 'Best 4')!;
    const best3 = combos.find((c) => c.label === 'Best 3')!;
    const best2 = combos.find((c) => c.label === 'Best 2')!;
    const idsIn = (c: Combo) => new Set(c.legs.map((l) => l.playerId));
    for (const l of best4.legs) expect(idsIn(best5).has(l.playerId)).toBe(true);
    for (const l of best3.legs) expect(idsIn(best4).has(l.playerId)).toBe(true);
    for (const l of best2.legs) expect(idsIn(best3).has(l.playerId)).toBe(true);
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
