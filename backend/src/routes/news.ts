// News API routes — Phase 104.
//
// Public read surface for the article system. Frontend hits these
// to render /news index + /news/:slug pages. Plus admin-gated
// endpoints to manually trigger generation (useful for testing
// templates without waiting for the slate publish).

import { Router } from 'express';
import {
  generateBigGameArticles,
  generateDailyClvRecaps,
  generateDailyEdgePreviews,
  generateSlatePublishArticles,
} from '../news/generator.js';
import { fetchMlbBigGameInputs } from '../news/mlbBigGameFetcher.js';
import {
  getArticleBySlug,
  listArticles,
} from '../news/store.js';
import type { ArticleKind, ArticleSport } from '../news/types.js';

export const newsRouter: Router = Router();

// GET /api/news?sport=mlb&kind=top_mispricings&limit=20&playerId=12345
//
// List recent articles. All filters optional. Default 30 most recent
// across all sports + kinds.
newsRouter.get('/', async (req, res) => {
  try {
    const sport = req.query.sport as ArticleSport | undefined;
    const kind = req.query.kind as ArticleKind | undefined;
    const limit = req.query.limit ? Math.max(1, Math.min(200, Number(req.query.limit))) : 30;
    const playerId = req.query.playerId as string | undefined;
    const articles = await listArticles({ sport, kind, limit, playerId });
    res.json({ articles, count: articles.length });
  } catch (err) {
    console.error('news/list failed', err);
    res.status(500).json({ error: 'news list failed' });
  }
});

// GET /api/news/:slug — single article body
newsRouter.get('/:slug', async (req, res) => {
  try {
    const article = await getArticleBySlug(req.params.slug);
    if (!article) {
      res.status(404).json({ error: 'article not found' });
      return;
    }
    res.json({ article });
  } catch (err) {
    console.error('news/show failed', err);
    res.status(500).json({ error: 'news fetch failed' });
  }
});

// POST /api/news/generate (admin only)
//
// Manual trigger for any of the bundle generators. Useful for testing
// templates without waiting for cron / slate publish. Body specifies
// which bundle to fire.
newsRouter.post('/generate', async (req, res) => {
  const expected = process.env.SLATE_ADMIN_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'SLATE_ADMIN_SECRET not configured' });
    return;
  }
  if (req.header('x-admin-secret') !== expected) {
    res.status(401).json({ error: 'admin secret required' });
    return;
  }

  const body = (req.body ?? {}) as {
    bundle?: 'slate-publish' | 'big-game' | 'clv-recap' | 'edge-preview';
    edges?: unknown;
    inputs?: unknown;
    date?: string;
  };

  try {
    let articles: unknown;
    switch (body.bundle) {
      case 'slate-publish':
        articles = await generateSlatePublishArticles({
          edges: (body.edges as []) ?? [],
          date: body.date,
        });
        break;
      case 'big-game':
        articles = await generateBigGameArticles({
          inputs: (body.inputs as []) ?? [],
        });
        break;
      case 'clv-recap':
        articles = await generateDailyClvRecaps({
          date: body.date ?? new Date().toISOString().slice(0, 10),
        });
        break;
      case 'edge-preview':
        articles = await generateDailyEdgePreviews({
          edges: (body.edges as []) ?? [],
          date: body.date ?? new Date().toISOString().slice(0, 10),
        });
        break;
      default:
        res.status(400).json({ error: 'body.bundle must be one of slate-publish | big-game | clv-recap | edge-preview' });
        return;
    }
    res.json({ ok: true, bundle: body.bundle, articles });
  } catch (err) {
    console.error('news/generate failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------- Vercel Cron handlers (Phase 104i) ----------
//
// Vercel Cron only fires GET requests. Each cron path validates the
// Authorization Bearer header against CRON_SECRET. Schedules live in
// backend/vercel.json.

function requireCronAuth(req: Parameters<Parameters<typeof newsRouter.get>[1]>[0]): string | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return 'CRON_SECRET not configured';
  const authHeader = req.header('authorization') ?? '';
  if (authHeader !== `Bearer ${cronSecret}`) return 'cron auth required';
  return null;
}

// ET-date helper (matches generator.ts). News cadence is anchored to
// the user's perceived "today" (Eastern Time), not UTC.
function todayEt(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function yesterdayEt(): string {
  // Step back one ET day. Using the local date arithmetic is safe
  // because we only care about a YYYY-MM-DD string.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// GET /api/news/cron/big-game — fires several times during evening ET.
// Pulls today's completed MLB games, runs detector, persists articles.
// NBA + WNBA detection added when their boxscore fetchers are wired.
newsRouter.get('/cron/big-game', async (req, res) => {
  const authErr = requireCronAuth(req);
  if (authErr) {
    res.status(authErr.includes('configured') ? 503 : 401).json({ error: authErr });
    return;
  }
  try {
    const date = (req.query.date as string | undefined) ?? todayEt();
    const inputs = await fetchMlbBigGameInputs(date);
    const articles = await generateBigGameArticles({ inputs });
    res.json({
      ok: true,
      date,
      sport: 'mlb',
      gamesScanned: new Set(inputs.map((i) => i.game.eventId)).size,
      playersScanned: inputs.length,
      articlesGenerated: articles.length,
      articles: articles.map((a) => ({ slug: a.slug, title: a.title })),
    });
  } catch (err) {
    console.error('cron/big-game failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/news/cron/clv-recap — daily morning ET. Reads yesterday's
// CLV summary from the market_snapshots × projection_history join,
// persists per-sport articles. No external data — fully wired.
newsRouter.get('/cron/clv-recap', async (req, res) => {
  const authErr = requireCronAuth(req);
  if (authErr) {
    res.status(authErr.includes('configured') ? 503 : 401).json({ error: authErr });
    return;
  }
  try {
    const date = (req.query.date as string | undefined) ?? yesterdayEt();
    const articles = await generateDailyClvRecaps({ date });
    res.json({
      ok: true,
      date,
      articlesGenerated: articles.length,
      articles: articles.map((a) => ({ slug: a.slug, title: a.title })),
    });
  } catch (err) {
    console.error('cron/clv-recap failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/news/cron/edge-preview — morning ET. Re-frames the day's
// dislocations as a forward-looking preview. Edges aren't recomputed
// here — caller should POST /api/news/generate with bundle=edge-preview
// from the slate publish path. This cron only runs if there are no
// edge_preview articles for today already (covers slates that publish
// before the edge_preview cadence kicks in).
//
// For now this endpoint is a no-op when no edges are passed. Wiring
// a "fetch latest edges from DB" helper is a small follow-up; keeping
// the cron path live so the scheduler entry is stable.
newsRouter.get('/cron/edge-preview', async (req, res) => {
  const authErr = requireCronAuth(req);
  if (authErr) {
    res.status(authErr.includes('configured') ? 503 : 401).json({ error: authErr });
    return;
  }
  try {
    const date = (req.query.date as string | undefined) ?? todayEt();
    const articles = await generateDailyEdgePreviews({ edges: [], date });
    res.json({
      ok: true,
      date,
      articlesGenerated: articles.length,
      note: articles.length === 0
        ? 'no-op: edges store fetcher pending; slate-publish flow already auto-generates'
        : undefined,
    });
  } catch (err) {
    console.error('cron/edge-preview failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});
