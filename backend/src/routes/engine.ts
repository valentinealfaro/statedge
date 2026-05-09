// Engine status — Phase 122.
//
// The operational pulse. Bloomberg Terminals always show what's
// happening RIGHT NOW; this endpoint surfaces the same firehose
// for StatEdge: articles auto-generated today, market snapshots
// captured, projections graded. Institutional users want to see
// the engine is genuinely running, not a static brochure.
//
// Three rolling windows per category (24h / 7d / all-time) plus
// "most recent" timestamps so the UI can show "last article: 12
// minutes ago." Public read — same accountability principle as
// /api/market/health.

import { Router } from 'express';
import { getPool, isDbConfigured } from '../db.js';

export const engineRouter: Router = Router();

type CategoryStats = {
  last24h: number;
  last7d: number;
  allTime: number;
  mostRecent: string | null;
};

type EngineStatusResponse = {
  articles: CategoryStats & {
    byKind24h: Record<string, number>;
  };
  marketSnapshots: CategoryStats;
  projectionsGraded: {
    // "Graded" = a CLV grade exists (later snapshot strictly after publish).
    // Same definition the truth-metric pages use.
    last7d: number;
    last30d: number;
  };
};

engineRouter.get('/status', async (_req, res) => {
  const out: EngineStatusResponse = {
    articles: {
      last24h: 0, last7d: 0, allTime: 0, mostRecent: null, byKind24h: {},
    },
    marketSnapshots: { last24h: 0, last7d: 0, allTime: 0, mostRecent: null },
    projectionsGraded: { last7d: 0, last30d: 0 },
  };

  if (!isDbConfigured()) {
    res.json(out);
    return;
  }

  try {
    const pool = getPool();
    // Articles — three counts + max in one query each. Tables are
    // independent so we run them in parallel via Promise.all.
    const [articlesAgg, articlesByKind, snapshotsAgg, mlbGraded7, wnbaGraded7, mlbGraded30, wnbaGraded30] = await Promise.all([
      pool.query<{ last_24h: string; last_7d: string; all_time: string; most_recent: Date | null }>(`
        SELECT
          COUNT(*) FILTER (WHERE published_at >= NOW() - INTERVAL '24 hours')::text AS last_24h,
          COUNT(*) FILTER (WHERE published_at >= NOW() - INTERVAL '7 days')::text  AS last_7d,
          COUNT(*)::text                                                            AS all_time,
          MAX(published_at)                                                         AS most_recent
        FROM articles
      `).catch(() => ({ rows: [{ last_24h: '0', last_7d: '0', all_time: '0', most_recent: null }] })),
      pool.query<{ kind: string; n: string }>(`
        SELECT kind, COUNT(*)::text AS n
          FROM articles
         WHERE published_at >= NOW() - INTERVAL '24 hours'
        GROUP BY kind
      `).catch(() => ({ rows: [] })),
      pool.query<{ last_24h: string; last_7d: string; all_time: string; most_recent: Date | null }>(`
        SELECT
          COUNT(*) FILTER (WHERE captured_at >= NOW() - INTERVAL '24 hours')::text AS last_24h,
          COUNT(*) FILTER (WHERE captured_at >= NOW() - INTERVAL '7 days')::text  AS last_7d,
          COUNT(*)::text                                                           AS all_time,
          MAX(captured_at)                                                         AS most_recent
        FROM market_snapshots
      `).catch(() => ({ rows: [{ last_24h: '0', last_7d: '0', all_time: '0', most_recent: null }] })),
      // Graded = a later snapshot existed for the projection. Match
      // the same shape /api/market/clv uses.
      pool.query<{ n: string }>(`
        SELECT COUNT(DISTINCT h.id)::text AS n
          FROM mlb_projection_history h
          JOIN market_snapshots s
            ON s.sport = 'mlb'
           AND s.game_date = h.game_date
           AND s.stat_key = h.selected_stat
           AND s.captured_at > h.created_at
         WHERE h.game_date >= (CURRENT_DATE - 7)
      `).catch(() => ({ rows: [{ n: '0' }] })),
      pool.query<{ n: string }>(`
        SELECT COUNT(DISTINCT h.id)::text AS n
          FROM wnba_projection_history h
          JOIN market_snapshots s
            ON s.sport = 'wnba'
           AND s.game_date = h.game_date
           AND s.stat_key = h.selected_stat
           AND s.captured_at > h.created_at
         WHERE h.game_date >= (CURRENT_DATE - 7)
      `).catch(() => ({ rows: [{ n: '0' }] })),
      pool.query<{ n: string }>(`
        SELECT COUNT(DISTINCT h.id)::text AS n
          FROM mlb_projection_history h
          JOIN market_snapshots s
            ON s.sport = 'mlb'
           AND s.game_date = h.game_date
           AND s.stat_key = h.selected_stat
           AND s.captured_at > h.created_at
         WHERE h.game_date >= (CURRENT_DATE - 30)
      `).catch(() => ({ rows: [{ n: '0' }] })),
      pool.query<{ n: string }>(`
        SELECT COUNT(DISTINCT h.id)::text AS n
          FROM wnba_projection_history h
          JOIN market_snapshots s
            ON s.sport = 'wnba'
           AND s.game_date = h.game_date
           AND s.stat_key = h.selected_stat
           AND s.captured_at > h.created_at
         WHERE h.game_date >= (CURRENT_DATE - 30)
      `).catch(() => ({ rows: [{ n: '0' }] })),
    ]);

    const aRow = articlesAgg.rows[0];
    if (aRow) {
      out.articles.last24h = Number(aRow.last_24h);
      out.articles.last7d  = Number(aRow.last_7d);
      out.articles.allTime = Number(aRow.all_time);
      out.articles.mostRecent = aRow.most_recent ? aRow.most_recent.toISOString() : null;
    }
    for (const r of articlesByKind.rows) {
      out.articles.byKind24h[r.kind] = Number(r.n);
    }

    const sRow = snapshotsAgg.rows[0];
    if (sRow) {
      out.marketSnapshots.last24h = Number(sRow.last_24h);
      out.marketSnapshots.last7d  = Number(sRow.last_7d);
      out.marketSnapshots.allTime = Number(sRow.all_time);
      out.marketSnapshots.mostRecent = sRow.most_recent ? sRow.most_recent.toISOString() : null;
    }

    const gradedRow = (q: { rows: Array<{ n: string }> }) => Number(q.rows[0]?.n ?? 0);
    out.projectionsGraded.last7d  = gradedRow(mlbGraded7) + gradedRow(wnbaGraded7);
    out.projectionsGraded.last30d = gradedRow(mlbGraded30) + gradedRow(wnbaGraded30);

    res.json(out);
  } catch (err) {
    console.error('engine/status failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});
