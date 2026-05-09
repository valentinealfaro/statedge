// UFC slate persistence — Phase 110a.
//
// Stores parsed UFC props per slate-day. No projection engine yet
// (that needs a fighter-stat DB which is a separate multi-phase
// build) — this just captures the raw lines so the frontend can
// render a published slate AND so the news engine has data to
// operate on (line-steam articles, edge tracking once projections
// arrive).

import { getPool, isDbConfigured } from '../db.js';
import type { UfcStatKey } from './stats.js';

let tableEnsured = false;

export type MmaStoredLine = {
  fighterName: string;
  league: string;             // "UFC"
  statKey: UfcStatKey;
  line: number;
  direction: 'over' | 'under' | 'both';
};

export type MmaDailySlateRow = {
  publishedDate: string;      // YYYY-MM-DD ET
  lines: MmaStoredLine[];
  rawText: string | null;
  publishedAt: string;        // ISO
};

async function ensureTable(): Promise<void> {
  if (tableEnsured || !isDbConfigured()) {
    tableEnsured = true;
    return;
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS mma_daily_slates (
      published_date  DATE PRIMARY KEY,
      lines           JSONB NOT NULL,
      raw_text        TEXT,
      published_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS mma_daily_slates_recent_idx
      ON mma_daily_slates (published_date DESC);
  `);
  tableEnsured = true;
}

export async function setMmaDailySlate(opts: {
  date: string;                  // YYYY-MM-DD ET
  lines: MmaStoredLine[];
  rawText: string | null;
}): Promise<void> {
  await ensureTable();
  await getPool().query(
    `INSERT INTO mma_daily_slates (published_date, lines, raw_text, published_at, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW(), NOW())
     ON CONFLICT (published_date) DO UPDATE SET
       lines = EXCLUDED.lines,
       raw_text = EXCLUDED.raw_text,
       updated_at = NOW()`,
    [opts.date, JSON.stringify(opts.lines), opts.rawText],
  );
}

export async function getMmaDailySlate(date: string): Promise<MmaDailySlateRow | null> {
  if (!isDbConfigured()) return null;
  await ensureTable();
  const { rows } = await getPool().query<{
    published_date: Date;
    lines: MmaStoredLine[];
    raw_text: string | null;
    published_at: Date;
  }>(
    `SELECT published_date, lines, raw_text, published_at
       FROM mma_daily_slates
      WHERE published_date = $1`,
    [date],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    publishedDate: row.published_date.toISOString().slice(0, 10),
    lines: row.lines,
    rawText: row.raw_text,
    publishedAt: row.published_at.toISOString(),
  };
}

export async function getLatestMmaDailySlate(): Promise<MmaDailySlateRow | null> {
  if (!isDbConfigured()) return null;
  await ensureTable();
  const { rows } = await getPool().query<{
    published_date: Date;
    lines: MmaStoredLine[];
    raw_text: string | null;
    published_at: Date;
  }>(
    `SELECT published_date, lines, raw_text, published_at
       FROM mma_daily_slates
      ORDER BY published_date DESC
      LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    publishedDate: row.published_date.toISOString().slice(0, 10),
    lines: row.lines,
    rawText: row.raw_text,
    publishedAt: row.published_at.toISOString(),
  };
}
