import type { PlayerGame } from '../nba/client.js';

export type StatKey = 'points' | 'rebounds' | 'assists' | 'minutes' | 'fgPct' | 'fg3Pct';

export type StatSummary = {
  avg: number;
  min: number;
  max: number;
  stdDev: number;
  consistency: number;       // 0–100, higher = more consistent
  trend: 'Trending Up' | 'Trending Down' | 'Stable';
};

export type PlayerVsTeamReport = {
  playerId: number;
  teamId: number;
  range: 'last5' | 'last10' | 'last20' | 'season';
  gamesAgainstTeam: PlayerGame[];
  seasonSampleSize: number;
  vsTeam: Record<StatKey, StatSummary>;
  seasonAverage: Record<StatKey, number>;
  delta: Record<StatKey, number>;     // vs-team avg minus season avg
};

const STAT_KEYS: StatKey[] = ['points', 'rebounds', 'assists', 'minutes', 'fgPct', 'fg3Pct'];

export function calculateConsistencyScore(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  if (avg <= 0) return 0;
  const sd = stdDev(values, avg);
  return clamp(100 - (sd / avg) * 100, 0, 100);
}

export function calculateTrendDirection(values: number[]): StatSummary['trend'] {
  // Compare first half vs second half. Spec says trending up/down/stable.
  // values[0] is most recent (NBA API returns newest first), so reverse for chronological.
  if (values.length < 4) return 'Stable';
  const chronological = [...values].reverse();
  const half = Math.floor(chronological.length / 2);
  const first = mean(chronological.slice(0, half));
  const second = mean(chronological.slice(half));
  if (first === 0) return 'Stable';
  const change = (second - first) / Math.abs(first);
  if (change > 0.1) return 'Trending Up';
  if (change < -0.1) return 'Trending Down';
  return 'Stable';
}

function summarize(values: number[]): StatSummary {
  if (values.length === 0) {
    return { avg: 0, min: 0, max: 0, stdDev: 0, consistency: 0, trend: 'Stable' };
  }
  const avg = mean(values);
  return {
    avg: round(avg, 2),
    min: round(Math.min(...values), 2),
    max: round(Math.max(...values), 2),
    stdDev: round(stdDev(values, avg), 2),
    consistency: round(calculateConsistencyScore(values), 1),
    trend: calculateTrendDirection(values),
  };
}

export function calculatePlayerVsTeam(
  seasonGames: PlayerGame[],
  opponentAbbr: string,
  opts: { range: PlayerVsTeamReport['range']; playerId: number; teamId: number },
): PlayerVsTeamReport {
  const vsAll = seasonGames.filter((g) => g.opponentAbbr === opponentAbbr);
  const limited =
    opts.range === 'season'
      ? vsAll
      : vsAll.slice(0, rangeToCount(opts.range));

  const vsTeam = {} as Record<StatKey, StatSummary>;
  const seasonAverage = {} as Record<StatKey, number>;
  const delta = {} as Record<StatKey, number>;

  for (const k of STAT_KEYS) {
    const vsValues = limited.map((g) => g[k] as number);
    const seasonValues = seasonGames.map((g) => g[k] as number);
    vsTeam[k] = summarize(vsValues);
    seasonAverage[k] = round(mean(seasonValues), 2);
    delta[k] = round(vsTeam[k].avg - seasonAverage[k], 2);
  }

  return {
    playerId: opts.playerId,
    teamId: opts.teamId,
    range: opts.range,
    gamesAgainstTeam: limited,
    seasonSampleSize: seasonGames.length,
    vsTeam,
    seasonAverage,
    delta,
  };
}

function rangeToCount(r: 'last5' | 'last10' | 'last20'): number {
  return r === 'last5' ? 5 : r === 'last10' ? 10 : 20;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: number[], avg: number): number {
  if (xs.length === 0) return 0;
  const v = xs.reduce((sum, x) => sum + (x - avg) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function round(x: number, places: number): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}
