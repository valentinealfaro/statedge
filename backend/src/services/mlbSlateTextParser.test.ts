// Tests for the pipe-format parser. Player resolution touches the
// DB so we don't unit-test that path; we test the pure
// per-line parsing math (parseOneLine via _parseLineForTest).

import { describe, expect, test } from 'vitest';
import { _parseLineForTest } from './mlbSlateTextParser.js';

describe('mlbSlateTextParser — single-line parsing', () => {
  test('Standard line parses cleanly', () => {
    const r = _parseLineForTest('Aaron Judge|NYY|home_runs|0.5|over');
    expect(r).toEqual({
      playerName: 'Aaron Judge',
      team: 'NYY',
      statKey: 'home_runs',
      line: 0.5,
      direction: 'over',
    });
  });

  test('Diacritic in name preserved', () => {
    const r = _parseLineForTest('Jesús Luzardo|PHI|ks|5.5|over');
    expect(typeof r === 'object' && r.playerName).toBe('Jesús Luzardo');
  });

  test('Whitespace around fields is trimmed', () => {
    const r = _parseLineForTest('  Aaron Judge  | NYY |home_runs| 0.5 | over ');
    expect(typeof r === 'object' && r.playerName).toBe('Aaron Judge');
    expect(typeof r === 'object' && r.team).toBe('NYY');
    expect(typeof r === 'object' && r.line).toBe(0.5);
  });

  test('Stat key alias hitter_strikeouts maps to canonical strikeouts', () => {
    const r = _parseLineForTest('Aaron Judge|NYY|hitter_strikeouts|1.5|over');
    expect(typeof r === 'object' && r.statKey).toBe('strikeouts');
  });

  test('Stat key alias hitter_fs maps to hitter_fantasy_score', () => {
    const r = _parseLineForTest('Aaron Judge|NYY|hitter_fs|6.5|both');
    expect(typeof r === 'object' && r.statKey).toBe('hitter_fantasy_score');
  });

  test('All three sides accepted (over / under / both)', () => {
    const o = _parseLineForTest('A|NYY|hits|1.5|over');
    const u = _parseLineForTest('A|NYY|hits|1.5|under');
    const b = _parseLineForTest('A|NYY|hits|1.5|both');
    expect(typeof o === 'object' && o.direction).toBe('over');
    expect(typeof u === 'object' && u.direction).toBe('under');
    expect(typeof b === 'object' && b.direction).toBe('both');
  });

  test('Pitcher stats parse', () => {
    const r = _parseLineForTest('Chris Sale|ATL|pitcher_outs|17.5|over');
    expect(typeof r === 'object' && r.statKey).toBe('pitcher_outs');
    expect(typeof r === 'object' && r.line).toBe(17.5);
  });

  test('Returns error string for too-few fields', () => {
    const r = _parseLineForTest('Aaron Judge|NYY|home_runs');
    expect(typeof r).toBe('string');
    expect(r).toMatch(/Expected 5 pipe-separated/);
  });

  test('Returns error for unknown stat key', () => {
    const r = _parseLineForTest('Aaron Judge|NYY|made_up_stat|0.5|over');
    expect(typeof r).toBe('string');
    expect(r).toMatch(/Unknown stat key/);
  });

  test('Returns error for bad direction', () => {
    const r = _parseLineForTest('Aaron Judge|NYY|home_runs|0.5|maybe');
    expect(typeof r).toBe('string');
    expect(r).toMatch(/over \/ under \/ both/);
  });

  test('Returns error for non-numeric line', () => {
    const r = _parseLineForTest('Aaron Judge|NYY|home_runs|abc|over');
    expect(typeof r).toBe('string');
    expect(r).toMatch(/not a valid number/);
  });

  test('Empty player name → error', () => {
    const r = _parseLineForTest('|NYY|hits|1.5|over');
    expect(typeof r).toBe('string');
    expect(r).toMatch(/Player name is empty/);
  });

  test('Empty team → error', () => {
    const r = _parseLineForTest('Aaron Judge||hits|1.5|over');
    expect(typeof r).toBe('string');
    expect(r).toMatch(/Team abbreviation is empty/);
  });

  test('Stat keys are case-insensitive in the alias map', () => {
    const r = _parseLineForTest('Aaron Judge|NYY|TOTAL_BASES|2.5|over');
    expect(typeof r === 'object' && r.statKey).toBe('total_bases');
  });

  test('Direction is case-insensitive', () => {
    const r = _parseLineForTest('Aaron Judge|NYY|hits|1.5|OVER');
    expect(typeof r === 'object' && r.direction).toBe('over');
  });
});
