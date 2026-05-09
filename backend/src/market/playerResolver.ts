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

// Team resolution — full team name → { abbreviation, id }. Used by
// providers that emit full names like "Toronto Blue Jays" instead of
// "TOR". The Odds API returns home_team / away_team as full names.
export type ResolvedTeam = {
  id: number;
  abbreviation: string;
  fullName: string;
};

export async function resolveMlbTeamFromFullName(
  rawName: string,
): Promise<ResolvedTeam | null> {
  const target = fold(rawName);
  if (!target) return null;
  const { rows } = await getPool().query<{
    id: number;
    abbreviation: string;
    full_name: string;
  }>(
    `SELECT id, abbreviation, full_name FROM mlb_teams`,
  );
  for (const r of rows) {
    if (fold(r.full_name) === target) {
      return { id: r.id, abbreviation: r.abbreviation, fullName: r.full_name };
    }
  }
  return null;
}

// MLB player resolver. Three-stage match:
//   1. Exact case-insensitive (DB-side LOWER) match.
//   2. Folded match (strips suffixes Jr/Sr/II/III + non-alphanumerics).
//   3. Last-name unique match — only when one player has that surname.
// Uses the indexed lower(full_name) for stage 1 so the hot path stays
// fast even with thousands of players. Stages 2-3 only fire on misses.
export async function resolveMlbPlayer(
  rawName: string,
): Promise<ResolvedPlayer | null> {
  const trimmed = rawName.trim();
  if (!trimmed) return null;
  const pool = getPool();

  // Stage 1 — exact case-insensitive (uses mlb_players_full_name_idx).
  const { rows: exact } = await pool.query<{
    id: number;
    full_name: string;
    team_abbr: string | null;
  }>(
    `SELECT p.id, p.full_name, t.abbreviation AS team_abbr
       FROM mlb_players p
  LEFT JOIN mlb_teams t ON t.id = p.team_id
      WHERE LOWER(p.full_name) = LOWER($1)
      LIMIT 1`,
    [trimmed],
  );
  if (exact[0]) {
    return { internalId: exact[0].id, fullName: exact[0].full_name, team: exact[0].team_abbr };
  }

  // Stage 2 — folded full-name match. Catches "Lebron James Jr." vs
  // "LeBron James" and similar punctuation/suffix variants. Only fires
  // when stage 1 missed.
  const target = fold(trimmed);
  if (!target) return null;
  const { rows: candidates } = await pool.query<{
    id: number;
    full_name: string;
    team_abbr: string | null;
  }>(
    `SELECT p.id, p.full_name, t.abbreviation AS team_abbr
       FROM mlb_players p
  LEFT JOIN mlb_teams t ON t.id = p.team_id`,
  );
  for (const r of candidates) {
    if (fold(r.full_name) === target) {
      return { internalId: r.id, fullName: r.full_name, team: r.team_abbr };
    }
  }

  // Stage 3 — last-name unique match. Splits both target + candidate
  // by space, takes the trailing token. Only commits when exactly one
  // candidate's last name matches — avoids "Smith" returning the
  // wrong Smith out of 12.
  const targetParts = trimmed.toLowerCase().split(/\s+/);
  const targetLast = targetParts[targetParts.length - 1];
  if (!targetLast || targetLast.length < 3) return null;
  const surnameMatches = candidates.filter((r) => {
    const parts = r.full_name.toLowerCase().split(/\s+/);
    const last = parts[parts.length - 1];
    return last === targetLast;
  });
  if (surnameMatches.length === 1) {
    const m = surnameMatches[0]!;
    return { internalId: m.id, fullName: m.full_name, team: m.team_abbr };
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
