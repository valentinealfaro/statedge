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
