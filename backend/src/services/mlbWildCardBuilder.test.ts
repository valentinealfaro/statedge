// Tests for the MLB Wild Card tier classification. Each tier should
// fire when its predicate matches and never collide with another
// tier's pool. No-edge fallback always fires when nothing qualifies.

import { describe, expect, test } from 'vitest';
import { buildMlbWildCard } from './mlbWildCardBuilder.js';
import type { ResolvedMlbLine, WildCardSignals } from './mlbSlatePipeline.js';
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
    reasonCodes: [],
    weightsUsed: { last10: 1.0 },
    contextAdjustments: { park: 1, weather: 1, lineup: 1, bvp: 1, pitchArsenal: 1, bullpen: 1 },
    ...over,
  };
}

function signals(over: Partial<WildCardSignals> = {}): WildCardSignals {
  return {
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
    ...over,
  };
}

function leg(
  playerId: number,
  proj: Partial<ProjectionResult> = {},
  sigs: Partial<WildCardSignals> = {},
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
    signals: signals(sigs),
    gameKey: null,
    gamePk: null,
    venueName: null,
  };
}

describe('Wild Card — Standard tier', () => {
  test('Picks legs that pass historical + projection + trap gates', () => {
    const pool = Array.from({ length: 6 }, (_, i) =>
      leg(100 + i,
        { projectionDistanceScore: 60, trapScore: 20 },
        { last10HitRate: 60, opponentGames: 2 },
      ),
    );
    const wc = buildMlbWildCard(pool, new Set());
    expect(wc.kind).toBe('standard');
    expect(wc.legs.length).toBeGreaterThanOrEqual(3);
    expect(wc.legs[0]?.wildCardReason).toMatch(/Hit \d+ of last 10/);
  });

  test('Drops to next tier when L10 hit rate too low', () => {
    const pool = Array.from({ length: 6 }, (_, i) =>
      leg(200 + i,
        { projectionDistanceScore: 30, trapScore: 25 },
        { last10HitRate: 35, opponentGames: 2, l5VsSeasonDelta: null },
      ),
    );
    const wc = buildMlbWildCard(pool, new Set());
    expect(wc.kind).not.toBe('standard');
  });
});

describe('Wild Card — Near Miss tier', () => {
  test('Borderline L10 hit rate (40-50%) qualifies', () => {
    const pool = Array.from({ length: 6 }, (_, i) =>
      leg(300 + i,
        { projectionDistanceScore: 45, trapScore: 30 },
        { last10HitRate: 45, opponentGames: 1 },
      ),
    );
    const wc = buildMlbWildCard(pool, new Set());
    expect(wc.kind).toBe('near_miss');
  });

  test('Zero vs-opp games but solid L10 still qualifies as Near Miss', () => {
    const pool = Array.from({ length: 6 }, (_, i) =>
      leg(310 + i,
        { projectionDistanceScore: 55, trapScore: 30 },
        { last10HitRate: 60, opponentGames: 0 },
      ),
    );
    const wc = buildMlbWildCard(pool, new Set());
    expect(wc.kind).toBe('near_miss');
  });
});

describe('Wild Card — Momentum tier', () => {
  test('L5 ≥ 1.15× L10 fires Momentum (OVER direction)', () => {
    // Suppress earlier tiers by zeroing L10 hit rate / opponent.
    const pool = Array.from({ length: 6 }, (_, i) =>
      leg(400 + i,
        { projectionDistanceScore: 30, trapScore: 30 },
        {
          last10HitRate: 30, opponentGames: 0,    // fail standard + near-miss
          l5VsSeasonDelta: 0.5,
          last5Average: 2.0,
          last10Average: 1.5,                      // ratio 1.33
        },
      ),
    );
    const wc = buildMlbWildCard(pool, new Set());
    expect(wc.kind).toBe('momentum');
    expect(wc.legs[0]?.wildCardReason.toLowerCase()).toContain('momentum');
  });

  test('UNDER direction with L5 trending DOWN qualifies as Momentum', () => {
    const pool: ResolvedMlbLine[] = Array.from({ length: 6 }, (_, i) =>
      leg(410 + i,
        { projectionDistanceScore: 30, trapScore: 30 },
        {
          last10HitRate: 30, opponentGames: 0,
          last5Average: 1.0,
          last10Average: 1.5,                       // ratio 0.67
          l5VsSeasonDelta: -0.5,
        },
      ),
    ).map((l) => ({ ...l, modelDirection: 'UNDER' as const }));
    const wc = buildMlbWildCard(pool, new Set());
    expect(wc.kind).toBe('momentum');
  });
});

describe('Wild Card — Matchup Spike tier', () => {
  test('Player beats opponent by ≥0.5 → fires Matchup Spike', () => {
    // Need to fail standard + near miss + momentum first.
    const pool = Array.from({ length: 6 }, (_, i) =>
      leg(500 + i,
        { projectionDistanceScore: 35, trapScore: 30 },
        {
          last10HitRate: 30, opponentGames: 3,
          opponentVsSeasonDelta: 0.7,
          last5Average: 1.5, last10Average: 1.5,    // no momentum
          l5VsSeasonDelta: 0,
        },
      ),
    );
    const wc = buildMlbWildCard(pool, new Set());
    expect(wc.kind).toBe('matchup_spike');
  });
});

describe('Wild Card — High Variance tier', () => {
  test('Huge projection separation → fires High Variance', () => {
    const pool = Array.from({ length: 6 }, (_, i) =>
      leg(600 + i,
        { projectionDistanceScore: 80, trapScore: 50 },
        {
          last10HitRate: 30, opponentGames: 0,
          last5Average: 1.5, last10Average: 1.5,
          l5VsSeasonDelta: 0,
          opponentVsSeasonDelta: 0,
        },
      ),
    );
    const wc = buildMlbWildCard(pool, new Set());
    expect(wc.kind).toBe('high_variance');
  });
});

describe('Wild Card — No Edge fallback', () => {
  test('Nothing qualifies → returns no_edge with closest candidates', () => {
    const pool = Array.from({ length: 4 }, (_, i) =>
      leg(700 + i,
        { projectionDistanceScore: 20, trapScore: 80 },         // fails everything
        {
          last10HitRate: 20, opponentGames: 0,
          last5Average: 1.5, last10Average: 1.5,
          l5VsSeasonDelta: 0,
          opponentVsSeasonDelta: 0,
        },
      ),
    );
    const wc = buildMlbWildCard(pool, new Set());
    expect(wc.kind).toBe('no_edge');
    expect(wc.legs).toHaveLength(0);
    expect(wc.closestCandidates?.length).toBeGreaterThan(0);
    expect(wc.subtitle.toLowerCase()).toContain('no wild card');
  });

  test('Empty pool → no_edge with empty closest candidates', () => {
    const wc = buildMlbWildCard([], new Set());
    expect(wc.kind).toBe('no_edge');
    expect(wc.legs).toHaveLength(0);
    expect(wc.closestCandidates).toEqual([]);
  });
});

describe('Wild Card — used-player block', () => {
  test('Players already in main combos are excluded from Wild Card', () => {
    const pool = Array.from({ length: 6 }, (_, i) =>
      leg(800 + i,
        { projectionDistanceScore: 60, trapScore: 20 },
        { last10HitRate: 60, opponentGames: 2 },
      ),
    );
    const used = new Set([800, 801, 802, 803]);
    const wc = buildMlbWildCard(pool, used);
    // Only 2 legs left (804, 805) — under MIN_LEGS=3 → falls through.
    expect(wc.legs.length).toBeLessThan(3);
  });
});
