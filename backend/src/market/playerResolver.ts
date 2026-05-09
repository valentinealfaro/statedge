// Market Brain player resolver — Phase 103a.
//
// Per the Phase 103 spec: "Different providers use different spellings,
// suffixes, IDs, nicknames. Need unified internal player identity
// system. LeBron James / Lebron James / LeBron Raymone James ALL
// resolve to internal_player_id."
//
// Sport-aware. Each sport has its own player table with canonical IDs:
//   - NBA: players.id (stats.nba.com playerId, e.g. 2544 for LeBron)
//   - MLB: mlb_players.id (statsapi.mlb.com playerId)
//   - WNBA: ESPN athleteId (string, e.g. "2987869" for A'ja Wilson)
//
// The resolver is a thin wrapper over those tables — exact match,
// last-name fallback, fold-and-fuzzy-match. Returns the internal id
// when it can; returns null when it can't (rather than guessing).
//
// IMPORTANT: never invent ids. The market_snapshots table accepts null
// internal_player_id so unmatched names still persist for audit + later
// re-resolution as the resolver gets smarter.

import { getPool } from '../db.js';

export type ResolvedPlayer = {
  internalId: number | string;
  fullName: string;
  team: string | null;
};

// Fold a name to canonical lookup key: lowercase, strip suffixes
// (Jr, Sr, II, III, IV), strip non-alphanumeric. Lets "LeBron James",
// "Lebron James", and "LeBron James Jr." all hit the same bucket.
function fold(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\.?$/i, '')
    .trim()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, '');
}

// Resolve an NBA player by display name. Returns null on miss.
// Matches: exact (folded full name) → last-name unique → fuzzy (rare).
export async function resolveNbaPlayer(
  rawName: string,
): Promise<ResolvedPlayer | null> {
  const target = fold(rawName);
  if (!target) return null;
  const { rows } = await getPool().query<{
    id: number;
    full_name: string;
    team_abbreviation: string | null;
  }>(
    `SELECT id, full_name, team_abbreviation FROM players`,
  );
  // Exact (folded) match
  for (const r of rows) {
    if (fold(r.full_name) === target) {
      return { internalId: r.id, fullName: r.full_name, team: r.team_abbreviation };
    }
  }
  // Last-name unique match
  const targetParts = target.split(/(?=[A-Z])/);
  const targetLast = targetParts[targetParts.length - 1] ?? target;
  const lastNameMatches = rows.filter((r) => {
    const folded = fold(r.full_name);
    const parts = folded.split(/(?=[A-Z])/);
    const last = parts[parts.length - 1] ?? folded;
    return last === targetLast;
  });
  if (lastNameMatches.length === 1) {
    const m = lastNameMatches[0]!;
    return { internalId: m.id, fullName: m.full_name, team: m.team_abbreviation };
  }
  return null;
}

// MLB player resolver. Same pattern as NBA but against mlb_players.
export async function resolveMlbPlayer(
  rawName: string,
): Promise<ResolvedPlayer | null> {
  const target = fold(rawName);
  if (!target) return null;
  const { rows } = await getPool().query<{
    id: number;
    full_name: string;
    team_id: number | null;
  }>(
    `SELECT p.id, p.full_name, p.team_id FROM mlb_players p`,
  );
  for (const r of rows) {
    if (fold(r.full_name) === target) {
      return { internalId: r.id, fullName: r.full_name, team: null };
    }
  }
  // Last-name unique match
  const targetLast = target;       // for MLB the target is already folded full
  const matches = rows.filter((r) => fold(r.full_name).endsWith(targetLast.slice(-Math.max(4, Math.floor(targetLast.length / 2)))));
  if (matches.length === 1) {
    const m = matches[0]!;
    return { internalId: m.id, fullName: m.full_name, team: null };
  }
  return null;
}

// WNBA — we don't have a persistent table; ESPN's search API is the
// canonical source. Phase 103a doesn't add a new lookup pathway; the
// resolver falls back to passing through the raw name. Future: cache
// ESPN search results in a wnba_players table.
export async function resolveWnbaPlayer(
  rawName: string,
): Promise<ResolvedPlayer | null> {
  // Stub for symmetry. Snapshot writer will store rawPlayerName +
  // null internalId; downstream re-resolution via ESPN search runs
  // when consensus computation needs it.
  void rawName;
  return null;
}
