import express, { type Express } from 'express';
import cors from 'cors';
import { searchRouter } from './routes/search.js';
import { teamsRouter } from './routes/teams.js';
import { compareRouter } from './routes/compare.js';
import { aiRouter } from './routes/ai.js';
import { liveRouter } from './routes/live.js';
import { playerRouter } from './routes/player.js';
import { freshnessRouter } from './routes/freshness.js';
import { trendingRouter } from './routes/trending.js';

export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

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
      ],
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'statedge-backend' });
  });

  app.use('/api/search', searchRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/compare', compareRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/live', liveRouter);
  app.use('/api/player', playerRouter);
  app.use('/api/data-freshness', freshnessRouter);
  app.use('/api/trending', trendingRouter);

  // Explicit JSON 404 — avoids Express's default HTML response, which
  // can trip the Vercel serverless adapter on unmatched paths.
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.url });
  });

  return app;
}
