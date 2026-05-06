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
    // Probability is high but not certain.
    expect(r.probability.over).toBeLessThanOrEqual(99);
    expect(r.probability.over).toBeGreaterThan(50);
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
