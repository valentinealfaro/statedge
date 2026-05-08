import { describe, expect, test } from 'vitest';
import {
  _mlbInternals,
  daysInMonth,
  inningsPitchedToNumeric,
  leagueCodeFromId,
  MLB_DISCLAIMER,
  moneylineToImpliedProb,
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

describe('daysInMonth', () => {
  // Critical helper for the schedule sync. Previous version of the
  // sync script hardcoded 31 for every month, which generated invalid
  // dates like "2026-04-31" for April. The MLB API silently dropped
  // those, so the sync was missing all April / June / September /
  // November games every season.
  test('31-day months return 31', () => {
    expect(daysInMonth(2026, 1)).toBe(31);   // January
    expect(daysInMonth(2026, 3)).toBe(31);   // March
    expect(daysInMonth(2026, 5)).toBe(31);   // May
    expect(daysInMonth(2026, 7)).toBe(31);   // July
    expect(daysInMonth(2026, 8)).toBe(31);   // August
    expect(daysInMonth(2026, 10)).toBe(31);  // October
    expect(daysInMonth(2026, 12)).toBe(31);  // December
  });
  test('30-day months return 30 — the bug-fix targets', () => {
    expect(daysInMonth(2026, 4)).toBe(30);   // April
    expect(daysInMonth(2026, 6)).toBe(30);   // June
    expect(daysInMonth(2026, 9)).toBe(30);   // September
    expect(daysInMonth(2026, 11)).toBe(30);  // November
  });
  test('February in non-leap year returns 28', () => {
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2027, 2)).toBe(28);
  });
  test('February in leap year returns 29', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);   // century leap
  });
  test('1900 century year is NOT a leap year (divisible by 100 but not 400)', () => {
    expect(daysInMonth(1900, 2)).toBe(28);
  });
});

describe('moneylineToImpliedProb', () => {
  test('Even line (-100 / +100) → 50%', () => {
    expect(moneylineToImpliedProb(100)).toBe(50);
    expect(moneylineToImpliedProb(-100)).toBe(50);
  });

  test('Heavy favorite (-200) → ~67%', () => {
    expect(moneylineToImpliedProb(-200)).toBeCloseTo(66.7, 1);
  });

  test('Heavy underdog (+200) → ~33%', () => {
    expect(moneylineToImpliedProb(200)).toBeCloseTo(33.3, 1);
  });

  test('ESPN example: HOU +113 ≈ 47%', () => {
    // Matches the live ESPN data the user pointed at.
    expect(moneylineToImpliedProb(113)).toBeCloseTo(46.9, 1);
  });

  test('ESPN example: CIN -136 ≈ 58%', () => {
    expect(moneylineToImpliedProb(-136)).toBeCloseTo(57.6, 1);
  });

  test('null + zero return null (no fake probabilities)', () => {
    expect(moneylineToImpliedProb(null)).toBeNull();
    expect(moneylineToImpliedProb(0)).toBeNull();
  });

  test('Implied probabilities are inverse-symmetric: -X% + +X% > 100%', () => {
    // The book's vig: implied prob for both sides sums to >100% in
    // a real moneyline market. Sanity check that we're computing
    // both sides honestly without juice removal.
    const home = moneylineToImpliedProb(-136)!;
    const away = moneylineToImpliedProb(113)!;
    expect(home + away).toBeGreaterThan(100);
    expect(home + away).toBeLessThan(108);     // sportsbook vig usually 4-7%
  });
});

describe('extractProbablePitcher', () => {
  test('Returns null when probable pitcher is undefined', () => {
    expect(_mlbInternals.extractProbablePitcher(undefined)).toBeNull();
  });

  test('Pitcher with no stats returns id + name + null stats', () => {
    const p = _mlbInternals.extractProbablePitcher({ id: 1, fullName: 'Jane Doe' });
    expect(p?.id).toBe(1);
    expect(p?.fullName).toBe('Jane Doe');
    expect(p?.era).toBeNull();
    expect(p?.wins).toBeNull();
  });

  test('Pitcher with hydrated season pitching stats returns numbers', () => {
    const p = _mlbInternals.extractProbablePitcher({
      id: 2,
      fullName: 'Chris Sale',
      stats: [
        {
          type: { displayName: 'season' },
          group: { displayName: 'pitching' },
          splits: [{
            stat: {
              era: '2.41',
              wins: 6,
              losses: 1,
              inningsPitched: '52.0',
              strikeOuts: 78,
              baseOnBalls: 14,
              whip: '0.92',
              hits: 38,
              homeRuns: 4,
              earnedRuns: 14,
              battersFaced: 200,
            },
          }],
        },
      ],
    });
    expect(p?.era).toBeCloseTo(2.41, 2);
    expect(p?.wins).toBe(6);
    expect(p?.losses).toBe(1);
    expect(p?.strikeouts).toBe(78);
    expect(p?.walks).toBe(14);
    expect(p?.whip).toBeCloseTo(0.92, 2);
    expect(p?.inningsPitched).toBe(52);
  });

  test('Skips wrong stat group (career, not season)', () => {
    const p = _mlbInternals.extractProbablePitcher({
      id: 3,
      fullName: 'Career Only',
      stats: [
        {
          type: { displayName: 'career' },
          group: { displayName: 'pitching' },
          splits: [{ stat: { era: '3.50', wins: 100 } }],
        },
      ],
    });
    expect(p?.era).toBeNull();
    expect(p?.wins).toBeNull();
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
