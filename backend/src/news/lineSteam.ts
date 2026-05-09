// Line-steam detection — Phase 109c.
//
// For each (sport, player, statKey, direction) pair seen in the last
// N hours of market_snapshots, compute first-seen vs latest-seen line
// + implied-probability deltas. Significant movement = the market
// reacting to information (injury news, lineup change, weather,
// late sharp action). One bundle article per sport per day surfaces
// the biggest movers — institutional-grade signal worth writing about.
//
// Pure data layer. The template + generator decide how to present.

import { getPool, isDbConfigured } from '../db.js';

export type LineMover = {
  sport: string;
  playerId: string | null;
  playerName: string;
  team: string | null;
  statKey: string;
  direction: string;        // 'over' | 'under' | 'both'
  firstLine: number;
  latestLine: number;
  lineDelta: number;        // signed: latest - first
  firstImplied: number | null;
  latestImplied: number | null;
  impliedDelta: number | null;
  firstSeenAt: string;
  latestSeenAt: string;
  snapshotCount: number;
};

export async function findLineSteam(opts: {
  sport?: 'mlb' | 'nba' | 'wnba';
  hours?: number;
  minLineDelta?: number;        // absolute, in stat units (default 0.5)
  minImpliedDelta?: number;     // absolute, in implied probability (default 0.05 = 5pp)
  limit?: number;
}): Promise<LineMover[]> {
  if (!isDbConfigured()) return [];
  const hours = opts.hours ?? 24;
  const minLine = opts.minLineDelta ?? 0.5;
  const minImpl = opts.minImpliedDelta ?? 0.05;
  const limit = Math.min(50, Math.max(1, opts.limit ?? 8));

  // Group rows by (sport, player, statKey, direction). DISTINCT ON
  // tricks let Postgres pick the first / last row per group cheaply.
  // We compute first + last in a single CTE then JOIN them back.
  const args: Array<string | number> = [hours];
  let sportFilter = '';
  if (opts.sport) {
    args.push(opts.sport);
    sportFilter = `AND sport = $${args.length}`;
  }

  const sql = `
    WITH window AS (
      SELECT *
      FROM market_snapshots
      WHERE captured_at >= NOW() - ($1::int || ' hours')::interval
      ${sportFilter}
    ),
    grouped AS (
      SELECT
        sport,
        internal_player_id,
        raw_player_name,
        team,
        stat_key,
        direction,
        MIN(captured_at) AS first_seen_at,
        MAX(captured_at) AS latest_seen_at,
        COUNT(*)         AS snapshot_count
      FROM window
      GROUP BY sport, internal_player_id, raw_player_name, team, stat_key, direction
      HAVING COUNT(*) >= 2
    ),
    first_row AS (
      SELECT DISTINCT ON (sport, internal_player_id, raw_player_name, stat_key, direction)
        sport, internal_player_id, raw_player_name, stat_key, direction,
        line_value::numeric  AS first_line,
        implied_probability::numeric AS first_implied
      FROM window
      ORDER BY sport, internal_player_id, raw_player_name, stat_key, direction, captured_at ASC
    ),
    latest_row AS (
      SELECT DISTINCT ON (sport, internal_player_id, raw_player_name, stat_key, direction)
        sport, internal_player_id, raw_player_name, stat_key, direction,
        line_value::numeric  AS latest_line,
        implied_probability::numeric AS latest_implied
      FROM window
      ORDER BY sport, internal_player_id, raw_player_name, stat_key, direction, captured_at DESC
    )
    SELECT
      g.sport, g.internal_player_id, g.raw_player_name, g.team, g.stat_key, g.direction,
      f.first_line, l.latest_line,
      f.first_implied, l.latest_implied,
      g.first_seen_at, g.latest_seen_at, g.snapshot_count
    FROM grouped g
    JOIN first_row  f USING (sport, internal_player_id, raw_player_name, stat_key, direction)
    JOIN latest_row l USING (sport, internal_player_id, raw_player_name, stat_key, direction)
    WHERE ABS(l.latest_line - f.first_line) >= $${args.length + 1}
       OR (
         f.first_implied IS NOT NULL AND l.latest_implied IS NOT NULL
         AND ABS(l.latest_implied - f.first_implied) >= $${args.length + 2}
       )
    ORDER BY ABS(l.latest_line - f.first_line) DESC
    LIMIT $${args.length + 3}
  `;
  args.push(minLine, minImpl, limit);

  type Row = {
    sport: string;
    internal_player_id: string | null;
    raw_player_name: string;
    team: string | null;
    stat_key: string;
    direction: string;
    first_line: string;
    latest_line: string;
    first_implied: string | null;
    latest_implied: string | null;
    first_seen_at: Date;
    latest_seen_at: Date;
    snapshot_count: string;
  };
  const { rows } = await getPool().query<Row>(sql, args);

  return rows.map((r) => {
    const first = Number(r.first_line);
    const latest = Number(r.latest_line);
    const firstImpl = r.first_implied !== null ? Number(r.first_implied) : null;
    const latestImpl = r.latest_implied !== null ? Number(r.latest_implied) : null;
    return {
      sport: r.sport,
      playerId: r.internal_player_id,
      playerName: r.raw_player_name,
      team: r.team,
      statKey: r.stat_key,
      direction: r.direction,
      firstLine: first,
      latestLine: latest,
      lineDelta: latest - first,
      firstImplied: firstImpl,
      latestImplied: latestImpl,
      impliedDelta: firstImpl !== null && latestImpl !== null ? latestImpl - firstImpl : null,
      firstSeenAt: r.first_seen_at.toISOString(),
      latestSeenAt: r.latest_seen_at.toISOString(),
      snapshotCount: Number(r.snapshot_count),
    };
  });
}
