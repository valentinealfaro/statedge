// News API routes — Phase 104.
//
// Public read surface for the article system. Frontend hits these
// to render /news index + /news/:slug pages. Plus admin-gated
// endpoints to manually trigger generation (useful for testing
// templates without waiting for the slate publish).

import { Router } from 'express';
import { listRecentSnapshots, type RawSnapshotRow } from '../market/snapshots.js';
import { fetchEspnAthleteBio } from '../news/espnBio.js';
import { fetchGoogleNewsHeadlines } from '../news/externalNews.js';
import { fetchMlbAthleteBio } from '../news/mlbBio.js';
import { fetchUfcFightNightInputs } from '../news/mmaFightNightFetcher.js';
import type { EdgeLeg } from '../news/templates.js';
import {
  generateBigGameArticles,
  generateDailyClvRecaps,
  generateDailyEdgePreviews,
  generateFightNightArticles,
  generateLineSteamArticles,
  generatePowerRankingsArticles,
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

// GET /api/news?sport=mlb&kind=top_mispricings&limit=20&playerId=12345&gameKey=BOS-NYY
//
// List recent articles. All filters optional. Default 30 most recent
// across all sports + kinds.
newsRouter.get('/', async (req, res) => {
  try {
    const sport = req.query.sport as ArticleSport | undefined;
    const kind = req.query.kind as ArticleKind | undefined;
    const limit = req.query.limit ? Math.max(1, Math.min(200, Number(req.query.limit))) : 30;
    const playerId = req.query.playerId as string | undefined;
    const gameKey = req.query.gameKey as string | undefined;
    const articles = await listArticles({ sport, kind, limit, playerId, gameKey });
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

    // Bio enrichment — sport-routed because IDs aren't shared:
    //   - NBA / WNBA / MMA player ids in our system ARE ESPN athlete
    //     ids (we ingest from ESPN scoreboard) → use fetchEspnAthleteBio
    //   - MLB ids are MLB Stats API ids → use MLB Stats /people endpoint
    //     directly (109a) which returns the same fields ESPN does, with
    //     bonus MLB-specific niceties (mlbDebutDate, draft year)
    const espnSlug =
      sport === 'nba'  ? 'basketball/nba' as const
      : sport === 'wnba' ? 'basketball/wnba' as const
      : sport === 'mma'  ? 'mma/ufc' as const
      : null;

    const bioPromise: Promise<unknown> =
      sport === 'mlb'  ? fetchMlbAthleteBio(id)
      : espnSlug       ? fetchEspnAthleteBio(id, espnSlug)
      : Promise.resolve(null);

    const [articles, headlines, bio] = await Promise.all([
      listArticles({ playerId: id, limit: 12 }),
      playerName ? fetchGoogleNewsHeadlines(playerName, { limit: 8 }) : Promise.resolve([]),
      bioPromise,
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
      bio,
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
  } else if (sport === 'mma') {
    links.push({ label: 'UFC Profile',    url: `https://www.ufc.com/athlete/${slugifyName(name)}`, kind: 'reference' });
    links.push({ label: 'UFCStats',       url: `https://www.ufcstats.com/statistics/fighters?char=${q.charAt(0)}`, kind: 'reference' });
    links.push({ label: 'Tapology',       url: `https://www.tapology.com/search?term=${q}&mainSearchFilter=fighters`, kind: 'reference' });
  }
  return links;
}

function slugifyName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
// today's completed MLB + NBA games AND today's completed UFC fights,
// runs the detector across all three, persists articles (big-game
// for MLB + NBA, fight-night for UFC). Sport-aggregate response
// shows what scanned in each league for diagnostics.
//
// MLB + NBA + UFC wired today (Phase 107e added UFC fight-night via
// fetchUfcFightNightInputs / generateFightNightArticles). WNBA stays
// deprioritized — existing code remains but no new fetcher per the
// 2026-05-09 sport-priorities decision.
newsRouter.get('/cron/big-game', async (req, res) => {
  const authErr = requireCronAuth(req);
  if (authErr) {
    res.status(authErr.includes('configured') ? 503 : 401).json({ error: authErr });
    return;
  }
  try {
    const date = (req.query.date as string | undefined) ?? todayEt();
    // Run all fetchers in parallel — they hit different upstreams
    // (MLB Stats API vs ESPN NBA vs ESPN UFC), so no shared rate-
    // limit pressure.
    const [mlbInputs, nbaInputs, ufcInputs] = await Promise.all([
      fetchMlbBigGameInputs(date),
      fetchNbaBigGameInputs(date),
      fetchUfcFightNightInputs({ date }),
    ]);
    const inputs = [...mlbInputs, ...nbaInputs];
    const [bigGameArticles, fightNightArticles] = await Promise.all([
      generateBigGameArticles({ inputs }),
      generateFightNightArticles({ inputs: ufcInputs }),
    ]);
    const articles = [...bigGameArticles, ...fightNightArticles];
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
      ufc: {
        eventsScanned: ufcInputs.length,
        fightsScanned: ufcInputs.reduce((sum, e) => sum + e.fights.length, 0),
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

// GET /api/news/cron/power-rankings — weekly. Pulls active-sport
// standings, generates one ranking article per sport (NBA + MLB
// today; WNBA + UFC slot in when their feeds wire up). Idempotent
// via slug — re-running mid-week refreshes the prior week's article
// rather than creating duplicates.
newsRouter.get('/cron/power-rankings', async (req, res) => {
  const authErr = requireCronAuth(req);
  if (authErr) {
    res.status(authErr.includes('configured') ? 503 : 401).json({ error: authErr });
    return;
  }
  try {
    const date = (req.query.date as string | undefined) ?? todayEt();
    const articles = await generatePowerRankingsArticles({ date });
    res.json({
      ok: true,
      date,
      articlesGenerated: articles.length,
      articles: articles.map((a) => ({ slug: a.slug, title: a.title })),
    });
  } catch (err) {
    console.error('cron/power-rankings failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/news/cron/line-steam — afternoon ET. Reads the last 24h
// of market_snapshots, computes per-prop first-vs-latest deltas,
// emits one article per sport with the biggest movers.
newsRouter.get('/cron/line-steam', async (req, res) => {
  const authErr = requireCronAuth(req);
  if (authErr) {
    res.status(authErr.includes('configured') ? 503 : 401).json({ error: authErr });
    return;
  }
  try {
    const date = (req.query.date as string | undefined) ?? todayEt();
    const hours = req.query.hours ? Number(req.query.hours) : 24;
    const articles = await generateLineSteamArticles({ date, hours });
    res.json({
      ok: true,
      date,
      hours,
      articlesGenerated: articles.length,
      articles: articles.map((a) => ({ slug: a.slug, title: a.title })),
    });
  } catch (err) {
    console.error('cron/line-steam failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/news/cron/edge-preview — morning ET. Pulls the most-recent
// PrizePicks market snapshots from the last 12 hours, converts them
// to the EdgeLeg shape the templates consume, and fires the morning
// preview articles per sport. Articles are slug-deduped on date+sport
// so re-running merges with anything the slate-publish flow already
// produced.
//
// edgePercent / projection / trapScore are not available from market
// data alone — this cron emits the "shape of the board" preview (line
// counts, sport breakdown, names of top market lines). The slate-
// publish auto-fire (104f) does the same but with our model projections
// when available.
newsRouter.get('/cron/edge-preview', async (req, res) => {
  const authErr = requireCronAuth(req);
  if (authErr) {
    res.status(authErr.includes('configured') ? 503 : 401).json({ error: authErr });
    return;
  }
  try {
    const date = (req.query.date as string | undefined) ?? todayEt();
    const edges = await loadLatestEdgesFromSnapshots();
    const articles = await generateDailyEdgePreviews({ edges, date });
    res.json({
      ok: true,
      date,
      edgesLoaded: edges.length,
      bySport: countBySport(edges),
      articlesGenerated: articles.length,
      articles: articles.map((a) => ({ slug: a.slug, title: a.title })),
    });
  } catch (err) {
    console.error('cron/edge-preview failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Pull the latest 12 hours of market_snapshots per sport and convert
// each row into the EdgeLeg shape templates accept. Implied probability
// from the bookmaker is the only probability signal we have; edgePercent
// + projection + trapScore default to zero (templates handle gracefully).
async function loadLatestEdgesFromSnapshots(): Promise<EdgeLeg[]> {
  // listRecentSnapshots returns rows DESC by captured_at; we keep
  // the latest row per (sport, playerId, statKey, line, direction)
  // so a single morning preview reflects the freshest market state.
  const sports: Array<'mlb' | 'nba' | 'wnba'> = ['mlb', 'nba', 'wnba'];
  const out: EdgeLeg[] = [];
  for (const sport of sports) {
    const rows = await listRecentSnapshots({ sport, hours: 12, limit: 500 });
    const dedup = new Map<string, RawSnapshotRow>();
    for (const r of rows) {
      const key = `${r.internal_player_id ?? r.raw_player_name}::${r.stat_key}::${r.line_value}::${r.direction}`;
      if (!dedup.has(key)) dedup.set(key, r);
    }
    for (const r of dedup.values()) {
      const playerId = r.internal_player_id ?? r.raw_player_name;
      if (!playerId) continue;
      const direction = r.direction.toUpperCase() === 'UNDER' ? 'UNDER' : 'OVER';
      out.push({
        sport,
        playerId,
        playerName: r.raw_player_name,
        team: r.team,
        statLabel: r.stat_key,
        line: Number(r.line_value),
        direction,
        probability: r.implied_probability ? Number(r.implied_probability) * 100 : 50,
        edgePercent: 0,         // unknown without projections; filled in when slate-publish runs
        trapScore: 0,
        projection: Number(r.line_value),
        marketImpliedProb: r.implied_probability ? Number(r.implied_probability) * 100 : null,
      });
    }
  }
  return out;
}

function countBySport(edges: EdgeLeg[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of edges) out[e.sport] = (out[e.sport] ?? 0) + 1;
  return out;
}
