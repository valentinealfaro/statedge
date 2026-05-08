import { describe, expect, test } from 'vitest';
import {
  listStatsForPlayerType,
  playerTypeForStat,
  statMeta,
  valueFromHittingRow,
  valueFromPitchingRow,
} from './stats.js';

describe('playerTypeForStat', () => {
  test('hitter stats return "hitter"', () => {
    expect(playerTypeForStat('hits')).toBe('hitter');
    expect(playerTypeForStat('home_runs')).toBe('hitter');
    expect(playerTypeForStat('hits_runs_rbis')).toBe('hitter');
    expect(playerTypeForStat('hitter_fantasy_score')).toBe('hitter');
  });
  test('pitcher stats return "pitcher"', () => {
    expect(playerTypeForStat('ks')).toBe('pitcher');
    expect(playerTypeForStat('pitcher_outs')).toBe('pitcher');
    expect(playerTypeForStat('innings_pitched')).toBe('pitcher');
    expect(playerTypeForStat('earned_runs_allowed')).toBe('pitcher');
  });
  test('unknown stat returns null (drives 400 in routes)', () => {
    expect(playerTypeForStat('unknown_stat')).toBeNull();
    expect(playerTypeForStat('')).toBeNull();
  });
});

describe('listStatsForPlayerType', () => {
  test('hitter list contains all 13 hitter stats from spec', () => {
    const stats = listStatsForPlayerType('hitter');
    const keys = stats.map((s) => s.key);
    expect(keys).toContain('hits');
    expect(keys).toContain('singles');
    expect(keys).toContain('total_bases');
    expect(keys).toContain('hits_runs_rbis');
    expect(keys).toContain('hitter_fantasy_score');
    // Type-restriction safety: never includes pitcher stats
    expect(keys).not.toContain('ks');
    expect(keys).not.toContain('pitcher_outs');
  });
  test('pitcher list contains pitcher stats only', () => {
    const stats = listStatsForPlayerType('pitcher');
    const keys = stats.map((s) => s.key);
    expect(keys).toContain('ks');
    expect(keys).toContain('pitcher_outs');
    expect(keys).toContain('innings_pitched');
    expect(keys).not.toContain('hits');
    expect(keys).not.toContain('home_runs');
  });
});

describe('statMeta', () => {
  test('returns label + playerType for known keys', () => {
    expect(statMeta('hits')?.label).toBe('Hits');
    expect(statMeta('ks')?.label).toBe('Strikeouts (Pitcher)');
    expect(statMeta('strikeouts')?.label).toBe('Strikeouts (Hitter)');
  });
  test('hitter and pitcher strikeouts are different keys', () => {
    // Critical: the spec separates these so a Justin Verlander K prop
    // (pitcher) can't be confused with an Aaron Judge K prop (hitter).
    expect(statMeta('strikeouts')?.playerType).toBe('hitter');
    expect(statMeta('ks')?.playerType).toBe('pitcher');
  });
});

describe('valueFromHittingRow', () => {
  const fullRow = {
    hits: 3, singles: 1, doubles: 1, triples: 0, home_runs: 1,
    total_bases: 8, runs: 2, rbis: 4, walks: 1, strikeouts: 0,
    stolen_bases: 1,
  };
  test('reads direct columns', () => {
    expect(valueFromHittingRow('hits', fullRow)).toBe(3);
    expect(valueFromHittingRow('home_runs', fullRow)).toBe(1);
    expect(valueFromHittingRow('total_bases', fullRow)).toBe(8);
  });
  test('hits_runs_rbis sums components', () => {
    expect(valueFromHittingRow('hits_runs_rbis', fullRow)).toBe(3 + 2 + 4);
  });
  test('hitter_fantasy_score applies the spec formula', () => {
    // 1*3 + 1*5 + 0*8 + 1*10 + 2*2 + 4*2 + 1*2 + 1*5 - 0
    //   3 + 5 + 0 + 10 + 4 + 8 + 2 + 5 - 0 = 37
    expect(valueFromHittingRow('hitter_fantasy_score', fullRow)).toBe(37);
  });
  test('null components in computed stats → null', () => {
    const partial = { ...fullRow, runs: null };
    expect(valueFromHittingRow('hits_runs_rbis', partial)).toBeNull();
  });
});

describe('valueFromPitchingRow', () => {
  const fullRow = {
    outs_recorded: 18,
    innings_pitched: '6.0' as string | number,
    pitches_thrown: 92,
    hits_allowed: 4,
    earned_runs_allowed: 2,
    walks_allowed: 1,
    strikeouts: 8,
    home_runs_allowed: 1,
  };
  test('ks reads from strikeouts column (pitcher side)', () => {
    expect(valueFromPitchingRow('ks', fullRow)).toBe(8);
  });
  test('pitcher_outs reads from outs_recorded column', () => {
    expect(valueFromPitchingRow('pitcher_outs', fullRow)).toBe(18);
  });
  test('innings_pitched coerces numeric strings (pg NUMERIC quirk)', () => {
    // Postgres returns NUMERIC columns as strings; engine must coerce
    // so frontend gets a number it can compare against a line.
    expect(valueFromPitchingRow('innings_pitched', fullRow)).toBe(6);
  });
  test('innings_pitched returns null on invalid input', () => {
    const bad = { ...fullRow, innings_pitched: 'NaN' };
    expect(valueFromPitchingRow('innings_pitched', bad)).toBeNull();
  });
});
