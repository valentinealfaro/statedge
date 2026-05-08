// MLB Last-10 engine. Reads game logs from mlb_hitting_stats /
// mlb_pitching_stats and computes the same distribution shape the
// projection engine and frontend will rely on:
//
//   values, average, median, high, low, hitRate (against a line),
//   last5Avg, last10Avg, trend (last5 - last10), consistencyScore (1
//   - normalized stddev), riskScore (volatility-driven).
//
// Per the StatEdge MLB spec — this is the foundation the projection /
// risk / trap / EV engines layer on top of in later phases. Keeping
// the engine pure (returns a plain object) so the projection layer
// can call it without round-tripping through HTTP.

import { getPool } from '../db.js';
import { ensureMlbTables } from '../mlb/db.js';
import {
  type HittingRow,
  type MlbHitterStatKey,
  type MlbPitcherStatKey,
  type MlbStatKey,
  type PitchingRow,
  playerTypeForStat,
  valueFromHittingRow,
  valueFromPitchingRow,
} from '../mlb/stats.js';

export type MlbLast10GameEntry = {
  gameId: number;
  gameDate: string;       // YYYY-MM-DD
  opponentTeamId: number | null;
  isHome: boolean | null;
  value: number;
};

export type MlbLast10Result = {
  playerId: number;
  statKey: MlbStatKey;
  // Whether the player is a pitcher or hitter (drives which table we
  // read from). Echoed so clients don't need to look it up separately.
  playerType: 'hitter' | 'pitcher';

  // Per-game values, oldest → newest.
  values: number[];
  // Game-by-game detail for UI rendering (date, opponent, etc).
  games: MlbLast10GameEntry[];

  // Distribution
  sampleSize: number;          // number of games actually analyzed
  average: number;
  median: number;
  high: number;
  low: number;
  stddev: number;

  // Trend signals
  last5Average: number | null; // null if <5 games available
  last10Average: number;       // average of all values (≤10)
  trend: number | null;        // last5 - last10 (null if last5 unavailable)

  // Stability / risk
  // consistencyScore: 0-100. 100 = perfectly stable (zero variance).
  // 0 = wildly volatile relative to the mean.
  consistencyScore: number;
  // riskScore: 0-100. Inverse of consistency, but capped to soften
  // the high end so a flat .000 player doesn't show "max risk."
  riskScore: number;

  // Hit rate at the queried line + direction (only set when caller
  // provides a line).
  hitRate?: {
    line: number;
    direction: 'OVER' | 'UNDER';
    hits: number;
    games: number;
    rate: number;            // 0-100
  };
};

export type MlbLast10Options = {
  playerId: number;
  statKey: MlbStatKey;
  // Window cap — defaults to 10. Engine pulls the most recent N games
  // from the appropriate table. We pull 10 by default to match the
  // "last 10" framing but the caller can ask for more (used by the
  // projection engine when it needs richer history).
  limit?: number;
  // Optional line + direction for hit-rate computation.
  line?: number;
  direction?: 'OVER' | 'UNDER';
};

// Resolve player type from mlb_players. Returns null if the player
// doesn't exist — caller should surface a 404.
async function resolvePlayerType(
  playerId: number,
): Promise<'hitter' | 'pitcher' | null> {
  const { rows } = await getPool().query<{ is_pitcher: boolean }>(
    `SELECT is_pitcher FROM mlb_players WHERE id = $1`,
    [playerId],
  );
  if (rows.length === 0) return null;
  return rows[0]!.is_pitcher ? 'pitcher' : 'hitter';
}

export class MlbStatTypeMismatchError extends Error {
  constructor(
    readonly playerType: 'hitter' | 'pitcher',
    readonly statKey: string,
  ) {
    super(
      `Selected stat "${statKey}" is not available for ${playerType}s. ` +
      `Choose a ${playerType === 'hitter' ? 'hitter' : 'pitcher'} stat.`,
    );
    this.name = 'MlbStatTypeMismatchError';
  }
}

export class MlbPlayerNotFoundError extends Error {
  constructor(playerId: number) {
    super(`MLB player ${playerId} not found.`);
    this.name = 'MlbPlayerNotFoundError';
  }
}

// Build the result. Keeps math centralized so frontend never repeats
// it (frontend should display these numbers, not re-derive).
export async function computeMlbLast10(
  opts: MlbLast10Options,
): Promise<MlbLast10Result> {
  await ensureMlbTables();
  const playerType = await resolvePlayerType(opts.playerId);
  if (!playerType) throw new MlbPlayerNotFoundError(opts.playerId);

  const requiredType = playerTypeForStat(opts.statKey);
  if (requiredType === null) {
    throw new Error(`Unknown stat key: ${opts.statKey}`);
  }
  if (requiredType !== playerType) {
    throw new MlbStatTypeMismatchError(playerType, opts.statKey);
  }

  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const games =
    playerType === 'hitter'
      ? await readHittingGames(opts.playerId, opts.statKey as MlbHitterStatKey, limit)
      : await readPitchingGames(opts.playerId, opts.statKey as MlbPitcherStatKey, limit);

  const values = games.map((g) => g.value);
  const sampleSize = values.length;

  const average = sampleSize === 0 ? 0 : sum(values) / sampleSize;
  const median = sampleSize === 0 ? 0 : computeMedian(values);
  const high = sampleSize === 0 ? 0 : Math.max(...values);
  const low = sampleSize === 0 ? 0 : Math.min(...values);
  const stddev = computeStddev(values, average);

  // last5 vs last10 trend. games are oldest→newest, so the last 5
  // values of the array are the most recent 5.
  const last5Slice = values.slice(-5);
  const last5Average =
    last5Slice.length === 5 ? sum(last5Slice) / 5 : null;
  const last10Average = average;
  const trend = last5Average === null ? null : last5Average - last10Average;

  // Consistency: 100 - normalized stddev clamped to [0,100]. Use mean
  // (or 1 if mean is zero) as the normalization base — coefficient of
  // variation × 100 inverted. Risk = 100 - consistency.
  const meanForCv = Math.max(Math.abs(average), 1);
  const cv = stddev / meanForCv;
  const consistencyScore = clamp01to100(100 - cv * 50);
  const riskScore = clamp01to100(cv * 50);

  const result: MlbLast10Result = {
    playerId: opts.playerId,
    statKey: opts.statKey,
    playerType,
    values,
    games,
    sampleSize,
    average: round2(average),
    median: round2(median),
    high,
    low,
    stddev: round2(stddev),
    last5Average: last5Average === null ? null : round2(last5Average),
    last10Average: round2(last10Average),
    trend: trend === null ? null : round2(trend),
    consistencyScore: Math.round(consistencyScore),
    riskScore: Math.round(riskScore),
  };

  if (opts.line !== undefined && opts.direction) {
    let hits = 0;
    for (const v of values) {
      if (opts.direction === 'OVER' && v > opts.line) hits += 1;
      else if (opts.direction === 'UNDER' && v < opts.line) hits += 1;
    }
    result.hitRate = {
      line: opts.line,
      direction: opts.direction,
      hits,
      games: sampleSize,
      rate: sampleSize === 0 ? 0 : Math.round((hits / sampleSize) * 100),
    };
  }

  return result;
}

// ---------- Internal helpers ----------

async function readHittingGames(
  playerId: number,
  statKey: MlbHitterStatKey,
  limit: number,
): Promise<MlbLast10GameEntry[]> {
  const { rows } = await getPool().query<{
    game_id: number;
    game_date: Date;
    opponent_team_id: number | null;
    is_home: boolean | null;
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
  }>(
    `SELECT
       hs.game_id, g.game_date, hs.opponent_team_id, hs.is_home,
       hs.hits, hs.singles, hs.doubles, hs.triples, hs.home_runs,
       hs.total_bases, hs.runs, hs.rbis, hs.walks, hs.strikeouts,
       hs.stolen_bases
     FROM mlb_hitting_stats hs
     JOIN mlb_games g ON g.id = hs.game_id
     WHERE hs.player_id = $1
     ORDER BY g.game_date DESC
     LIMIT $2`,
    [playerId, limit],
  );
  // Reverse so oldest → newest, matching engine's last-N convention.
  const ordered = [...rows].reverse();
  const entries: MlbLast10GameEntry[] = [];
  for (const r of ordered) {
    const value = valueFromHittingRow(statKey, r as HittingRow);
    if (value === null) continue;     // skip games where stat is unknown
    entries.push({
      gameId: r.game_id,
      gameDate: toIsoDate(r.game_date),
      opponentTeamId: r.opponent_team_id,
      isHome: r.is_home,
      value,
    });
  }
  return entries;
}

async function readPitchingGames(
  playerId: number,
  statKey: MlbPitcherStatKey,
  limit: number,
): Promise<MlbLast10GameEntry[]> {
  const { rows } = await getPool().query<{
    game_id: number;
    game_date: Date;
    opponent_team_id: number | null;
    is_home: boolean | null;
    outs_recorded: number | null;
    innings_pitched: string | null;
    pitches_thrown: number | null;
    hits_allowed: number | null;
    earned_runs_allowed: number | null;
    walks_allowed: number | null;
    strikeouts: number | null;
    home_runs_allowed: number | null;
  }>(
    `SELECT
       ps.game_id, g.game_date, ps.opponent_team_id, ps.is_home,
       ps.outs_recorded, ps.innings_pitched, ps.pitches_thrown,
       ps.hits_allowed, ps.earned_runs_allowed, ps.walks_allowed,
       ps.strikeouts, ps.home_runs_allowed
     FROM mlb_pitching_stats ps
     JOIN mlb_games g ON g.id = ps.game_id
     WHERE ps.player_id = $1
     ORDER BY g.game_date DESC
     LIMIT $2`,
    [playerId, limit],
  );
  const ordered = [...rows].reverse();
  const entries: MlbLast10GameEntry[] = [];
  for (const r of ordered) {
    const value = valueFromPitchingRow(statKey, r as PitchingRow);
    if (value === null) continue;
    entries.push({
      gameId: r.game_id,
      gameDate: toIsoDate(r.game_date),
      opponentTeamId: r.opponent_team_id,
      isHome: r.is_home,
      value,
    });
  }
  return entries;
}

function sum(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function computeStddev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  let acc = 0;
  for (const v of values) acc += (v - mean) ** 2;
  return Math.sqrt(acc / values.length);
}

function clamp01to100(n: number): number {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toIsoDate(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  // Use UTC to avoid timezone drift on the date portion.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
