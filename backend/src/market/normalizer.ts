// Market Brain normalizer — Phase 103a.
//
// Per the Phase 103 spec: "Every provider returns different formats.
// Build market-normalizer.ts. Standardize player names, teams, prop
// types, directions, odds formats, timestamps, books. WITHOUT
// normalization: historical intelligence becomes corrupted."
//
// Sport-agnostic. Pure function. The normalizer is the contract that
// makes future provider integration thin — drop in a new MarketProvider,
// it spits raw stat labels, this module folds them into the canonical
// vocabulary.

// ---------- Stat type normalization ----------
//
// Different providers / books use different labels. Map each known
// variant into the canonical statKey vocabulary the rest of the
// platform uses. CANONICAL keys live in:
//   - NBA: backend/src/services/last10.ts Last10StatId
//   - MLB: backend/src/mlb/stats.ts MlbStatKey
//   - WNBA: backend/src/wnba/projection.ts STAT_PICKERS keys
//
// Add new aliases as we encounter them — every unrecognized label is
// logged so we can iterate. Lowercase + non-alphanumeric stripped on
// input so "Pts+Reb+Ast", "PRA", "Points Rebounds Assists", and
// "Pts/Reb/Ast" all land in the same bucket.

const STAT_ALIASES: Record<string, string> = {
  // ---- NBA / WNBA scoring ----
  'points':                          'points',
  'pts':                             'points',
  'rebounds':                        'rebounds',
  'reb':                             'rebounds',
  'assists':                         'assists',
  'ast':                             'assists',
  'steals':                          'steals',
  'stl':                             'steals',
  'blocks':                          'blocks',
  'blk':                             'blocks',
  'turnovers':                       'turnovers',
  'to':                              'turnovers',
  'tov':                             'turnovers',

  // 3PT
  'threeptmade':                     'three_pt_made',
  '3ptmade':                         'three_pt_made',
  '3pm':                             'three_pt_made',
  'threesmade':                      'three_pt_made',
  'three3pmade':                     'three_pt_made',
  'three3pmade1':                    'three_pt_made',

  // FG / FT
  'fgmade':                          'fg_made',
  'fgm':                             'fg_made',
  'fieldgoalsmade':                  'fg_made',
  'fgattempted':                     'fg_attempted',
  'fga':                             'fg_attempted',
  'ftmade':                          'ft_made',
  'ftm':                             'ft_made',
  'freethrowsmade':                  'ft_made',
  'ftattempted':                     'ft_attempted',
  'fta':                             'ft_attempted',

  'personalfouls':                   'personal_fouls',
  'pf':                              'personal_fouls',
  'fouls':                           'personal_fouls',
  'offensiverebounds':               'offensive_rebounds',
  'oreb':                            'offensive_rebounds',
  'defensiverebounds':               'defensive_rebounds',
  'dreb':                            'defensive_rebounds',

  // Combo stats
  'pra':                             'pra',
  'pointsreboundsassists':           'pra',
  'ptsrebast':                       'pra',
  'pr':                              'pr',
  'pointsrebounds':                  'pr',
  'ptsreb':                          'pr',
  'pa':                              'pa',
  'pointsassists':                   'pa',
  'ptsast':                          'pa',
  'ra':                              'ra',
  'reboundsassists':                 'ra',
  'rebast':                          'ra',
  'stocks':                          'stocks',
  'stealsblocks':                    'stocks',
  'stlblk':                          'stocks',
  'doubledouble':                    'double_double',
  'dd':                              'double_double',

  // ---- MLB hitter ----
  'hits':                            'hits',
  'h':                               'hits',
  'totalbases':                      'total_bases',
  'tb':                              'total_bases',
  'runs':                            'runs',
  'r':                               'runs',
  'rbis':                            'rbis',
  'rbi':                             'rbis',
  'walks':                           'walks',
  'bb':                              'walks',
  'strikeouts':                      'strikeouts',          // hitter K
  'strikeoutshitter':                'strikeouts',
  'sohitter':                        'strikeouts',
  'kshitter':                        'strikeouts',
  'homeruns':                        'home_runs',
  'hr':                              'home_runs',
  'doubles':                         'doubles',
  'triples':                         'triples',
  'stolenbases':                     'stolen_bases',
  'sb':                              'stolen_bases',
  'hitsrunsrbis':                    'hits_runs_rbis',
  'hrrbi':                           'hits_runs_rbis',

  // ---- MLB pitcher ----
  'pitcherstrikeouts':               'pitcher_strikeouts',
  'sopitcher':                       'pitcher_strikeouts',
  'kspitcher':                       'pitcher_strikeouts',
  'strikeoutspitcher':               'pitcher_strikeouts',
  'hitsallowed':                     'hits_allowed',
  'earnedrunsallowed':               'earned_runs_allowed',
  'er':                              'earned_runs_allowed',
  'walksallowed':                    'walks_allowed',
  'outsrecorded':                    'outs_recorded',
  'outs':                            'outs_recorded',
  'homerunsallowed':                 'home_runs_allowed',
};

// Strip → lowercase + remove non-alphanumeric. Lets "PTS+REB+AST"
// and "Pts Reb Ast" both fold to "ptsrebast" before lookup.
function fold(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function normalizeStatKey(raw: string): string {
  const folded = fold(raw);
  return STAT_ALIASES[folded] ?? folded;
}

// True if we recognized the stat. Lets ingestion log unknowns for
// follow-up alias-table maintenance.
export function isKnownStat(raw: string): boolean {
  return fold(raw) in STAT_ALIASES;
}

// ---------- Direction normalization ----------

export function normalizeDirection(raw: string): 'OVER' | 'UNDER' | 'BOTH' {
  const f = raw.toLowerCase().trim();
  if (f === 'over' || f === 'o' || f === '+') return 'OVER';
  if (f === 'under' || f === 'u' || f === '-') return 'UNDER';
  if (f === 'both' || f === 'b' || f === '') return 'BOTH';
  return 'BOTH';
}

// ---------- Odds normalization ----------
//
// All three formats (American / Decimal / Implied%) are derivable from
// any one. We accept whatever the provider gives and fill the rest.

export function americanFromDecimal(d: number): number {
  if (d <= 1) return 0;
  if (d >= 2) return Math.round((d - 1) * 100);
  return Math.round(-100 / (d - 1));
}

export function decimalFromAmerican(am: number): number {
  if (am === 0) return 1;
  if (am > 0) return Math.round((am / 100 + 1) * 1000) / 1000;
  return Math.round((100 / Math.abs(am) + 1) * 1000) / 1000;
}

export function impliedFromAmerican(am: number): number {
  if (am === 0) return 50;
  if (am > 0) return Math.round((100 / (am + 100)) * 1000) / 10;
  return Math.round((Math.abs(am) / (Math.abs(am) + 100)) * 1000) / 10;
}

export function impliedFromDecimal(d: number): number {
  if (d <= 1) return 100;
  return Math.round((100 / d) * 10) / 10;
}

// ---------- Team abbreviation normalization ----------
//
// Sportsbooks vary on a few historical edge cases (Athletics: ATH vs
// OAK; White Sox: CWS vs CHW; Diamondbacks: ARI vs AZ; Nationals:
// WSH vs WAS). We canonicalize to the dominant league source —
// statsapi.mlb.com for MLB; ESPN for NBA + WNBA.

const TEAM_ALIASES: Record<string, string> = {
  // MLB
  'OAK': 'ATH',          // Athletics — statsapi ATH
  'CHW': 'CWS',          // White Sox — statsapi CWS
  'AZ':  'ARI',          // Diamondbacks — statsapi ARI
  'WAS': 'WSH',          // Nationals — statsapi WSH
};

export function normalizeTeamAbbr(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const upper = raw.toUpperCase().trim();
  return TEAM_ALIASES[upper] ?? upper;
}
