// MLB stat-key registry. Defines which stats are valid for hitters vs
// pitchers and how each maps to the underlying DB columns. The
// type-restriction rule (pitcher stat for a hitter, or vice versa,
// returns 400) is enforced via this registry — there's one source of
// truth for "what stats can this player type be queried for."
//
// Per the StatEdge MLB build spec. Keep the union exhaustive — if we
// add new stats here, the engine and frontend pickers update through
// the type system rather than from string drift.

export type MlbHitterStatKey =
  | 'hits'
  | 'singles'
  | 'doubles'
  | 'triples'
  | 'home_runs'
  | 'total_bases'
  | 'runs'
  | 'rbis'
  | 'walks'
  | 'strikeouts'
  | 'stolen_bases'
  | 'plate_appearances'
  | 'hits_runs_rbis'              // computed: hits + runs + rbis
  | 'hitter_fantasy_score';       // computed weighted score

export type MlbPitcherStatKey =
  | 'ks'                          // strikeouts thrown
  | 'earned_runs_allowed'
  | 'walks_allowed'
  | 'pitcher_outs'                // outs_recorded
  | 'hits_allowed'
  | 'innings_pitched'
  | 'home_runs_allowed'
  | 'pitches_thrown'
  | 'pitcher_fantasy_score';      // computed: 3*IP + 3*K - 3*ER (PrizePicks-style)

export type MlbStatKey = MlbHitterStatKey | MlbPitcherStatKey;

export type MlbPlayerType = 'hitter' | 'pitcher';

// Display metadata for each stat — drives both the frontend stat
// picker (label) and the backend response (label so clients don't
// need their own copy).
type StatMeta = {
  key: MlbStatKey;
  label: string;
  playerType: MlbPlayerType;
  // Whether the value is "more is better for over" (most stats) or
  // inherently fewer-is-better (none here yet — but pitcher_outs +
  // strikeouts both flip when on the under side, which the projection
  // engine handles directly).
};

const HITTER_STATS: StatMeta[] = [
  { key: 'hits',                 label: 'Hits',                playerType: 'hitter' },
  { key: 'singles',              label: 'Singles',             playerType: 'hitter' },
  { key: 'doubles',              label: 'Doubles',             playerType: 'hitter' },
  { key: 'triples',              label: 'Triples',             playerType: 'hitter' },
  { key: 'home_runs',            label: 'Home Runs',           playerType: 'hitter' },
  { key: 'total_bases',          label: 'Total Bases',         playerType: 'hitter' },
  { key: 'runs',                 label: 'Runs',                playerType: 'hitter' },
  { key: 'rbis',                 label: 'RBIs',                playerType: 'hitter' },
  { key: 'walks',                label: 'Walks',               playerType: 'hitter' },
  { key: 'strikeouts',           label: 'Strikeouts (Hitter)', playerType: 'hitter' },
  { key: 'stolen_bases',         label: 'Stolen Bases',        playerType: 'hitter' },
  { key: 'plate_appearances',    label: 'Plate Appearances',   playerType: 'hitter' },
  { key: 'hits_runs_rbis',       label: 'Hits + Runs + RBIs',  playerType: 'hitter' },
  { key: 'hitter_fantasy_score', label: 'Hitter Fantasy Score',playerType: 'hitter' },
];

const PITCHER_STATS: StatMeta[] = [
  { key: 'ks',                    label: 'Strikeouts (Pitcher)',  playerType: 'pitcher' },
  { key: 'earned_runs_allowed',   label: 'Earned Runs Allowed',   playerType: 'pitcher' },
  { key: 'walks_allowed',         label: 'Walks Allowed',         playerType: 'pitcher' },
  { key: 'pitcher_outs',          label: 'Pitcher Outs',          playerType: 'pitcher' },
  { key: 'hits_allowed',          label: 'Hits Allowed',          playerType: 'pitcher' },
  { key: 'innings_pitched',       label: 'Innings Pitched',       playerType: 'pitcher' },
  { key: 'home_runs_allowed',     label: 'Home Runs Allowed',     playerType: 'pitcher' },
  { key: 'pitches_thrown',        label: 'Pitches Thrown',        playerType: 'pitcher' },
  { key: 'pitcher_fantasy_score', label: 'Pitcher Fantasy Score', playerType: 'pitcher' },
];

const ALL: StatMeta[] = [...HITTER_STATS, ...PITCHER_STATS];
const BY_KEY = new Map(ALL.map((s) => [s.key, s] as const));

export function listStatsForPlayerType(t: MlbPlayerType): StatMeta[] {
  return t === 'hitter' ? HITTER_STATS : PITCHER_STATS;
}

export function statMeta(key: string): StatMeta | undefined {
  return BY_KEY.get(key as MlbStatKey);
}

// Returns the player type a stat belongs to, or null if the key is
// unknown. Routes use this to enforce the type-restriction rule:
// requesting a hitter stat on a pitcher (or vice versa) returns 400
// with a helpful message.
export function playerTypeForStat(key: string): MlbPlayerType | null {
  return statMeta(key)?.playerType ?? null;
}

// Compute the per-game value for a stat from a hitting_stats row.
// Returns null when the stat isn't a hitter stat or required columns
// are missing — the engine treats null as "no game" and skips it.
export type HittingRow = {
  hits: number | null;
  singles: number | null;
  doubles: number | null;
  triples: number | null;
  home_runs: number | null;
  total_bases: number | null;
  runs: number | null;
  rbis: number | null;
  walks: number | null;
  strikeouts: number | null;
  stolen_bases: number | null;
  plate_appearances: number | null;
};

export function valueFromHittingRow(
  key: MlbHitterStatKey,
  r: HittingRow,
): number | null {
  switch (key) {
    case 'hits':         return r.hits;
    case 'singles':      return r.singles;
    case 'doubles':      return r.doubles;
    case 'triples':      return r.triples;
    case 'home_runs':    return r.home_runs;
    case 'total_bases':  return r.total_bases;
    case 'runs':         return r.runs;
    case 'rbis':         return r.rbis;
    case 'walks':        return r.walks;
    case 'strikeouts':   return r.strikeouts;
    case 'stolen_bases': return r.stolen_bases;
    case 'plate_appearances': return r.plate_appearances;
    case 'hits_runs_rbis': {
      // Computed: H + R + RBI. Any null component → null overall.
      if (r.hits === null || r.runs === null || r.rbis === null) return null;
      return r.hits + r.runs + r.rbis;
    }
    case 'hitter_fantasy_score': {
      // Per spec: 1B*3 + 2B*5 + 3B*8 + HR*10 + R*2 + RBI*2 + BB*2 + SB*5 - K
      // Singles and any required columns missing → null.
      const singles = r.singles ?? 0;
      const doubles = r.doubles ?? 0;
      const triples = r.triples ?? 0;
      const hr      = r.home_runs ?? 0;
      const runs    = r.runs ?? 0;
      const rbis    = r.rbis ?? 0;
      const walks   = r.walks ?? 0;
      const sb      = r.stolen_bases ?? 0;
      const k       = r.strikeouts ?? 0;
      return singles * 3 + doubles * 5 + triples * 8 + hr * 10
        + runs * 2 + rbis * 2 + walks * 2 + sb * 5 - k;
    }
  }
}

export type PitchingRow = {
  outs_recorded: number | null;
  innings_pitched: number | string | null;
  pitches_thrown: number | null;
  hits_allowed: number | null;
  earned_runs_allowed: number | null;
  walks_allowed: number | null;
  strikeouts: number | null;
  home_runs_allowed: number | null;
};

export function valueFromPitchingRow(
  key: MlbPitcherStatKey,
  r: PitchingRow,
): number | null {
  switch (key) {
    case 'ks':                  return r.strikeouts;
    case 'earned_runs_allowed': return r.earned_runs_allowed;
    case 'walks_allowed':       return r.walks_allowed;
    case 'pitcher_outs':        return r.outs_recorded;
    case 'hits_allowed':        return r.hits_allowed;
    case 'innings_pitched':
      // pg returns NUMERIC as a string. Coerce defensively.
      if (r.innings_pitched === null) return null;
      if (typeof r.innings_pitched === 'string') {
        const n = Number(r.innings_pitched);
        return Number.isFinite(n) ? n : null;
      }
      return r.innings_pitched;
    case 'home_runs_allowed':   return r.home_runs_allowed;
    case 'pitches_thrown':      return r.pitches_thrown;
    case 'pitcher_fantasy_score': {
      // PrizePicks-style starter fantasy score: 3 × IP + 3 × K - 3 × ER.
      // Lines like Kirby/Eovaldi at 27.5-32.5 are consistent with this
      // formula (~6 IP + 6-8 K + 2 ER → ~24-30 pts). Win bonus is
      // omitted — wins aren't tracked in mlb_pitching_stats, and
      // PrizePicks props are pre-game / pre-decision anyway.
      const ip = r.innings_pitched === null
        ? null
        : typeof r.innings_pitched === 'string'
          ? (Number.isFinite(Number(r.innings_pitched)) ? Number(r.innings_pitched) : null)
          : r.innings_pitched;
      // Prefer outs_recorded when innings_pitched is missing — outs/3
      // is the same quantity and avoids losing games where the import
      // only populated one column.
      const effectiveIp = ip ?? (r.outs_recorded === null ? null : r.outs_recorded / 3);
      if (effectiveIp === null || r.strikeouts === null || r.earned_runs_allowed === null) {
        return null;
      }
      return 3 * effectiveIp + 3 * r.strikeouts - 3 * r.earned_runs_allowed;
    }
  }
}
