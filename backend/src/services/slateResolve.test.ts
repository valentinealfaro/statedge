import { describe, expect, test } from 'vitest';
import { resolvePlayerName, type PlayerCandidate } from './slateResolve.js';

function p(id: number, fullName: string, isActive = true, teamId: number | null = 1): PlayerCandidate {
  return { id, fullName, isActive, teamId };
}

describe('resolvePlayerName', () => {
  test('exact match resolves', () => {
    const r = resolvePlayerName('LeBron James', [p(1, 'LeBron James')]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.playerId).toBe(1);
      expect(r.matchType).toBe('exact');
    }
  });

  test('strips trailing "II" / "Jr" / "Sr" suffixes for matching', () => {
    // PrizePicks sends "Ronald Holland", DB has "Ron Holland II".
    // Fix: fold() drops the "ii" suffix on the DB side, so the last-
    // name path catches "Ronald Holland" → "Ron Holland II" via
    // shared last name + matching first initial.
    const r = resolvePlayerName('Ronald Holland', [p(42, 'Ron Holland II')]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.playerId).toBe(42);

    // Also handles Jr/Sr.
    const r2 = resolvePlayerName('Larry Nance', [p(7, 'Larry Nance Jr.')]);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.playerId).toBe(7);
  });

  test('Levenshtein fallback catches small typos', () => {
    // 'Hartin' → 'Hardin' (1 edit). Should fuzzy-match.
    const r = resolvePlayerName('James Hartin', [p(13, 'James Harden')]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matchType).toBe('fuzzy');
  });

  test('returns no_player_match for completely unknown names', () => {
    const r = resolvePlayerName('Totally Made Up', [p(1, 'LeBron James')]);
    expect(r.ok).toBe(false);
  });

  test('disambiguates same-last-name players via first-initial', () => {
    // Two Hollands; "Ronald" starts with R → should match Ron Holland.
    const r = resolvePlayerName('Ronald Holland', [
      p(42, 'Ron Holland II'),
      p(99, 'Steve Holland'),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.playerId).toBe(42);
  });
});
