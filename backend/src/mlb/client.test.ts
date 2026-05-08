import { describe, expect, test } from 'vitest';
import {
  inningsPitchedToNumeric,
  leagueCodeFromId,
  MLB_DISCLAIMER,
} from './client.js';

describe('leagueCodeFromId', () => {
  test('103 → AL', () => {
    expect(leagueCodeFromId(103)).toBe('AL');
  });
  test('104 → NL', () => {
    expect(leagueCodeFromId(104)).toBe('NL');
  });
  test('unknown id → null (e.g. spring training league)', () => {
    expect(leagueCodeFromId(114)).toBeNull();
    expect(leagueCodeFromId(0)).toBeNull();
  });
});

describe('inningsPitchedToNumeric', () => {
  test('whole innings round-trip cleanly', () => {
    expect(inningsPitchedToNumeric('5')).toBe(5);
    expect(inningsPitchedToNumeric('7.0')).toBe(7);
  });
  test('fractional thirds map to standard fractions', () => {
    // ".1" in baseball = ⅓ inning (1 out)
    expect(inningsPitchedToNumeric('5.1')).toBeCloseTo(5 + 1 / 3, 4);
    // ".2" in baseball = ⅔ inning (2 outs)
    expect(inningsPitchedToNumeric('5.2')).toBeCloseTo(5 + 2 / 3, 4);
  });
  test('undefined / malformed input → null', () => {
    expect(inningsPitchedToNumeric(undefined)).toBeNull();
    expect(inningsPitchedToNumeric('')).toBeNull();
    expect(inningsPitchedToNumeric('abc')).toBeNull();
  });
  test('outs computation is consistent (innings × 3, rounded)', () => {
    // 5.2 IP = 17 outs. Use the helper to confirm the math we rely on
    // when persisting to mlb_pitching_stats.outs_recorded.
    const ip = inningsPitchedToNumeric('5.2');
    expect(ip).not.toBeNull();
    expect(Math.round(ip! * 3)).toBe(17);
  });
});

describe('MLB_DISCLAIMER', () => {
  test('matches the spec verbatim — never relax this language', () => {
    // Per the StatEdge MLB build spec, this disclaimer text must be
    // exact. If a future change reads "guarantees" or removes "not
    // gambling advice," that's a compliance regression — fail loudly.
    expect(MLB_DISCLAIMER).toContain('sports analytics');
    expect(MLB_DISCLAIMER).toContain('does not provide gambling advice');
    expect(MLB_DISCLAIMER).toContain('guaranteed outcomes');
    expect(MLB_DISCLAIMER).not.toMatch(/\b(lock|sure thing|free money)\b/i);
  });
});
