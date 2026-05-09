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
