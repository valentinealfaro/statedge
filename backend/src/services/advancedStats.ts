// NBA advanced stats — derived metrics computed from PlayerGame[]
// arrays. Powers the AdvancedCards component on /nba/compare:
// double/triple-double rates, PRA / PR / PA / RA combos, STOCKS
// (steals + blocks), trend lines, performance-vs-team splits,
// home/away splits.
//
// Pure functions — no DB / no network. Inputs come from
// player_game_logs at the route layer; this file runs the math.
// NBA-specific stat keys (PRA / STOCKS aren't MLB / WNBA / UFC
// concepts). MLB has its own derived-stat helpers in mlbBaselineEngine.

import type { PlayerGame } from '../nba/client.js';

export type SelectedStat =
  | 'points' | 'rebounds' | 'assists'
  | 'PRA' | 'PR' | 'PA' | 'RA' | 'STOCKS';

export const SELECTED_STATS: SelectedStat[] = [
  'points', 'rebounds', 'assists', 'PRA', 'PR', 'PA', 'RA', 'STOCKS',
];

// --- 1. Double / Triple double (game-level) ---

const DOUBLE_CATEGORIES = (g: PlayerGame): number[] => [
  g.points, g.rebounds, g.assists, g.steals, g.blocks,
];

export function isDoubleDouble(g: PlayerGame): boolean {
  return DOUBLE_CATEGORIES(g).filter((v) => v >= 10).length >= 2;
}

export function isTripleDouble(g: PlayerGame): boolean {
  return DOUBLE_CATEGORIES(g).filter((v) => v >= 10).length >= 3;
}

// --- 2. Consistency score ---

export function consistencyScore(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  if (avg === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const raw = 100 - (stdDev / avg) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function consistencyLabel(score: number): 'Volatile' | 'Moderate' | 'Consistent' | 'Very Consistent' {
  if (score >= 85) return 'Very Consistent';
  if (score >= 70) return 'Consistent';
  if (score >= 40) return 'Moderate';
  return 'Volatile';
}

// --- 3. Trend: Last 5 vs Last 10 ---

export type TrendLabel = 'Trending Up' | 'Trending Down' | 'Stable' | 'Not Enough Data';
export type TrendReport = {
  last5Avg: number;
  last10Avg: number;
  percentChange: number;
  label: TrendLabel;
};

export function calcTrendL5L10(values: number[]): TrendReport {
  if (values.length < 5) {
    return { last5Avg: 0, last10Avg: 0, percentChange: 0, label: 'Not Enough Data' };
  }
  const last5 = values.slice(0, 5);
  const last10 = values.slice(0, Math.min(10, values.length));
  const last5Avg = avg(last5);
  const last10Avg = avg(last10);
  if (last10Avg === 0) {
    return { last5Avg, last10Avg, percentChange: 0, label: 'Not Enough Data' };
  }
  const pct = ((last5Avg - last10Avg) / last10Avg) * 100;
  let label: TrendLabel = 'Stable';
  if (pct >= 10) label = 'Trending Up';
  else if (pct <= -10) label = 'Trending Down';
  return {
    last5Avg: round1(last5Avg),
    last10Avg: round1(last10Avg),
    percentChange: round1(pct),
    label,
  };
}

// --- 4. Performance vs Team ---

export type PerformanceLabel = 'Better vs Team' | 'About Average' | 'Worse vs Team' | 'Not Enough Data';
export type PerformanceReport = {
  vsTeamAvg: number;
  seasonAvg: number;
  difference: number;
  percentChange: number;
  label: PerformanceLabel;
};

export function performanceVsTeam(vsTeamAvg: number, seasonAvg: number): PerformanceReport {
  if (seasonAvg === 0) {
    return {
      vsTeamAvg: round1(vsTeamAvg),
      seasonAvg: 0,
      difference: 0,
      percentChange: 0,
      label: 'Not Enough Data',
    };
  }
  const difference = vsTeamAvg - seasonAvg;
  const percentChange = (difference / seasonAvg) * 100;
  let label: PerformanceLabel = 'About Average';
  if (percentChange >= 10) label = 'Better vs Team';
  else if (percentChange <= -10) label = 'Worse vs Team';
  return {
    vsTeamAvg: round1(vsTeamAvg),
    seasonAvg: round1(seasonAvg),
    difference: round1(difference),
    percentChange: round1(percentChange),
    label,
  };
}

// --- 5. Home vs Away splits ---

export type HomeAwayReport = {
  homeAvg: number;
  awayAvg: number;
  difference: number;
  betterLocation: 'Home' | 'Away' | 'Even';
  homeGames: number;
  awayGames: number;
};

export function homeAwaySplits(
  games: PlayerGame[],
  getValue: (g: PlayerGame) => number,
): HomeAwayReport {
  const home = games.filter((g) => g.isHome).map(getValue);
  const away = games.filter((g) => !g.isHome).map(getValue);
  const homeAvg = avg(home);
  const awayAvg = avg(away);
  return {
    homeAvg: round1(homeAvg),
    awayAvg: round1(awayAvg),
    difference: round1(homeAvg - awayAvg),
    betterLocation:
      homeAvg > awayAvg ? 'Home' : awayAvg > homeAvg ? 'Away' : 'Even',
    homeGames: home.length,
    awayGames: away.length,
  };
}

// --- 6. Composer ---

export type AdvancedStatsReport = {
  selectedStat: SelectedStat;
  gamesAnalyzed: number;
  doubleDouble: { count: number; rate: number };
  tripleDouble: { count: number; rate: number };
  consistency: { score: number; label: ReturnType<typeof consistencyLabel> };
  trend: TrendReport;
  performanceVsTeam: PerformanceReport;
  homeAway: HomeAwayReport;
};

export function getStatValue(stat: SelectedStat): (g: PlayerGame) => number {
  switch (stat) {
    case 'points':   return (g) => g.points;
    case 'rebounds': return (g) => g.rebounds;
    case 'assists':  return (g) => g.assists;
    case 'PRA':      return (g) => g.points + g.rebounds + g.assists;
    case 'PR':       return (g) => g.points + g.rebounds;
    case 'PA':       return (g) => g.points + g.assists;
    case 'RA':       return (g) => g.rebounds + g.assists;
    case 'STOCKS':   return (g) => g.blocks + g.steals;
  }
}

export function calculateAdvancedStats(
  vsTeamGames: PlayerGame[],
  seasonGames: PlayerGame[],
  selectedStat: SelectedStat,
): AdvancedStatsReport {
  const getValue = getStatValue(selectedStat);
  const vsTeamValues = vsTeamGames.map(getValue);
  const seasonValues = seasonGames.map(getValue);

  const total = vsTeamGames.length;
  const ddCount = vsTeamGames.filter(isDoubleDouble).length;
  const tdCount = vsTeamGames.filter(isTripleDouble).length;

  const cScore = consistencyScore(vsTeamValues);

  return {
    selectedStat,
    gamesAnalyzed: total,
    doubleDouble: {
      count: ddCount,
      rate: total === 0 ? 0 : Math.round((ddCount / total) * 100),
    },
    tripleDouble: {
      count: tdCount,
      rate: total === 0 ? 0 : Math.round((tdCount / total) * 100),
    },
    consistency: { score: cScore, label: consistencyLabel(cScore) },
    trend: calcTrendL5L10(vsTeamValues),
    performanceVsTeam: performanceVsTeam(avg(vsTeamValues), avg(seasonValues)),
    homeAway: homeAwaySplits(vsTeamGames, getValue),
  };
}

// --- helpers ---

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
