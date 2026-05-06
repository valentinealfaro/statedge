import type { Last10StatId } from './last10.js';

// Maps free-text stat labels (from PrizePicks API or OCR'd screenshots)
// to our canonical Last10StatId. Keys here are *normalized* — lowercase,
// no spaces, no punctuation — so we match permissively.
//
// Anything not in this table returns null and the caller drops the line
// (props like "Fantasy Score", "1st 3 Minutes", etc. don't have a clean
// last-10 equivalent in our cache).
const STAT_LABEL_MAP: Record<string, Last10StatId> = {
  // Singles
  points: 'points',
  pts: 'points',
  rebounds: 'rebounds',
  rebs: 'rebounds',
  reb: 'rebounds',
  assists: 'assists',
  asts: 'assists',
  ast: 'assists',
  steals: 'steals',
  stl: 'steals',
  blockedshots: 'blocks',
  blocks: 'blocks',
  blk: 'blocks',
  turnovers: 'turnovers',
  to: 'turnovers',
  personalfouls: 'personal_fouls',
  pf: 'personal_fouls',

  // Shooting
  threeptmade: 'three_pt_made',
  threesmade: 'three_pt_made',
  threes: 'three_pt_made',
  '3ptmade': 'three_pt_made',
  '3pm': 'three_pt_made',
  fgmade: 'fg_made',
  fgm: 'fg_made',
  fgattempted: 'fg_attempted',
  fga: 'fg_attempted',
  freethrowsmade: 'ft_made',
  ftmade: 'ft_made',
  ftm: 'ft_made',
  freethrowsattempted: 'ft_attempted',
  ftattempted: 'ft_attempted',
  fta: 'ft_attempted',

  // Boards (prop boards rarely show these but we have the data)
  offensiverebounds: 'offensive_rebounds',
  oreb: 'offensive_rebounds',
  defensiverebounds: 'defensive_rebounds',
  dreb: 'defensive_rebounds',

  // Combos
  ptsrebsasts: 'pra',
  pra: 'pra',
  ptsrebs: 'pr',
  pr: 'pr',
  ptsasts: 'pa',
  pa: 'pa',
  rebsasts: 'ra',
  ra: 'ra',
  blksstls: 'stocks',
  stlsblks: 'stocks',
  stocks: 'stocks',

  // Special
  doubledouble: 'double_double',
  dd: 'double_double',
};

// Strip everything that isn't a-z 0-9 so "3-PT Made", "3PT Made",
// "3-pt made", "ThreesMade" all collapse to the same key.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function normalizeStatLabel(raw: string): Last10StatId | null {
  const k = normalize(raw);
  return STAT_LABEL_MAP[k] ?? null;
}

// Display labels for the UI when we don't have one from the source.
const DISPLAY: Record<Last10StatId, string> = {
  points: 'Points',
  rebounds: 'Rebounds',
  assists: 'Assists',
  steals: 'Steals',
  blocks: 'Blocked Shots',
  turnovers: 'Turnovers',
  personal_fouls: 'Personal Fouls',
  three_pt_made: '3-PT Made',
  fg_made: 'FG Made',
  fg_attempted: 'FG Attempted',
  ft_made: 'Free Throws Made',
  ft_attempted: 'Free Throws Attempted',
  offensive_rebounds: 'Offensive Rebounds',
  defensive_rebounds: 'Defensive Rebounds',
  pra: 'Pts+Rebs+Asts',
  pr: 'Pts+Rebs',
  pa: 'Pts+Asts',
  ra: 'Rebs+Asts',
  stocks: 'Blks+Stls',
  double_double: 'Double-Double',
};

export function statLabelFor(id: Last10StatId): string {
  return DISPLAY[id];
}
