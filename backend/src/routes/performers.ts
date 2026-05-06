import { Router } from 'express';
import { currentSeason } from '../nba/client.js';
import { getTopPerformersFromDb, isDbConfigured } from '../db.js';

export const performersRouter: Router = Router();

// Last night's top scorers — anchored to the most recent date in cache,
// not literal 'today', because the sync only runs once a day. Used by
// the home page card.
performersRouter.get('/top', async (req, res) => {
  if (!isDbConfigured()) {
    res.json({ performers: [], source: 'no-db' });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 6), 1), 20);
  const season = String(req.query.season ?? currentSeason());

  try {
    const performers = await getTopPerformersFromDb(season, limit);
    res.json({ performers, season, source: 'db' });
  } catch (err) {
    console.error('top performers failed', err);
    res.status(500).json({ error: 'failed to compute top performers' });
  }
});
