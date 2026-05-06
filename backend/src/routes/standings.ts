import { Router } from 'express';
import { currentSeason } from '../nba/client.js';
import { getStandingsFromDb, isDbConfigured } from '../db.js';

export const standingsRouter: Router = Router();

// Conference standings for the season — both regular and playoffs games
// are counted in the W-L record because the sync merges them. Most NBA
// sites show 'regular season standings only' here; we'll let the UI
// label this 'season record' to be honest.
standingsRouter.get('/', async (req, res) => {
  if (!isDbConfigured()) {
    res.json({ east: [], west: [], season: null, source: 'no-db' });
    return;
  }
  const season = String(req.query.season ?? currentSeason());

  try {
    const standings = await getStandingsFromDb(season);
    res.json({ ...standings, season, source: 'db' });
  } catch (err) {
    console.error('standings failed', err);
    res.status(500).json({ error: 'failed to compute standings' });
  }
});
