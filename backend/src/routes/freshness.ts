// Data-freshness endpoint — reports how stale our cached game-log
// data is by querying the most-recent game_date in player_game_logs.
// Frontend's FreshnessBanner consumes this to show "Data current
// through Mar 5" / "Data N days old" so users know whether tonight's
// projection is anchored in fresh or stale stats.
//
// Mounted at /api/freshness. NBA-specific (stats.nba.com sync); MLB
// uses statsapi.mlb.com directly so freshness is implicit.

import { Router } from 'express';
import { getDataFreshness, isDbConfigured } from '../db.js';

export const freshnessRouter: Router = Router();

freshnessRouter.get('/', async (_req, res) => {
  if (!isDbConfigured()) {
    res.json({ lastGameDate: null, daysStale: null, source: 'no-db' });
    return;
  }
  try {
    const f = await getDataFreshness();
    res.json({ ...f, source: 'db' });
  } catch (err) {
    console.error('data-freshness failed', err);
    res.status(500).json({ error: 'failed to read freshness' });
  }
});
