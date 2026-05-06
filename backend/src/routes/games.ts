import { Router } from 'express';
import { currentSeason } from '../nba/client.js';
import { getRecentGamesFromDb, isDbConfigured } from '../db.js';

export const gamesRouter: Router = Router();

// Most recent completed NBA games (paired team scores). Used to populate
// a 'last night around the league' card on the Home page — no live data
// dependency, just the same DB cache that drives the comparison views.
gamesRouter.get('/recent', async (req, res) => {
  if (!isDbConfigured()) {
    res.json({ games: [], season: null, source: 'no-db' });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 6), 1), 20);
  const season = String(req.query.season ?? currentSeason());

  try {
    const games = await getRecentGamesFromDb(season, limit);
    res.json({ games, season, source: 'db' });
  } catch (err) {
    console.error('recent games failed', err);
    res.status(500).json({ error: 'failed to compute recent games' });
  }
});
