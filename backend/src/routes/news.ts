// News API routes — Phase 104.
//
// Public read surface for the article system. Frontend hits these
// to render /news index + /news/:slug pages. Plus admin-gated
// endpoints to manually trigger generation (useful for testing
// templates without waiting for the slate publish).

import { Router } from 'express';
import { fetchGoogleNewsHeadlines } from '../news/externalNews.js';
import {
  generateBigGameArticles,
  generateDailyClvRecaps,
  generateDailyEdgePreviews,
  generateSlatePublishArticles,
} from '../news/generator.js';
import { fetchMlbBigGameInputs } from '../news/mlbBigGameFetcher.js';
import { fetchNbaBigGameInputs } from '../news/nbaBigGameFetcher.js';
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

// GET /api/news/player/:sport/:id — player profile bundle. Returns
// our own articles about this player (from articles table), plus
// external news headlines from Google News, plus a set of social /
// reference search URLs. Frontend renders this as a "News & Links"
// section on the player profile page.
//
// Sport is part of the path because article slug + player-id pairs
// scope to a sport. The id matches articles.related_player_id.
newsRouter.get('/player/:sport/:id', async (req, res) => {
  try {
    const sport = req.params.sport as ArticleSport;
    const id = req.params.id;
    const playerName = (req.query.name as string | undefined) ?? '';

    const [articles, headlines] = await Promise.all([
      listArticles({ playerId: id, limit: 12 }),
      playerName ? fetchGoogleNewsHeadlines(playerName, { limit: 8 }) : Promise.resolve([]),
    ]);

    // Per-sport reference URL templates. Pure templates — frontend
    // renders these as link buttons. Twitter / Instagram / YouTube
    // searches use the player name; sport-specific reference sites
    // use the player id when the source supports it.
    const searchLinks = playerName ? buildSearchLinks(playerName, sport, id) : [];

    res.json({
      sport,
      playerId: id,
      playerName: playerName || null,
      articles,
      externalHeadlines: headlines,
      searchLinks,
    });
  } catch (err) {
    console.error('news/player failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

function buildSearchLinks(name: string, sport: ArticleSport, id: string): Array<{ label: string; url: string; kind: 'social' | 'reference' }> {
  const q = encodeURIComponent(name);
  const links: Array<{ label: string; url: string; kind: 'social' | 'reference' }> = [
    { label: 'Twitter / X',    url: `https://twitter.com/search?q=${q}&src=typed_query`, kind: 'social' },
    { label: 'Instagram',      url: `https://www.instagram.com/explore/tags/${q.replace(/%20/g, '')}`, kind: 'social' },
    { label: 'YouTube',        url: `https://www.youtube.com/results?search_query=${q}+highlights`, kind: 'social' },
    { label: 'Google News',    url: `https://news.google.com/search?q=${q}`, kind: 'reference' },
  ];
  if (sport === 'mlb') {
    links.push({ label: 'Baseball Savant', url: `https://baseballsavant.mlb.com/savant-player/${id}`, kind: 'reference' });
    links.push({ label: 'MLB.com Profile', url: `https://www.mlb.com/player/${id}`, kind: 'reference' });
  } else if (sport === 'nba') {
    links.push({ label: 'Basketball-Reference', url: `https://www.google.com/search?q=basketball-reference.com+${q}&btnI=I'm+Feeling+Lucky`, kind: 'reference' });
    links.push({ label: 'NBA.com', url: `https://www.nba.com/search?q=${q}` , kind: 'reference' });
  } else if (sport === 'wnba') {
    links.push({ label: 'WNBA.com', url: `https://www.wnba.com/search?q=${q}`, kind: 'reference' });
  }
  return links;
}

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

// GET /api/news/cron/big-game — fires once at end-of-night ET. Pulls
// today's completed MLB + NBA games, runs the detector across both
// leagues, persists articles. Sport-aggregate response shows what
// scanned in each league for diagnostics.
//
// MLB + NBA wired today; WNBA deprioritized (existing code remains
// but no new fetcher per the sport-priorities decision); MMA wires
// in alongside its full provider work.
newsRouter.get('/cron/big-game', async (req, res) => {
  const authErr = requireCronAuth(req);
  if (authErr) {
    res.status(authErr.includes('configured') ? 503 : 401).json({ error: authErr });
    return;
  }
  try {
    const date = (req.query.date as string | undefined) ?? todayEt();
    // Run both fetchers in parallel — they hit different upstreams
    // (MLB Stats API vs ESPN), so no shared rate-limit pressure.
    const [mlbInputs, nbaInputs] = await Promise.all([
      fetchMlbBigGameInputs(date),
      fetchNbaBigGameInputs(date),
    ]);
    const inputs = [...mlbInputs, ...nbaInputs];
    const articles = await generateBigGameArticles({ inputs });
    res.json({
      ok: true,
      date,
      mlb: {
        gamesScanned: new Set(mlbInputs.map((i) => i.game.eventId)).size,
        playersScanned: mlbInputs.length,
      },
      nba: {
        gamesScanned: new Set(nbaInputs.map((i) => i.game.eventId)).size,
        playersScanned: nbaInputs.length,
      },
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
