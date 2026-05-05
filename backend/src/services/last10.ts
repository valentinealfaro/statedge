import type { PlayerGame } from '../nba/client.js';

// Stat ids exposed by the Last 10 menu. We deliberately exclude:
//  - dunks (not in stats.nba.com playergamelog)
//  - 1st-3-min / quarter-prop variants (out of scope)
//  - "popular" / fantasy / two-pointer-only stats (out of scope)
export type Last10StatId =
  | 'points'
  | 'rebounds'
  | 'assists'
  | 'three_pt_made'
  | 'fg_made'
  | 'fg_attempted'
  | 'ft_made'
  | 'ft_attempted'
  | 'personal_fouls'
  | 'steals'
  | 'blocks'
  | 'turnovers'
  | 'offensive_rebounds'
  | 'defensive_rebounds'
  | 'pra'
  | 'pr'
  | 'pa'
  | 'ra'
  | 'stocks'
  | 'double_double';

export const LAST10_STATS: Last10StatId[] = [
  'points',
  'rebounds',
  'assists',
  'three_pt_made',
  'fg_made',
  'fg_attempted',
  'ft_made',
  'ft_attempted',
  'personal_fouls',
  'steals',
  'blocks',
  'turnovers',
  'offensive_rebounds',
  'defensive_rebounds',
  'pra',
  'pr',
  'pa',
  'ra',
  'stocks',
  'double_double',
];

export const LAST10_LABELS: Record<Last10StatId, string> = {
  points: 'Points',
  rebounds: 'Rebounds',
  assists: 'Assists',
  three_pt_made: '3-PT Made',
  fg_made: 'FG Made',
  fg_attempted: 'FG Attempted',
  ft_made: 'Free Throws Made',
  ft_attempted: 'Free Throws Attempted',
  personal_fouls: 'Personal Fouls',
  steals: 'Steals',
  blocks: 'Blocked Shots',
  turnovers: 'Turnovers',
  offensive_rebounds: 'Offensive Rebounds',
  defensive_rebounds: 'Defensive Rebounds',
  pra: 'Pts + Rebs + Asts',
  pr: 'Pts + Rebs',
  pa: 'Pts + Asts',
  ra: 'Rebs + Asts',
  stocks: 'Blks + Stls',
  double_double: 'Double-Double',
};

// Some fields (oreb, dreb, fgm, etc.) were added to PlayerGame after some
// seasons were already cached, so they may be undefined for older rows.
// `n` coerces undefined → 0 so we never emit null/NaN to the client.
const n = (v: number | undefined | null): number => (typeof v === 'number' ? v : 0);

const STAT_MAP: Record<Exclude<Last10StatId, 'double_double'>, (g: PlayerGame) => number> = {
  points: (g) => g.points,
  rebounds: (g) => g.rebounds,
  assists: (g) => g.assists,
  three_pt_made: (g) => n(g.fg3m),
  fg_made: (g) => n(g.fgm),
  fg_attempted: (g) => n(g.fga),
  ft_made: (g) => n(g.ftm),
  ft_attempted: (g) => n(g.fta),
  personal_fouls: (g) => n(g.pf),
  steals: (g) => g.steals,
  blocks: (g) => g.blocks,
  turnovers: (g) => g.turnovers,
  offensive_rebounds: (g) => n(g.oreb),
  defensive_rebounds: (g) => n(g.dreb),
  pra: (g) => g.points + g.rebounds + g.assists,
  pr: (g) => g.points + g.rebounds,
  pa: (g) => g.points + g.assists,
  ra: (g) => g.rebounds + g.assists,
  stocks: (g) => g.blocks + g.steals,
};

export function isDoubleDoubleGame(g: PlayerGame): boolean {
  return [g.points, g.rebounds, g.assists, g.steals, g.blocks].filter((v) => v >= 10).length >= 2;
}

export type NumericLast10Report = {
  selectedStat: Exclude<Last10StatId, 'double_double'>;
  label: string;
  gamesAnalyzed: number;
  average: number;
  high: number;
  low: number;
  values: number[];
  hitCountAboveAverage: number;
  gameLog: PlayerGame[];
};

export type DoubleDoubleLast10Report = {
  selectedStat: 'double_double';
  label: string;
  gamesAnalyzed: number;
  doubleDouble: { count: number; rate: number; values: boolean[] };
  gameLog: PlayerGame[];
};

export type Last10Report = NumericLast10Report | DoubleDoubleLast10Report;

// Caller is responsible for passing the player's recent games sorted newest-first
// (which is how stats.nba.com playergamelog returns them and how we cache them).
export function buildLast10Report(
  games: PlayerGame[],
  selectedStat: Last10StatId,
): Last10Report {
  const last10 = games.slice(0, 10);

  if (selectedStat === 'double_double') {
    const values = last10.map(isDoubleDoubleGame);
    const count = values.filter(Boolean).length;
    return {
      selectedStat,
      label: LAST10_LABELS.double_double,
      gamesAnalyzed: last10.length,
      doubleDouble: {
        count,
        rate: last10.length === 0 ? 0 : Math.round((count / last10.length) * 100),
        values,
      },
      gameLog: last10,
    };
  }

  const get = STAT_MAP[selectedStat];
  const values = last10.map(get);
  const total = values.reduce((a, b) => a + b, 0);
  const average = values.length === 0 ? 0 : round1(total / values.length);
  const high = values.length === 0 ? 0 : Math.max(...values);
  const low = values.length === 0 ? 0 : Math.min(...values);
  const hitCountAboveAverage = values.filter((v) => v > average).length;

  return {
    selectedStat,
    label: LAST10_LABELS[selectedStat],
    gamesAnalyzed: last10.length,
    average,
    high,
    low,
    values,
    hitCountAboveAverage,
    gameLog: last10,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
