import type { PlayerGame, TeamGame } from '../nba/client.js';

export type StatKey = 'points' | 'rebounds' | 'assists' | 'minutes' | 'fgPct' | 'fg3Pct';
export type TeamStatKey = 'points' | 'rebounds' | 'assists' | 'fgPct' | 'fg3Pct' | 'turnovers';

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

export type Side<TKey extends string> = {
  summaries: Record<TKey, StatSummary>;
  sampleSize: number;
};

export type PlayerVsPlayerReport = {
  range: 'last5' | 'last10' | 'last20' | 'season';
  a: Side<StatKey>;
  b: Side<StatKey>;
  delta: Record<StatKey, number>;     // a.avg - b.avg
};

export type TeamVsTeamReport = {
  range: 'last5' | 'last10' | 'last20' | 'season';
  a: Side<TeamStatKey>;
  b: Side<TeamStatKey>;
  delta: Record<TeamStatKey, number>;
};

function takeRange<T>(games: T[], range: 'last5' | 'last10' | 'last20' | 'season'): T[] {
  return range === 'season' ? games : games.slice(0, rangeToCount(range));
}

export function calculatePlayerVsPlayer(
  aGames: PlayerGame[],
  bGames: PlayerGame[],
  range: PlayerVsPlayerReport['range'],
): PlayerVsPlayerReport {
  const aSlice = takeRange(aGames, range);
  const bSlice = takeRange(bGames, range);
  const a: Side<StatKey> = { summaries: {} as Record<StatKey, StatSummary>, sampleSize: aSlice.length };
  const b: Side<StatKey> = { summaries: {} as Record<StatKey, StatSummary>, sampleSize: bSlice.length };
  const delta = {} as Record<StatKey, number>;
  for (const k of STAT_KEYS) {
    a.summaries[k] = summarize(aSlice.map((g) => g[k] as number));
    b.summaries[k] = summarize(bSlice.map((g) => g[k] as number));
    delta[k] = round(a.summaries[k].avg - b.summaries[k].avg, 2);
  }
  return { range, a, b, delta };
}

const TEAM_STAT_KEYS: TeamStatKey[] = ['points', 'rebounds', 'assists', 'fgPct', 'fg3Pct', 'turnovers'];

export function calculateTeamVsTeam(
  aGames: TeamGame[],
  bGames: TeamGame[],
  range: TeamVsTeamReport['range'],
): TeamVsTeamReport {
  const aSlice = takeRange(aGames, range);
  const bSlice = takeRange(bGames, range);
  const a: Side<TeamStatKey> = { summaries: {} as Record<TeamStatKey, StatSummary>, sampleSize: aSlice.length };
  const b: Side<TeamStatKey> = { summaries: {} as Record<TeamStatKey, StatSummary>, sampleSize: bSlice.length };
  const delta = {} as Record<TeamStatKey, number>;
  for (const k of TEAM_STAT_KEYS) {
    a.summaries[k] = summarize(aSlice.map((g) => g[k] as number));
    b.summaries[k] = summarize(bSlice.map((g) => g[k] as number));
    delta[k] = round(a.summaries[k].avg - b.summaries[k].avg, 2);
  }
  return { range, a, b, delta };
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
