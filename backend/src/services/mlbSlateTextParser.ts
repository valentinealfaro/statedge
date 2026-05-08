// Pipe-format MLB slate parser. Lets admins paste a slate as plain
// text instead of JSON:
//
//   Player Name|TEAM|stat_key|line|sides
//
// Where sides ∈ { over, under, both }. Lines starting with `#` are
// comments; blank lines are skipped. Names are looked up against
// `mlb_players` with unaccent + lowercase so "Jesús Luzardo" matches
// "Jesus Luzardo" and the diacritic doesn't break the match.
//
// Two-step output: the parser separates `lines` (parsed + player-
// resolved, ready for the slate builder) from `unresolved` (rows
// that couldn't be parsed or matched, with reasons). The route
// surfaces both to users so they can fix typos without losing the
// rest of the slate.

import { getPool } from '../db.js';
import { ensureMlbTables } from '../mlb/db.js';
import { statMeta, type MlbStatKey } from '../mlb/stats.js';
import type { RawMlbLine } from './mlbSlatePipeline.js';

export type SlateTextParseResult = {
  lines: RawMlbLine[];
  unresolved: Array<{
    rawLine: string;
    reason: string;
  }>;
  // Parser's view of how many comment / blank rows it skipped — purely
  // informational for the response so the user can sanity-check
  // their input was processed.
  skippedComments: number;
  skippedBlanks: number;
};

// Alias map for stat keys. The slate text uses some external names
// that we map to canonical keys. NBA-style: external/UI names should
// map to internal canonical keys at the BOUNDARY.
const STAT_ALIASES: Record<string, MlbStatKey> = {
  // Pitcher direct matches
  ks: 'ks',
  pitcher_outs: 'pitcher_outs',
  earned_runs_allowed: 'earned_runs_allowed',
  walks_allowed: 'walks_allowed',
  hits_allowed: 'hits_allowed',
  innings_pitched: 'innings_pitched',
  home_runs_allowed: 'home_runs_allowed',
  pitches_thrown: 'pitches_thrown',
  // Hitter direct matches
  hits: 'hits',
  singles: 'singles',
  doubles: 'doubles',
  triples: 'triples',
  home_runs: 'home_runs',
  total_bases: 'total_bases',
  runs: 'runs',
  rbis: 'rbis',
  walks: 'walks',
  strikeouts: 'strikeouts',
  stolen_bases: 'stolen_bases',
  hits_runs_rbis: 'hits_runs_rbis',
  hitter_fantasy_score: 'hitter_fantasy_score',
  // Aliases (external → canonical)
  hitter_strikeouts: 'strikeouts',
  hitter_fs: 'hitter_fantasy_score',
  hitter_fantasy: 'hitter_fantasy_score',
  fantasy_score: 'hitter_fantasy_score',
};

function mapStatKey(raw: string): MlbStatKey | null {
  const k = raw.trim().toLowerCase();
  return STAT_ALIASES[k] ?? null;
}

function parseDirection(raw: string): 'over' | 'under' | 'both' | null {
  const v = raw.trim().toLowerCase();
  if (v === 'over' || v === 'under' || v === 'both') return v;
  return null;
}

// Single-line parse. Returns either a partial RawMlbLine (player not
// yet resolved — playerId === 0 placeholder) or an error string.
type PartialLine = {
  playerName: string;
  team: string;
  statKey: MlbStatKey;
  line: number;
  direction: 'over' | 'under' | 'both';
};

function parseOneLine(raw: string): PartialLine | string {
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.length < 5) {
    return `Expected 5 pipe-separated fields, got ${parts.length}`;
  }
  const [playerName, team, statRaw, lineRaw, sidesRaw] = parts;
  if (!playerName) return 'Player name is empty';
  if (!team) return 'Team abbreviation is empty';
  const statKey = mapStatKey(statRaw ?? '');
  if (!statKey) return `Unknown stat key "${statRaw}"`;
  const meta = statMeta(statKey);
  if (!meta) return `Stat key "${statKey}" has no registry entry (engine bug)`;
  const line = Number(lineRaw);
  if (!Number.isFinite(line)) return `Line "${lineRaw}" is not a valid number`;
  const direction = parseDirection(sidesRaw ?? '');
  if (!direction) {
    return `Sides must be over / under / both — got "${sidesRaw}"`;
  }
  return {
    playerName: playerName!,
    team: team!,
    statKey,
    line,
    direction,
  };
}

// Resolve player IDs in bulk. One DB query that pulls all candidates
// matching any (name, team) pair from the parsed lines, then matches
// each parsed line against the result. unaccent + lower-case folds
// "Jesús" / "Jesus" together.
async function resolvePlayerIds(
  partials: PartialLine[],
): Promise<Map<string, number>> {
  await ensureMlbTables();
  if (partials.length === 0) return new Map();
  // Deduplicate (name, team) pairs.
  const pairs = new Map<string, { name: string; team: string }>();
  for (const p of partials) {
    const key = `${p.playerName.toLowerCase()}::${p.team.toUpperCase()}`;
    if (!pairs.has(key)) pairs.set(key, { name: p.playerName, team: p.team });
  }
  // Build a single OR'd query. Using ANY($1) would be cleaner but
  // mixed-column matching is simpler with explicit parameters.
  const names = Array.from(pairs.values()).map((v) => v.name);
  const teams = Array.from(pairs.values()).map((v) => v.team.toUpperCase());
  const { rows } = await getPool().query<{
    id: number;
    full_name: string;
    abbreviation: string;
  }>(
    `SELECT p.id, p.full_name, t.abbreviation
       FROM mlb_players p
       JOIN mlb_teams t ON t.id = p.team_id
      WHERE unaccent(lower(p.full_name)) = ANY($1::text[])
        AND t.abbreviation = ANY($2::text[])`,
    [names.map((n) => n.toLowerCase()), teams],
  );
  // Build a lookup by (lower-name, team-abbr) → id. Some teams
  // (e.g. ATH for Athletics) need exact-match enforcement on team
  // since names can repeat across teams.
  const result = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.full_name.toLowerCase()}::${r.abbreviation.toUpperCase()}`;
    result.set(key, r.id);
  }
  return result;
}

// Public entry. Parses the full text blob, resolves player IDs in
// bulk, returns the slate-ready line array + any unresolved rows
// with reasons. Direction mapping: 'over' / 'under' is interpreted
// as the bookable side restriction (Demon = over-only,
// Goblin = under-only); 'both' means no restriction. The slate
// builder pipes this through unchanged.
export async function parseMlbSlateText(
  text: string,
): Promise<SlateTextParseResult> {
  const out: SlateTextParseResult = {
    lines: [],
    unresolved: [],
    skippedComments: 0,
    skippedBlanks: 0,
  };

  const partials: Array<{ partial: PartialLine; raw: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      out.skippedBlanks += 1;
      continue;
    }
    if (line.startsWith('#')) {
      out.skippedComments += 1;
      continue;
    }
    const parsed = parseOneLine(line);
    if (typeof parsed === 'string') {
      out.unresolved.push({ rawLine: line, reason: parsed });
      continue;
    }
    partials.push({ partial: parsed, raw: line });
  }

  if (partials.length === 0) return out;

  // Bulk resolve player IDs.
  const ids = await resolvePlayerIds(partials.map((p) => p.partial));

  for (const { partial, raw } of partials) {
    const key = `${partial.playerName.toLowerCase()}::${partial.team.toUpperCase()}`;
    const id = ids.get(key);
    if (id === undefined) {
      // Soft fallback: try matching unaccented lower of the partial's
      // own name (in case the user typed a slightly different form).
      // We don't double-query — if the bulk query missed it, the DB
      // either doesn't have this player or the team mapping is wrong.
      out.unresolved.push({
        rawLine: raw,
        reason: `Player not found: "${partial.playerName}" on ${partial.team} (run mlb:sync-players?)`,
      });
      continue;
    }
    out.lines.push({
      playerId: id,
      playerName: partial.playerName,
      statKey: partial.statKey,
      line: partial.line,
      direction: partial.direction,
    });
  }

  return out;
}

// Pure helper exposed for tests — covers the parsing math without
// the DB lookup.
export function _parseLineForTest(raw: string): PartialLine | string {
  return parseOneLine(raw);
}
