// NBA Last-10 service. Defines the stat-id vocabulary the platform
// supports (Last10StatId), maps each stat to a PlayerGame field
// extractor (STAT_MAP), and provides Last-10 distribution helpers
// (avg / median / stdDev / hit-rate-vs-line). Powers the Last10View
// on /nba/compare and the projection engine's L1 baseline window.
//
// Sport scope: NBA only. MLB / WNBA / UFC have their own stat
// vocabularies in mlb/stats.ts, wnba/stats.ts, mma/stats.ts.

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

export const STAT_MAP: Record<Exclude<Last10StatId, 'double_double'>, (g: PlayerGame) => number> = {
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

export type SeasonVsL10 = {
  stat: 'pts' | 'reb' | 'ast' | 'stl' | 'blk' | 'min' | 'fgPct' | 'fg3Pct' | 'ftPct';
  label: string;
  seasonAvg: number;
  l10Avg: number;
  delta: number;       // l10 - season; positive = trending up
};

// Side-by-side season vs last-10 across the major box-score columns.
// Used by Last10View as a "is the player hot or cold across the
// board" overview at the top of the page. Uses the player's full
// cached game log for the season average and the last 10 for the
// recent average.
export function buildSeasonVsL10(games: PlayerGame[]): SeasonVsL10[] {
  if (games.length === 0) return [];
  const last10 = games.slice(0, Math.min(10, games.length));

  const avg = (xs: number[]): number => xs.length === 0
    ? 0
    : Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 10) / 10;
  const avgPct = (xs: number[]): number => xs.length === 0
    ? 0
    : Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 1000) / 1000;

  const stats: SeasonVsL10[] = [
    { stat: 'pts',    label: 'PTS',  seasonAvg: avg(games.map((g) => g.points)),    l10Avg: avg(last10.map((g) => g.points)),    delta: 0 },
    { stat: 'reb',    label: 'REB',  seasonAvg: avg(games.map((g) => g.rebounds)),  l10Avg: avg(last10.map((g) => g.rebounds)),  delta: 0 },
    { stat: 'ast',    label: 'AST',  seasonAvg: avg(games.map((g) => g.assists)),   l10Avg: avg(last10.map((g) => g.assists)),   delta: 0 },
    { stat: 'stl',    label: 'STL',  seasonAvg: avg(games.map((g) => g.steals)),    l10Avg: avg(last10.map((g) => g.steals)),    delta: 0 },
    { stat: 'blk',    label: 'BLK',  seasonAvg: avg(games.map((g) => g.blocks)),    l10Avg: avg(last10.map((g) => g.blocks)),    delta: 0 },
    { stat: 'min',    label: 'MIN',  seasonAvg: avg(games.map((g) => g.minutes)),   l10Avg: avg(last10.map((g) => g.minutes)),   delta: 0 },
    { stat: 'fgPct',  label: 'FG%',  seasonAvg: avgPct(games.map((g) => g.fgPct)),  l10Avg: avgPct(last10.map((g) => g.fgPct)),  delta: 0 },
    { stat: 'fg3Pct', label: '3P%',  seasonAvg: avgPct(games.map((g) => g.fg3Pct)), l10Avg: avgPct(last10.map((g) => g.fg3Pct)), delta: 0 },
    { stat: 'ftPct',  label: 'FT%',  seasonAvg: avgPct(games.map((g) => g.ftPct)),  l10Avg: avgPct(last10.map((g) => g.ftPct)),  delta: 0 },
  ];

  // Compute delta after construction so the rounded numbers above
  // match the values shown in the UI exactly.
  for (const s of stats) {
    s.delta = Math.round((s.l10Avg - s.seasonAvg) * 1000) / 1000;
  }
  return stats;
}

export type ByOpponentRow = {
  opponentAbbr: string;
  gamesPlayed: number;
  avg: number;          // for double_double, this is rate (0-1)
  high: number;
  low: number;
};

// Aggregates a player's season game log by opponent for the given stat.
// Used by Last10View to surface who they feast on / get held by.
// Sorted high-avg-first; opponents with 0 games are not included.
export function buildByOpponentBreakdown(
  games: PlayerGame[],
  selectedStat: Last10StatId,
): ByOpponentRow[] {
  if (games.length === 0) return [];

  const buckets = new Map<string, PlayerGame[]>();
  for (const g of games) {
    if (!g.opponentAbbr) continue;
    const arr = buckets.get(g.opponentAbbr) ?? [];
    arr.push(g);
    buckets.set(g.opponentAbbr, arr);
  }

  const isDD = selectedStat === 'double_double';
  const get = isDD ? null : STAT_MAP[selectedStat];

  const rows: ByOpponentRow[] = [];
  for (const [opponentAbbr, list] of buckets) {
    if (list.length === 0) continue;
    let values: number[];
    if (isDD) {
      values = list.map((g) => (isDoubleDoubleGame(g) ? 1 : 0));
    } else {
      values = list.map(get!);
    }
    const sum = values.reduce((a, b) => a + b, 0);
    rows.push({
      opponentAbbr,
      gamesPlayed: list.length,
      avg: round1(sum / list.length),
      high: Math.max(...values),
      low: Math.min(...values),
    });
  }

  rows.sort((a, b) => b.avg - a.avg || b.gamesPlayed - a.gamesPlayed);
  return rows;
}
