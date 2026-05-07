// Fuzzy match raw player names to our players table. Two-step:
//   1. exact match on diacritic-folded lowercase full name
//   2. last-name exact match (handles "L. James" → "LeBron James")
//   3. Levenshtein distance ≤ 2 across the candidate pool
// Multiple matches: prefer is_active = true, then non-null team_id.

export type PlayerCandidate = {
  id: number;
  fullName: string;
  isActive: boolean;
  teamId: number | null;
};

export type ResolveResult =
  | { ok: true; playerId: number; fullName: string; matchType: 'exact' | 'last_name' | 'fuzzy' }
  | { ok: false; reason: 'no_player_match' | 'ambiguous' };

// Trailing generation suffixes the NBA roster uses ("Ron Holland II",
// "Larry Nance Jr", "Marcus Morris Sr") that PrizePicks usually drops.
// We strip them on both sides of the match so "Ronald Holland" can
// resolve to "Ron Holland II" via the last-name path.
const NAME_SUFFIXES = new Set(['ii', 'iii', 'iv', 'v', 'jr', 'sr']);

function fold(s: string): string {
  const base = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')   // strip punctuation + apostrophes
    .replace(/\s+/g, ' ')
    .trim();
  // Drop trailing generation suffixes: "ron holland ii" → "ron holland"
  const parts = base.split(' ');
  while (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length - 1]!)) {
    parts.pop();
  }
  return parts.join(' ');
}

// Iterative O(m*n) Levenshtein. Players have short names so this is fine
// for resolving 16 lines against 525 candidates per request.
function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

// Pick the best candidate when multiple match by edit distance at the
// same cost: active players first, then those with a real team_id.
function rankBetter(a: PlayerCandidate, b: PlayerCandidate): number {
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  const aT = a.teamId ?? 0;
  const bT = b.teamId ?? 0;
  if ((aT > 0) !== (bT > 0)) return aT > 0 ? -1 : 1;
  return 0;
}

export function resolvePlayerName(
  raw: string,
  candidates: PlayerCandidate[],
  maxDistance = 2,
): ResolveResult {
  const target = fold(raw);
  if (!target) return { ok: false, reason: 'no_player_match' };

  // 1. Exact match
  const exact = candidates.filter((c) => fold(c.fullName) === target);
  if (exact.length === 1) {
    return { ok: true, playerId: exact[0]!.id, fullName: exact[0]!.fullName, matchType: 'exact' };
  }
  if (exact.length > 1) {
    const best = [...exact].sort(rankBetter)[0]!;
    return { ok: true, playerId: best.id, fullName: best.fullName, matchType: 'exact' };
  }

  // 2. Last-name match — handles "L. James", "Williams" alone, etc.
  const targetParts = target.split(' ');
  const targetLast = targetParts[targetParts.length - 1]!;
  if (targetLast.length >= 4) {
    const lastNameMatches = candidates.filter((c) => {
      const parts = fold(c.fullName).split(' ');
      return parts[parts.length - 1] === targetLast;
    });
    if (lastNameMatches.length === 1) {
      const m = lastNameMatches[0]!;
      return { ok: true, playerId: m.id, fullName: m.fullName, matchType: 'last_name' };
    }
    if (lastNameMatches.length > 1) {
      if (targetParts.length >= 2) {
        // Multi-word input ("L. James", "Tyrese Haliburton") — try the
        // first-initial filter to disambiguate among the last-name pool.
        const firstInitial = targetParts[0]![0];
        const initialMatches = lastNameMatches.filter(
          (c) => fold(c.fullName).startsWith(firstInitial!),
        );
        if (initialMatches.length === 1) {
          const m = initialMatches[0]!;
          return { ok: true, playerId: m.id, fullName: m.fullName, matchType: 'last_name' };
        }
      } else {
        // Single-word input — fall back to active+teamed ranking, since
        // there's no first-name signal to disambiguate with.
        const winner = [...lastNameMatches].sort(rankBetter)[0]!;
        return { ok: true, playerId: winner.id, fullName: winner.fullName, matchType: 'last_name' };
      }
    }
  }

  // 3. Levenshtein over the whole pool. Only consider candidates within
  //    maxDistance; if multiple tie, fall back to active+teamed.
  let bestDist = maxDistance + 1;
  let bestList: PlayerCandidate[] = [];
  for (const c of candidates) {
    const d = lev(fold(c.fullName), target);
    if (d < bestDist) {
      bestDist = d;
      bestList = [c];
    } else if (d === bestDist) {
      bestList.push(c);
    }
  }
  if (bestDist <= maxDistance && bestList.length > 0) {
    const winner = [...bestList].sort(rankBetter)[0]!;
    return { ok: true, playerId: winner.id, fullName: winner.fullName, matchType: 'fuzzy' };
  }

  return { ok: false, reason: 'no_player_match' };
}
