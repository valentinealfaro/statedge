// Builds a (folded player-name → injury status) map for every player on
// today's NBA slate. Used by the slate pipeline so each prop card can
// surface "this player is OUT" before the user adds them to a parlay.
//
// Data source: ESPN's public per-game summary endpoint already wired in
// nba/espn.ts. We fetch today's scoreboard once, then summary for every
// game in parallel, then collapse the per-team injury blocks into a
// single name-keyed map.
//
// Cached in-process for 5 minutes — injuries don't update faster than
// that, and the slate auto-fetch already runs <1× per minute per user.

import { fetchGameSummary, fetchScoreboard } from '../nba/espn.js';

export type InjuryStatus = 'Out' | 'Day-To-Day' | 'Questionable' | 'Doubtful' | 'Probable' | string;

export type InjuryEntry = {
  status: InjuryStatus;
  type?: string;
  date?: string;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; map: Map<string, InjuryEntry> } | null = null;

// Same diacritic + punctuation strip used by the resolver, so the same
// lookup key works on both sides.
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getTodayInjuriesMap(): Promise<Map<string, InjuryEntry>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;

  const out = new Map<string, InjuryEntry>();
  try {
    const board = await fetchScoreboard();
    if (board.games.length === 0) {
      cache = { at: Date.now(), map: out };
      return out;
    }

    // Fetch all summaries in parallel, but tolerate per-game failures —
    // one bad gameId shouldn't tank the whole map.
    const summaries = await Promise.allSettled(
      board.games.map((g) => fetchGameSummary(g.id)),
    );

    for (const s of summaries) {
      if (s.status !== 'fulfilled') continue;
      for (const side of [s.value.away, s.value.home]) {
        for (const inj of side.injuries) {
          const key = fold(inj.displayName);
          if (!key) continue;
          // Last-write-wins is fine — a player can only be on one
          // team, and ESPN reports the same status across both summary
          // calls if the same player appears (which they shouldn't).
          out.set(key, {
            status: inj.status,
            type: inj.type,
          });
        }
      }
    }
  } catch (err) {
    // Graceful degradation: if ESPN is having a bad day, return empty
    // map so slate still renders without injury chips.
    console.error('getTodayInjuriesMap failed', err);
  }

  cache = { at: Date.now(), map: out };
  return out;
}

// Helper for tests / debug — clears the cache.
export function _resetInjuryCache(): void {
  cache = null;
}
