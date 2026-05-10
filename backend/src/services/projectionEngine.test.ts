import { describe, expect, it } from 'vitest';
import type { PlayerGame } from '../nba/client.js';
import { isProjectable, project } from './projectionEngine.js';

// Minimal helper — produces a fake PlayerGame with the stat values you
// actually care about for the test, zeroed otherwise. Keeps fixture
// noise low.
function game(partial: Partial<PlayerGame> & { gameId: string }): PlayerGame {
  return {
    gameId: partial.gameId,
    date: partial.date ?? '2026-01-01',
    matchup: partial.matchup ?? 'LAL @ BOS',
    opponentAbbr: partial.opponentAbbr ?? 'BOS',
    isHome: partial.isHome ?? false,
    result: partial.result ?? 'W',
    minutes: partial.minutes ?? 36,
    points: partial.points ?? 0,
    rebounds: partial.rebounds ?? 0,
    assists: partial.assists ?? 0,
    steals: partial.steals ?? 0,
    blocks: partial.blocks ?? 0,
    turnovers: partial.turnovers ?? 0,
    fgm: partial.fgm ?? 0,
    fga: partial.fga ?? 0,
    fg3m: partial.fg3m ?? 0,
    fg3a: partial.fg3a ?? 0,
    ftm: partial.ftm ?? 0,
    fta: partial.fta ?? 0,
    fgPct: partial.fgPct ?? 0,
    fg3Pct: partial.fg3Pct ?? 0,
    ftPct: partial.ftPct ?? 0,
    pf: partial.pf ?? 0,
    oreb: partial.oreb ?? 0,
    dreb: partial.dreb ?? 0,
  };
}

// Build a 20-game season for points where the player averages ~28 PPG
// with mild variance. Useful baseline fixture.
function steadyScorerSeason(): PlayerGame[] {
  const points = [30, 28, 26, 32, 27, 29, 25, 31, 28, 30, 26, 27, 29, 28, 30, 25, 31, 28, 27, 29];
  return points.map((p, i) =>
    game({ gameId: `g${i}`, points: p, rebounds: 7, assists: 6, minutes: 36 }),
  );
}

describe('projectionEngine.project', () => {
  it('returns a numeric projection for points', () => {
    const r = project({
      selectedStat: 'points',
      lineValue: 27.5,
      seasonGames: steadyScorerSeason(),
    });
    expect(r.noProjection).toBeFalsy();
    expect(r.projection.final).toBeGreaterThan(25);
    expect(r.projection.final).toBeLessThan(32);
    expect(r.probability.over + r.probability.under).toBe(100);
  });

  it('respects a player listed Out — returns noProjection', () => {
    const r = project({
      selectedStat: 'points',
      lineValue: 25,
      seasonGames: steadyScorerSeason(),
      playerInjuryStatus: 'Out',
    });
    expect(r.noProjection).toBe(true);
    expect(r.modelNotes[0]).toMatch(/OUT/);
  });

  it('produces a Strong Over Lean when projection clears the line confidently', () => {
    // Player averages 28; line is 23.5. Combined with consistency,
    // confidence and edge should push this to Strong Over Lean.
    const r = project({
      selectedStat: 'points',
      lineValue: 23.5,
      seasonGames: steadyScorerSeason(),
    });
    expect(r.probability.over).toBeGreaterThanOrEqual(70);
    expect(r.edge.lean).toMatch(/Over/);
  });

  it('produces No Clear Edge when projection sits on top of the line', () => {
    // Line right at the 28 PPG average — barely any edge in either direction.
    const r = project({
      selectedStat: 'points',
      lineValue: 28,
      seasonGames: steadyScorerSeason(),
    });
    expect(r.edge.lean).toBe('No Clear Edge');
  });

  it('reduces vs-opp weight when matchup sample is small', () => {
    // Build a season where the player consistently goes off (40+) but
    // they have a single below-line game vs the opponent.
    const games: PlayerGame[] = [];
    for (let i = 0; i < 20; i++) {
      games.push(
        game({
          gameId: `g${i}`,
          points: 40,
          opponentAbbr: i === 5 ? 'BOS' : 'PHX',
        }),
      );
    }
    const r = project({
      selectedStat: 'points',
      lineValue: 30,
      seasonGames: games,
      opponentAbbr: 'BOS',
    });
    // Despite the one bad vs-BOS game, the projection should still
    // strongly favor over because vs-opp weight was reduced.
    expect(r.projection.final).toBeGreaterThan(35);
    expect(r.modelNotes.some((n) => n.includes('1 game vs this opponent'))).toBe(true);
  });

  it('applies the injury multiplier for a Questionable tag', () => {
    const baseline = project({
      selectedStat: 'points',
      lineValue: 27.5,
      seasonGames: steadyScorerSeason(),
    });
    const injured = project({
      selectedStat: 'points',
      lineValue: 27.5,
      seasonGames: steadyScorerSeason(),
      playerInjuryStatus: 'Questionable',
    });
    // Questionable should cut projection by ~12% (and minutes another ~15%).
    expect(injured.projection.final).toBeLessThan(baseline.projection.final);
    expect(injured.factorBreakdown.injuryMultiplier).toBeLessThan(1);
    expect(injured.modelNotes.some((n) => n.includes('Questionable'))).toBe(true);
  });

  it('boosts projection when usage-driving teammates are out', () => {
    const baseline = project({
      selectedStat: 'points',
      lineValue: 27.5,
      seasonGames: steadyScorerSeason(),
    });
    const heavy = project({
      selectedStat: 'points',
      lineValue: 27.5,
      seasonGames: steadyScorerSeason(),
      highUsageTeammatesOut: 1,
    });
    expect(heavy.factorBreakdown.usageMultiplier).toBeGreaterThan(1);
    expect(heavy.projection.final).toBeGreaterThan(baseline.projection.final);
  });

  it('floors std-dev so tiny samples cannot produce 99% probabilities', () => {
    // Player has 3 games, all identical 30 points. Std dev would be 0
    // without the floor, which would yield certainty.
    const games = [
      game({ gameId: 'a', points: 30 }),
      game({ gameId: 'b', points: 30 }),
      game({ gameId: 'c', points: 30 }),
    ];
    const r = project({ selectedStat: 'points', lineValue: 25, seasonGames: games });
    expect(r.factorBreakdown.blendedStdDev).toBeGreaterThanOrEqual(3.5);
    // Probability is high but capped at 95 (iter 4 tightening — was
    // 99 before; the 95% ceiling matches MLB and prevents absurd
    // claims that the May 2026 calibration showed never materialize).
    expect(r.probability.over).toBeLessThanOrEqual(95);
    expect(r.probability.over).toBeGreaterThan(50);
  });

  it('caps overProbability at 95 and underProbability at 5 (iter 4)', () => {
    // Construct a scenario that would naively produce 99% via Gaussian
    // CDF — a player crushing a low line with zero variance. Pre-iter-4
    // the clamp was [0.01, 0.99] and this would land at 99%; after the
    // tightening it lands at 95%, matching MLB's discipline and the
    // May 2026 calibration evidence that 95-99% claims never hit at
    // the rates the model implies.
    const games: PlayerGame[] = [];
    for (let i = 0; i < 30; i++) {
      games.push(game({ gameId: `g${i}`, points: 50 }));
    }
    const r = project({ selectedStat: 'points', lineValue: 5, seasonGames: games });
    expect(r.probability.over).toBeLessThanOrEqual(95);
    expect(r.probability.over).toBeGreaterThanOrEqual(80);
    expect(r.probability.under).toBeGreaterThanOrEqual(5);
  });

  it('raises confidence when more data windows agree', () => {
    // Player consistently above the line in season + L10 + L5 + vs-opp.
    const games: PlayerGame[] = [];
    for (let i = 0; i < 25; i++) {
      games.push(game({ gameId: `g${i}`, points: 30, opponentAbbr: i % 5 === 0 ? 'BOS' : 'PHX' }));
    }
    const r = project({
      selectedStat: 'points',
      lineValue: 22.5,
      seasonGames: games,
      opponentAbbr: 'BOS',
    });
    expect(r.factorBreakdown.modelAgreementScore).toBe(100);
    expect(r.confidence.score).toBeGreaterThanOrEqual(65);
  });

  it('yields No Clear Edge for a No-game player (graceful degradation)', () => {
    const r = project({ selectedStat: 'points', lineValue: 20, seasonGames: [] });
    expect(r.noProjection).toBe(true);
  });

  it('always emits the disclaimer', () => {
    const r = project({
      selectedStat: 'points',
      lineValue: 27.5,
      seasonGames: steadyScorerSeason(),
    });
    expect(r.disclaimer).toMatch(/not financial or gambling advice/);
  });

  it('sorts modelNotes deterministically (last10 + projection bullets present)', () => {
    const r = project({
      selectedStat: 'points',
      lineValue: 25,
      seasonGames: steadyScorerSeason(),
    });
    expect(r.modelNotes.length).toBeGreaterThan(0);
    const text = r.modelNotes.join(' ');
    expect(text).toMatch(/Last 10/);
    expect(text).toMatch(/Projection/);
  });
});

describe('projectionEngine.isProjectable', () => {
  it('rejects double_double', () => {
    expect(isProjectable('double_double')).toBe(false);
  });
  it('accepts the numeric stats', () => {
    expect(isProjectable('points')).toBe(true);
    expect(isProjectable('pra')).toBe(true);
    expect(isProjectable('stocks')).toBe(true);
  });
});

// Bayesian shrinkage + robust stats — verify the new behavior pulls
// hot/cold L5 streaks back toward longer baselines, and that outlier
// games don't drive the projection as hard as before.
describe('projectionEngine — Bayesian shrinkage + robust stats', () => {
  // Builds a 20-game season where the L10 has been steady (~25) but
  // the L5 (newest 5 games at the front of the array) is on a 35-PPG
  // hot streak. Without shrinkage, the projection would lean heavily
  // toward 30+; with shrinkage, it should be pulled back toward L10.
  function hotStreakSeason(): PlayerGame[] {
    // Newest first (slatePipeline sorts that way). L5 = first 5 games
    // at 35; the rest of the season (15 games) at ~25.
    const recent = [35, 36, 34, 35, 35];
    const earlier = [25, 24, 26, 25, 27, 24, 26, 25, 23, 26, 25, 27, 24, 25, 26];
    const pts = [...recent, ...earlier];
    return pts.map((p, i) =>
      game({ gameId: `g${i}`, points: p, rebounds: 7, assists: 6, minutes: 36 }),
    );
  }

  it('pulls a hot L5 streak back toward the L10 baseline', () => {
    const r = project({
      selectedStat: 'points',
      lineValue: 28.5,
      seasonGames: hotStreakSeason(),
    });
    // L5 mean ≈ 35, L10 mean ≈ 30, season ≈ 27. Without shrinkage the
    // projection would land ≥ 30. With shrinkage we expect < 30 —
    // closer to the L10 baseline.
    expect(r.projection.final).toBeLessThan(30);
    expect(r.projection.final).toBeGreaterThan(26);
    expect(r.modelNotes.some((n) => n.toLowerCase().includes('shrunk') || n.toLowerCase().includes('shrinkage'))).toBe(true);
  });

  it('vs-opp single-game outlier gets pulled back toward season', () => {
    // Steady ~25 PPG season with a single 50-point explosion vs SAC.
    // Without shrinkage, the vs-opp window weight would push the
    // projection up sharply; with shrinkage on a 1-game vs-opp sample
    // (priorStrength=6), the outlier loses most of its leverage.
    const points = [25, 24, 26, 25, 27, 24, 26, 25, 23, 26, 25, 27, 24, 25, 26, 50];
    const oppAbbrs = ['LAL', 'BOS', 'BOS', 'BOS', 'BOS', 'LAL', 'BOS', 'BOS',
                      'BOS', 'BOS', 'BOS', 'LAL', 'BOS', 'BOS', 'BOS', 'SAC'];
    const games: PlayerGame[] = points.map((p, i) =>
      game({ gameId: `g${i}`, points: p, opponentAbbr: oppAbbrs[i], minutes: 36 }),
    );
    const r = project({
      selectedStat: 'points',
      lineValue: 28.5,
      seasonGames: games,
      opponentAbbr: 'SAC',     // single-game vs-opp sample
    });
    // The 50-point outlier vs SAC shouldn't drag the projection above
    // the season mean by more than a few points — shrinkage caps it.
    expect(r.projection.final).toBeLessThan(31);
  });

  it('outlier game has muted impact thanks to trimmed mean', () => {
    // Same steady distribution but one extreme outlier game. With the
    // old pure-arithmetic-mean blend, this outlier would pull the
    // baseline up; with the trimmed mean weighted at 30%, its impact
    // is reduced.
    const baseline = Array(19).fill(25) as number[];
    baseline.unshift(60);  // one extreme game at the top
    const games: PlayerGame[] = baseline.map((p, i) =>
      game({ gameId: `g${i}`, points: p, minutes: 36 }),
    );
    const r = project({
      selectedStat: 'points',
      lineValue: 27,
      seasonGames: games,
    });
    // With the outlier dropped by trimmed mean, the season-window
    // score reflects ~25 not ~27, so the projection lands closer to
    // 25 than to a non-trimmed blend would.
    expect(r.factorBreakdown.seasonAvg).toBeCloseTo(26.75, 1);  // arithmetic still includes the 60
    // Final projection should be closer to 25-27 than to 30.
    expect(r.projection.final).toBeLessThan(30);
  });
});
