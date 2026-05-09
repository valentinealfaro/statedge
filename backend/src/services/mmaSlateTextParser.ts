// UFC slate text parser — Phase 110a.
//
// Mirrors mlbSlateTextParser.ts but for fight props. PrizePicks UFC
// markets:
//   sig_strikes / rd1_sig_strikes / sig_strikes_landed
//   rounds                                 (1.5, 2.5, 3.5)
//   fight_time                             (in minutes; e.g. 14.99 for full fight)
//   fs / fantasy_score                     (UFC fantasy score)
//   td / takedowns / rd1_takedowns
//   kd / knockdowns
//   control_time                           (in minutes)
//
// Pipe format identical to MLB:
//   FighterName|UFC|stat_key|line|sides
//
// We don't resolve fighter names to a DB — there's no UFC fighter
// table yet. Raw name is stored verbatim; resolution is a future
// phase when we ingest ESPN UFC athlete data into a table.

import type { UfcStatKey } from '../mma/stats.js';

export type MmaSlateParseResult = {
  lines: ParsedMmaLine[];
  unresolved: Array<{ rawLine: string; reason: string }>;
  skippedComments: number;
  skippedBlanks: number;
};

export type ParsedMmaLine = {
  fighterName: string;
  league: string;       // "UFC" today; future-proofed for Bellator/PFL
  statKey: UfcStatKey;
  line: number;
  direction: 'over' | 'under' | 'both';
};

const STAT_ALIASES: Record<string, UfcStatKey> = {
  // Significant strikes
  sig_strikes:           'sig_strikes',
  sig_strikes_landed:    'sig_strikes',
  significant_strikes:   'sig_strikes',
  ss:                    'sig_strikes',
  // Round-1 splits
  rd1_sig_strikes:       'rd1_sig_strikes',
  r1_sig_strikes:        'rd1_sig_strikes',
  rd1_takedowns:         'rd1_takedowns',
  r1_td:                 'rd1_takedowns',
  // Takedowns
  td:                    'takedowns',
  takedowns:             'takedowns',
  // Knockdowns
  kd:                    'knockdowns',
  knockdowns:            'knockdowns',
  // Round / fight-length
  rounds:                'rounds',
  rounds_completed:      'rounds',
  fight_time:            'fight_time',
  fight_length:          'fight_time',
  fight_minutes:         'fight_time',
  // Fantasy
  fs:                    'fantasy_score',
  fantasy_score:         'fantasy_score',
  fantasy:               'fantasy_score',
  // Control
  control_time:          'control_time',
  control:               'control_time',
};

function mapStatKey(raw: string): UfcStatKey | null {
  const k = raw.trim().toLowerCase();
  return STAT_ALIASES[k] ?? null;
}

function parseDirection(raw: string): 'over' | 'under' | 'both' | null {
  const v = raw.trim().toLowerCase();
  if (v === 'over' || v === 'under' || v === 'both') return v;
  return null;
}

function parseOneLine(raw: string): ParsedMmaLine | string {
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.length !== 5) {
    return `Expected 5 pipe-delimited fields, got ${parts.length}`;
  }
  const [fighterName, league, statRaw, lineRaw, dirRaw] = parts;
  if (!fighterName) return 'Missing fighter name';
  if (!league) return 'Missing league';

  const statKey = mapStatKey(statRaw ?? '');
  if (!statKey) return `Unknown stat key "${statRaw}"`;

  const line = Number(lineRaw);
  if (!Number.isFinite(line)) return `Bad line value "${lineRaw}"`;

  const direction = parseDirection(dirRaw ?? '');
  if (!direction) return `Bad direction "${dirRaw}" (expected over | under | both)`;

  return {
    fighterName: fighterName!,
    league: league!.toUpperCase(),
    statKey,
    line,
    direction,
  };
}

export function parseMmaSlateText(input: string): MmaSlateParseResult {
  const lines: ParsedMmaLine[] = [];
  const unresolved: MmaSlateParseResult['unresolved'] = [];
  let skippedComments = 0;
  let skippedBlanks = 0;

  for (const raw of input.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '') { skippedBlanks += 1; continue; }
    if (trimmed.startsWith('#')) { skippedComments += 1; continue; }

    const parsed = parseOneLine(trimmed);
    if (typeof parsed === 'string') {
      unresolved.push({ rawLine: trimmed, reason: parsed });
    } else {
      lines.push(parsed);
    }
  }

  return { lines, unresolved, skippedComments, skippedBlanks };
}
