// Closing Line Value (CLV) Engine — Phase 103c.
//
// Per the Phase 103 spec: CLV becomes "the first REAL truth metric"
// for the platform. Win rate is a noisy short-term variance signal;
// CLV measures whether we beat the market's eventual closing line —
// the direct test of edge.
//
// Mission shift: stop judging the model by "did the pick win?"; start
// judging by "did we get a better number than the market eventually
// settled on?" A great pick can lose. A terrible pick can win. CLV
// separates good process from short-term luck.
//
// Computation: for every published projection (mlb_projection_history /
// wnba_projection_history row), find the LATEST market_snapshots row
// for the same (player, stat, game_date) where captured_at >
// created_at. Compute line/price/probability deltas. Direction-aware
// "beat" calculation:
//   OVER  + closing_line > publish_line  → market moved AWAY from us → we beat
//   OVER  + closing_line < publish_line  → market caught down       → we did not beat
//   UNDER + closing_line < publish_line  → market moved AWAY        → we beat
//   UNDER + closing_line > publish_line  → market caught up         → did not beat
//
// IMPORTANT: when only one snapshot exists per day (today's reality —
// admin paste = single snapshot), every CLV row reads as
// publishLine == closingLine and beatMarket is null. That's HONEST.
// As intra-day pastes accumulate (admin re-publishes when lines move),
// or when polling/paid feeds land in 103b/103g, real CLV emerges
// without changing this code.

import { getPool, isDbConfigured } from '../db.js';

export type ClvRow = {
  // Identity (from projection_history)
  projectionId: number;
  gameDate: string;
  playerId: number | string | null;
  rawPlayerName: string | null;
  team: string | null;
  statKey: string;
  direction: 'OVER' | 'UNDER';
  cardType: string | null;

  // What we published
  publishLine: number;
  publishedAt: string;       // ISO

  // What the market closed at (latest snapshot strictly after publish)
  closingLine: number | null;
  closingAt: string | null;
  snapshotsSeenAfter: number;

  // Direction-aware deltas
  lineDelta: number | null;          // closing - publish (signed)
  beatMarket: boolean | null;        // null when no closing observed yet
  beatMagnitude: number | null;      // |line delta| (in stat units)

  // Edge decay speed (hours from publish to closing snapshot)
  hoursToClosing: number | null;
};

export type ClvSummary = {
  windowDays: number;
  sport: string;
  total: number;                   // total projections in window
  withClosing: number;             // had ≥1 later snapshot
  beatMarket: number;              // beat the close
  matchedMarket: number;           // closing == publish (no movement)
  lostToMarket: number;            // market moved against us
  // null when no observations yet (no later snapshots).
  beatRate: number | null;         // beatMarket / withClosing × 100
  averageLineDelta: number | null; // mean of (direction-aware) movement
  averageBeatMagnitude: number | null; // mean |delta| where we beat
  averageHoursToClosing: number | null;

  // By stat type — where is our process beating the market most?
  byStatType: Array<{
    stat: string;
    samples: number;
    withClosing: number;
    beatMarket: number;
    beatRate: number | null;
    averageLineDelta: number | null;
  }>;

  rows: ClvRow[];
};

// MLB CLV. Query-time join: mlb_projection_history × market_snapshots.
export async function computeMlbClv(opts: { windowDays?: number; limit?: number }): Promise<ClvSummary> {
  const windowDays = opts.windowDays ?? 30;
  const limit = opts.limit ?? 500;
  if (!isDbConfigured()) return emptySummary('mlb', windowDays);

  const pool = getPool();
  // Pull projection rows with at-publish data + the latest later snapshot
  // joined inline. LEFT JOIN so projections without later snapshots
  // still surface (closing = null).
  const { rows } = await pool.query<{
    projection_id: number;
    game_date: Date;
    player_id: number | null;
    selected_stat: string;
    direction: string;
    publish_line: string;
    published_at: Date;
    card_type: string | null;
    closing_line: string | null;
    closing_at: Date | null;
    snapshots_after: string;
  }>(
    `WITH later_snaps AS (
       SELECT
         h.id                                        AS projection_id,
         s.line_value                                AS closing_line,
         s.captured_at                               AS closing_at,
         ROW_NUMBER() OVER (
           PARTITION BY h.id
           ORDER BY s.captured_at DESC
         ) AS rn,
         COUNT(*) OVER (PARTITION BY h.id) AS snapshots_after
       FROM mlb_projection_history h
       JOIN market_snapshots s
         ON s.sport = 'mlb'
        AND s.game_date = h.game_date
        AND s.stat_key = h.selected_stat
        AND (
          (s.internal_player_id IS NOT NULL AND s.internal_player_id = h.player_id::text)
          OR s.internal_player_id IS NULL    -- name-only fallback below
        )
        AND s.captured_at > h.created_at
        AND h.game_date >= (CURRENT_DATE - $1::int)
     )
     SELECT
       h.id           AS projection_id,
       h.game_date,
       h.player_id,
       h.selected_stat,
       h.direction,
       h.line_value   AS publish_line,
       h.created_at   AS published_at,
       h.card_type,
       ls.closing_line,
       ls.closing_at,
       COALESCE(ls.snapshots_after, 0)::text AS snapshots_after
     FROM mlb_projection_history h
     LEFT JOIN later_snaps ls
       ON ls.projection_id = h.id AND ls.rn = 1
     WHERE h.game_date >= (CURRENT_DATE - $1::int)
     ORDER BY h.created_at DESC
     LIMIT $2`,
    [windowDays, limit],
  );

  const clvRows: ClvRow[] = rows.map((r) => buildClvRow({
    projectionId:     r.projection_id,
    gameDate:         toIsoDate(r.game_date),
    playerId:         r.player_id,
    rawPlayerName:    null,
    team:             null,
    statKey:          r.selected_stat,
    direction:        r.direction === 'UNDER' ? 'UNDER' : 'OVER',
    cardType:         r.card_type,
    publishLine:      Number(r.publish_line),
    publishedAt:      r.published_at.toISOString(),
    closingLine:      r.closing_line === null ? null : Number(r.closing_line),
    closingAt:        r.closing_at?.toISOString() ?? null,
    snapshotsAfter:   Number(r.snapshots_after),
  }));

  return summarize('mlb', windowDays, clvRows);
}

// WNBA CLV. Same shape, different join (athlete_id is text in both
// wnba_projection_history and market_snapshots.internal_player_id).
export async function computeWnbaClv(opts: { windowDays?: number; limit?: number }): Promise<ClvSummary> {
  const windowDays = opts.windowDays ?? 30;
  const limit = opts.limit ?? 500;
  if (!isDbConfigured()) return emptySummary('wnba', windowDays);

  const pool = getPool();
  const { rows } = await pool.query<{
    projection_id: number;
    game_date: Date;
    athlete_id: string;
    player_name: string;
    team: string | null;
    stat_key: string;
    direction: string;
    publish_line: string;
    published_at: Date;
    card_type: string | null;
    closing_line: string | null;
    closing_at: Date | null;
    snapshots_after: string;
  }>(
    `WITH later_snaps AS (
       SELECT
         h.id                                        AS projection_id,
         s.line_value                                AS closing_line,
         s.captured_at                               AS closing_at,
         ROW_NUMBER() OVER (
           PARTITION BY h.id
           ORDER BY s.captured_at DESC
         ) AS rn,
         COUNT(*) OVER (PARTITION BY h.id) AS snapshots_after
       FROM wnba_projection_history h
       JOIN market_snapshots s
         ON s.sport = 'wnba'
        AND s.game_date = h.game_date
        AND s.stat_key = h.stat_key
        AND (
          (s.internal_player_id IS NOT NULL AND s.internal_player_id = h.athlete_id)
          OR LOWER(s.raw_player_name) = LOWER(h.player_name)
        )
        AND s.captured_at > h.created_at
        AND h.game_date >= (CURRENT_DATE - $1::int)
     )
     SELECT
       h.id           AS projection_id,
       h.game_date,
       h.athlete_id,
       h.player_name,
       h.team,
       h.stat_key,
       h.direction,
       h.line_value   AS publish_line,
       h.created_at   AS published_at,
       h.card_type,
       ls.closing_line,
       ls.closing_at,
       COALESCE(ls.snapshots_after, 0)::text AS snapshots_after
     FROM wnba_projection_history h
     LEFT JOIN later_snaps ls
       ON ls.projection_id = h.id AND ls.rn = 1
     WHERE h.game_date >= (CURRENT_DATE - $1::int)
     ORDER BY h.created_at DESC
     LIMIT $2`,
    [windowDays, limit],
  );

  const clvRows: ClvRow[] = rows.map((r) => buildClvRow({
    projectionId:     r.projection_id,
    gameDate:         toIsoDate(r.game_date),
    playerId:         r.athlete_id,
    rawPlayerName:    r.player_name,
    team:             r.team,
    statKey:          r.stat_key,
    direction:        r.direction === 'UNDER' ? 'UNDER' : 'OVER',
    cardType:         r.card_type,
    publishLine:      Number(r.publish_line),
    publishedAt:      r.published_at.toISOString(),
    closingLine:      r.closing_line === null ? null : Number(r.closing_line),
    closingAt:        r.closing_at?.toISOString() ?? null,
    snapshotsAfter:   Number(r.snapshots_after),
  }));

  return summarize('wnba', windowDays, clvRows);
}

// ---------- Pure helpers ----------

function buildClvRow(p: {
  projectionId: number;
  gameDate: string;
  playerId: number | string | null;
  rawPlayerName: string | null;
  team: string | null;
  statKey: string;
  direction: 'OVER' | 'UNDER';
  cardType: string | null;
  publishLine: number;
  publishedAt: string;
  closingLine: number | null;
  closingAt: string | null;
  snapshotsAfter: number;
}): ClvRow {
  let lineDelta: number | null = null;
  let beatMarket: boolean | null = null;
  let beatMagnitude: number | null = null;
  let hoursToClosing: number | null = null;

  if (p.closingLine !== null) {
    lineDelta = p.closingLine - p.publishLine;
    // Direction-aware beat:
    //   OVER : we beat when line moved UP (closing > publish)
    //   UNDER: we beat when line moved DOWN (closing < publish)
    if (p.direction === 'OVER') {
      beatMarket = lineDelta > 0;
    } else {
      beatMarket = lineDelta < 0;
    }
    beatMagnitude = Math.abs(lineDelta);
    if (lineDelta === 0) {
      // No movement — neither beat nor lost. Surface as null so it
      // doesn't poison the beatRate denominator.
      beatMarket = null;
      beatMagnitude = null;
    }

    if (p.closingAt) {
      const ms = new Date(p.closingAt).getTime() - new Date(p.publishedAt).getTime();
      hoursToClosing = ms > 0 ? Math.round((ms / 3_600_000) * 100) / 100 : null;
    }
  }

  return {
    projectionId:        p.projectionId,
    gameDate:            p.gameDate,
    playerId:            p.playerId,
    rawPlayerName:       p.rawPlayerName,
    team:                p.team,
    statKey:             p.statKey,
    direction:           p.direction,
    cardType:            p.cardType,
    publishLine:         p.publishLine,
    publishedAt:         p.publishedAt,
    closingLine:         p.closingLine,
    closingAt:           p.closingAt,
    snapshotsSeenAfter:  p.snapshotsAfter,
    lineDelta,
    beatMarket,
    beatMagnitude,
    hoursToClosing,
  };
}

function summarize(sport: string, windowDays: number, rows: ClvRow[]): ClvSummary {
  const total = rows.length;
  // "withClosing" excludes both no-closing AND zero-movement rows —
  // those don't contribute signal for/against beating the market.
  const withClosing = rows.filter((r) => r.beatMarket !== null).length;
  const beatMarket = rows.filter((r) => r.beatMarket === true).length;
  const matchedMarket = rows.filter((r) => r.closingLine !== null && r.lineDelta === 0).length;
  const lostToMarket = rows.filter((r) => r.beatMarket === false).length;

  const beatRate = withClosing === 0 ? null
    : Math.round((beatMarket / withClosing) * 1000) / 10;

  // Direction-aware average line delta. For OVER picks, positive delta
  // = we beat. For UNDER picks, negative delta = we beat. So the
  // direction-adjusted delta is signed-toward-beating.
  const observedDeltas = rows
    .filter((r) => r.beatMarket !== null && r.lineDelta !== null)
    .map((r) => r.direction === 'OVER' ? r.lineDelta! : -r.lineDelta!);
  const averageLineDelta = observedDeltas.length === 0 ? null
    : Math.round(
        (observedDeltas.reduce((s, d) => s + d, 0) / observedDeltas.length) * 100,
      ) / 100;

  const beatMagnitudes = rows
    .filter((r) => r.beatMarket === true && r.beatMagnitude !== null)
    .map((r) => r.beatMagnitude!);
  const averageBeatMagnitude = beatMagnitudes.length === 0 ? null
    : Math.round(
        (beatMagnitudes.reduce((s, m) => s + m, 0) / beatMagnitudes.length) * 100,
      ) / 100;

  const hoursList = rows
    .filter((r) => r.hoursToClosing !== null)
    .map((r) => r.hoursToClosing!);
  const averageHoursToClosing = hoursList.length === 0 ? null
    : Math.round((hoursList.reduce((s, h) => s + h, 0) / hoursList.length) * 100) / 100;

  // By stat type rollup
  const byStatMap = new Map<string, ClvRow[]>();
  for (const r of rows) {
    if (!byStatMap.has(r.statKey)) byStatMap.set(r.statKey, []);
    byStatMap.get(r.statKey)!.push(r);
  }
  const byStatType = [...byStatMap.entries()]
    .map(([stat, statRows]) => {
      const samples = statRows.length;
      const withC = statRows.filter((r) => r.beatMarket !== null).length;
      const beat = statRows.filter((r) => r.beatMarket === true).length;
      const deltas = statRows
        .filter((r) => r.beatMarket !== null && r.lineDelta !== null)
        .map((r) => r.direction === 'OVER' ? r.lineDelta! : -r.lineDelta!);
      return {
        stat,
        samples,
        withClosing: withC,
        beatMarket: beat,
        beatRate: withC === 0 ? null : Math.round((beat / withC) * 1000) / 10,
        averageLineDelta: deltas.length === 0 ? null
          : Math.round((deltas.reduce((s, d) => s + d, 0) / deltas.length) * 100) / 100,
      };
    })
    .sort((a, b) => b.samples - a.samples);

  return {
    sport,
    windowDays,
    total,
    withClosing,
    beatMarket,
    matchedMarket,
    lostToMarket,
    beatRate,
    averageLineDelta,
    averageBeatMagnitude,
    averageHoursToClosing,
    byStatType,
    rows,
  };
}

function emptySummary(sport: string, windowDays: number): ClvSummary {
  return {
    sport,
    windowDays,
    total: 0,
    withClosing: 0,
    beatMarket: 0,
    matchedMarket: 0,
    lostToMarket: 0,
    beatRate: null,
    averageLineDelta: null,
    averageBeatMagnitude: null,
    averageHoursToClosing: null,
    byStatType: [],
    rows: [],
  };
}

function toIsoDate(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
