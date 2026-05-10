// Backend Express app composition. Single createApp() that mounts
// every router under /api/* (or root for SEO). Used by:
//   - server.ts (local dev / docker)
//   - api/index.ts (Vercel serverless wrapper)
//
// Sport-grouped routes:
//   /api/mlb    full MLB surface (deepest)
//   /api/mma    UFC scoreboard + slate + projections + fight detail
//   /api/wnba   maintenance-only per the 2026-05-09 priorities decision
//   (NBA lives under sport-default routes — /api/slate is NBA's slate
//    for back-compat; /api/standings, /api/games, etc. are NBA too.)
//
// Cross-sport routes:
//   /api/slate    NBA slate + cross-sport Elite + generic /live-grade
//   /api/news     auto-generated articles + Vercel cron handlers
//   /api/market   Market Brain admin + CLV truth metric + PrizePicks ingestion
//   /api/calibration  cross-sport calibration aggregator
//   /api/engine   ops counters (articles / snapshots / projections graded)
//
// Root-mounted (NOT /api):
//   /sitemap.xml · /rss.xml · /robots.txt — SEO, frontend rewrites
//   /news/:slug — SEO crawler stub for OG/Twitter meta on social shares

import express, { type Express } from 'express';
import cors from 'cors';
import { searchRouter } from './routes/search.js';
import { teamsRouter } from './routes/teams.js';
import { compareRouter } from './routes/compare.js';
import { aiRouter } from './routes/ai.js';
import { calibrationRouter } from './routes/calibration.js';
import { engineRouter } from './routes/engine.js';
import { liveRouter } from './routes/live.js';
import { playerRouter } from './routes/player.js';
import { freshnessRouter } from './routes/freshness.js';
import { trendingRouter } from './routes/trending.js';
import { gamesRouter } from './routes/games.js';
import { standingsRouter } from './routes/standings.js';
import { performersRouter } from './routes/performers.js';
import { slateRouter } from './routes/slate.js';
import { marketRouter } from './routes/market.js';
import { mlbRouter } from './routes/mlb.js';
import { mmaRouter } from './routes/mma.js';
import { newsRouter } from './routes/news.js';
import { seoRouter } from './routes/seo.js';
import { seoStubRouter } from './routes/seoStub.js';
import { wnbaRouter } from './routes/wnba.js';

export function createApp(): Express {
  const app = express();

  // CORS — allow any origin (we have no auth secrets in responses
  // and the API needs to be callable from the frontend's Vercel
  // domain plus any preview aliases). Explicit origin: true reflects
  // the request origin into the response header rather than '*',
  // which avoids stale browser-cached '*' responses.
  app.use(cors({
    origin: true,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Admin-Secret'],
  }));
  // Catch-all for OPTIONS so preflights never bypass our CORS layer.
  app.options('*', cors());

  // Disable any caching of API responses — multiple users were seeing
  // stale responses cached by the browser from earlier in the day,
  // including 404s from before the backend was redeployed (which
  // surfaced as confusing CORS errors). no-store prevents the browser
  // and any intermediate CDN from holding on to API responses.
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // Raise JSON body limit from the 100KB default. PrizePicks MLB
  // slates can run 500-1000 lines in pipe format — well past the
  // default. 4MB ceiling is generous; the slate route also caps the
  // resolved-line count separately to keep request processing within
  // Vercel's serverless function timeout.
  app.use(express.json({ limit: '4mb' }));

  app.get('/', (_req, res) => {
    res.json({
      service: 'statedge-backend',
      version: '0.0.1',
      endpoints: [
        '/health',
        '/api/teams',
        '/api/search/players?query=',
        '/api/compare/player-vs-team?playerId=&teamId=&range=',
        '/api/compare/player-vs-player?aId=&bId=&range=',
        '/api/compare/team-vs-team?aId=&bId=&range=',
        '/api/ai/summary (POST)',
        '/api/live/scoreboard?date=YYYY-MM-DD',
        '/api/player/:playerId/last-10?selectedStat=points',
        '/api/data-freshness',
        '/api/trending/players?limit=8',
        '/api/games/recent?limit=6',
        '/api/games/:gameId/boxscore',
        '/api/standings',
        '/api/slate/auto',
        '/api/slate/parse (POST)',
        '/api/mlb/teams',
        '/api/mlb/health',
        '/api/mlb/disclaimer',
      ],
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'statedge-backend' });
  });

  // Reports which build / commit is currently serving traffic. Vercel
  // injects VERCEL_GIT_COMMIT_SHA at build time. Useful for spotting
  // stale deploys when the frontend is on a newer commit than the
  // backend (or vice versa).
  app.get('/api/version', (_req, res) => {
    res.json({
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      deployedAt: process.env.VERCEL_DEPLOYMENT_CREATED_AT ?? null,
      hasGeminiKey: !!process.env.GEMINI_API_KEY,
      hasDb: !!process.env.DATABASE_URL,
      // Phase 103a — env-var status for the Market Brain provider
      // pipeline. Boolean only — never echoes the actual key value.
      hasOddsApiKey: !!process.env.ODDS_API_KEY,
      oddsApiMonthlyCredits: process.env.ODDS_API_MONTHLY_CREDITS
        ? Number(process.env.ODDS_API_MONTHLY_CREDITS)
        : null,
    });
  });

  app.use('/api/search', searchRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/compare', compareRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/calibration', calibrationRouter);
  app.use('/api/engine', engineRouter);
  app.use('/api/live', liveRouter);
  app.use('/api/player', playerRouter);
  app.use('/api/data-freshness', freshnessRouter);
  app.use('/api/trending', trendingRouter);
  app.use('/api/games', gamesRouter);
  app.use('/api/standings', standingsRouter);
  app.use('/api/performers', performersRouter);
  app.use('/api/slate', slateRouter);
  app.use('/api/mlb', mlbRouter);
  app.use('/api/mma', mmaRouter);
  app.use('/api/wnba', wnbaRouter);
  app.use('/api/market', marketRouter);
  app.use('/api/news', newsRouter);

  // SEO — sitemap.xml / rss.xml / robots.txt mounted at root, NOT
  // under /api. Frontend's vercel.json rewrites these paths over
  // here so crawlers see them at the public domain.
  app.use('/', seoRouter);

  // SEO crawler stub for /news/:slug — serves per-article OG/Twitter
  // meta tags when a known bot UA hits the URL. Humans get a 302 to
  // the SPA. Frontend vercel.json rewrites /news/* over here so the
  // stub runs on the public domain.
  app.use('/', seoStubRouter);

  // Explicit JSON 404 — avoids Express's default HTML response, which
  // can trip the Vercel serverless adapter on unmatched paths.
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.url });
  });

  return app;
}
