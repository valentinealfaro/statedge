// Market Brain snapshot persistence — Phase 103a.
//
// THE most important Phase 103 immediate task per the spec:
// "Even WITHOUT expensive historical data: we can start building
// proprietary market memory TODAY."
//
// Every NormalizedProp from any provider gets persisted here. Within
// weeks of running, this table holds proprietary market memory that
// no provider feed can sell us — our own historical record of how
// lines moved, when they moved, and what the model said about each
// version.
//
// Schema is intentionally wide + flat. Querying historical patterns
// (Phase 103g situation clustering) wants direct columns over JSONB
// where possible. The (provider_source, bookmaker, sport, game_date,
// raw_player_name, stat_key, line, direction, captured_at) tuple
// uniquely identifies a snapshot — but we don't enforce uniqueness
// because the same line at the same minute from two adapters is
// information we want to keep separately.

import { getPool, isDbConfigured } from '../db.js';
import type {
  Bookmaker,
  MarketSport,
  NormalizedProp,
  ProviderSource,
} from './types.js';

let snapshotsTableEnsured = false;

export async function ensureMarketSnapshotsTable(): Promise<void> {
  if (snapshotsTableEnsured || !isDbConfigured()) {
    snapshotsTableEnsured = true;
    return;
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id                    BIGSERIAL PRIMARY KEY,
      captured_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      provider_updated_at   TIMESTAMPTZ,

      -- Source provenance
      provider_source       TEXT NOT NULL,
      bookmaker             TEXT NOT NULL,

      -- Game context
      sport                 TEXT NOT NULL,
      league                TEXT NOT NULL,
      provider_game_id      TEXT,
      game_key              TEXT,
      game_date             DATE NOT NULL,

      -- Player + team
      raw_player_name       TEXT NOT NULL,
      internal_player_id    TEXT,            -- NBA + MLB are numeric, WNBA string; store as text
      team                  TEXT,
      opponent              TEXT,

      -- The prop
      raw_stat_type         TEXT NOT NULL,
      stat_key              TEXT NOT NULL,
      line_value            NUMERIC NOT NULL,
      direction             TEXT NOT NULL,

      -- Pricing (all three formats stored)
      american_odds         NUMERIC,
      decimal_odds          NUMERIC,
      implied_probability   NUMERIC,

      -- DFS book restrictions
      is_demon              BOOLEAN,
      is_goblin             BOOLEAN
    );

    -- Time-series queries dominate (recent snapshots, line-history per
    -- prop). Index date+player+stat for the common consensus query +
    -- captured_at for time-window scans.
    CREATE INDEX IF NOT EXISTS market_snapshots_recent_idx
      ON market_snapshots (captured_at DESC);
    CREATE INDEX IF NOT EXISTS market_snapshots_prop_idx
      ON market_snapshots (sport, game_date, raw_player_name, stat_key);
    CREATE INDEX IF NOT EXISTS market_snapshots_player_idx
      ON market_snapshots (internal_player_id, captured_at DESC);
  `);
  snapshotsTableEnsured = true;
}

// Bulk-insert. Single transaction so a half-failed batch doesn't leave
// the snapshots table partially written. Returns count actually inserted.
export async function writeMarketSnapshots(
  props: NormalizedProp[],
): Promise<{ inserted: number }> {
  if (!isDbConfigured()) return { inserted: 0 };
  if (props.length === 0) return { inserted: 0 };
  await ensureMarketSnapshotsTable();
  const pool = getPool();
  let inserted = 0;
  // Per-row insert keeps the failure mode obvious. Bulk INSERT INTO ...
  // VALUES (...), (...), ... is faster but harder to debug when one
  // row trips a constraint. Phase 103a's volume (single admin paste,
  // ~50-200 rows) doesn't justify the complexity yet.
  for (const p of props) {
    await pool.query(
      `INSERT INTO market_snapshots (
         captured_at, provider_updated_at,
         provider_source, bookmaker,
         sport, league, provider_game_id, game_key, game_date,
         raw_player_name, internal_player_id, team, opponent,
         raw_stat_type, stat_key, line_value, direction,
         american_odds, decimal_odds, implied_probability,
         is_demon, is_goblin
       ) VALUES (
         $1, $2,
         $3, $4,
         $5, $6, $7, $8, $9,
         $10, $11, $12, $13,
         $14, $15, $16, $17,
         $18, $19, $20,
         $21, $22
       )`,
      [
        p.capturedAt,
        p.providerUpdatedAt,
        p.source,
        p.bookmaker,
        p.sport,
        p.league,
        p.providerGameId,
        p.gameKey,
        p.gameDate,
        p.rawPlayerName,
        p.internalPlayerId === null ? null : String(p.internalPlayerId),
        p.team,
        p.opponent,
        p.rawStatType,
        p.statKey,
        p.line,
        p.direction,
        p.americanOdds,
        p.decimalOdds,
        p.impliedProbability,
        p.isDemon,
        p.isGoblin,
      ],
    );
    inserted += 1;
  }
  return { inserted };
}

// Read recent snapshots — admin diagnostic + future Market Brain
// consumers. Bounded by hours window so big tables stay queryable.
export async function listRecentSnapshots(opts?: {
  hours?: number;
  sport?: MarketSport;
  bookmaker?: Bookmaker;
  source?: ProviderSource;
  limit?: number;
}): Promise<RawSnapshotRow[]> {
  if (!isDbConfigured()) return [];
  await ensureMarketSnapshotsTable();
  const hours = opts?.hours ?? 24;
  const limit = opts?.limit ?? 500;
  const filters: string[] = ['captured_at >= NOW() - ($1::int || \' hours\')::interval'];
  const args: Array<string | number> = [hours];
  if (opts?.sport)      { filters.push(`sport = $${args.length + 1}`);            args.push(opts.sport); }
  if (opts?.bookmaker)  { filters.push(`bookmaker = $${args.length + 1}`);        args.push(opts.bookmaker); }
  if (opts?.source)     { filters.push(`provider_source = $${args.length + 1}`);  args.push(opts.source); }
  args.push(limit);
  const limitParam = args.length;
  const { rows } = await getPool().query<RawSnapshotRow>(
    `SELECT id, captured_at, provider_source, bookmaker, sport,
            game_date, raw_player_name, internal_player_id, team,
            stat_key, line_value, direction, american_odds,
            implied_probability
       FROM market_snapshots
      WHERE ${filters.join(' AND ')}
      ORDER BY captured_at DESC
      LIMIT $${limitParam}`,
    args,
  );
  return rows;
}

export type RawSnapshotRow = {
  id: number;
  captured_at: Date;
  provider_source: string;
  bookmaker: string;
  sport: string;
  game_date: Date;
  raw_player_name: string;
  internal_player_id: string | null;
  team: string | null;
  stat_key: string;
  line_value: string;
  direction: string;
  american_odds: string | null;
  implied_probability: string | null;
};

// Quick total count + per-day rollup. Powers the admin "is the
// snapshot pipeline alive?" diagnostic.
export type SnapshotsHealth = {
  totalSnapshots: number;
  last24h: number;
  byBookmaker: Array<{ bookmaker: string; count: number }>;
  bySport: Array<{ sport: string; count: number }>;
  earliestSnapshot: string | null;
  latestSnapshot: string | null;
};

export async function getSnapshotsHealth(): Promise<SnapshotsHealth> {
  if (!isDbConfigured()) {
    return {
      totalSnapshots: 0,
      last24h: 0,
      byBookmaker: [],
      bySport: [],
      earliestSnapshot: null,
      latestSnapshot: null,
    };
  }
  await ensureMarketSnapshotsTable();
  const pool = getPool();
  const [totalRes, last24Res, byBookRes, bySportRes, rangeRes] = await Promise.all([
    pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM market_snapshots`),
    pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM market_snapshots WHERE captured_at >= NOW() - INTERVAL '24 hours'`),
    pool.query<{ bookmaker: string; c: string }>(
      `SELECT bookmaker, COUNT(*)::text AS c FROM market_snapshots
        WHERE captured_at >= NOW() - INTERVAL '7 days'
        GROUP BY bookmaker ORDER BY COUNT(*) DESC`,
    ),
    pool.query<{ sport: string; c: string }>(
      `SELECT sport, COUNT(*)::text AS c FROM market_snapshots
        WHERE captured_at >= NOW() - INTERVAL '7 days'
        GROUP BY sport ORDER BY COUNT(*) DESC`,
    ),
    pool.query<{ earliest: Date | null; latest: Date | null }>(
      `SELECT MIN(captured_at) AS earliest, MAX(captured_at) AS latest FROM market_snapshots`,
    ),
  ]);
  return {
    totalSnapshots: Number(totalRes.rows[0]?.c ?? 0),
    last24h: Number(last24Res.rows[0]?.c ?? 0),
    byBookmaker: byBookRes.rows.map((r) => ({ bookmaker: r.bookmaker, count: Number(r.c) })),
    bySport: bySportRes.rows.map((r) => ({ sport: r.sport, count: Number(r.c) })),
    earliestSnapshot: rangeRes.rows[0]?.earliest?.toISOString() ?? null,
    latestSnapshot:   rangeRes.rows[0]?.latest?.toISOString()   ?? null,
  };
}
