// MLB routes mounted at /api/mlb. Phase 0/1 surface area: enough to
// verify the data pipeline (teams + counts + disclaimer) without
// shipping any user-facing pages yet. Projection / slate / compare
// endpoints land in Phase 2+ once the engines exist.

import { Router } from 'express';
import { isDbConfigured } from '../db.js';
import { MLB_DISCLAIMER } from '../mlb/client.js';
import {
  getMlbCounts,
  listMlbTeamsFromDb,
} from '../mlb/db.js';

export const mlbRouter: Router = Router();

// GET /api/mlb/teams — list all 30 MLB teams from the DB cache.
// Matches the NBA pattern (GET /api/teams returns the static team
// list). Returns the disclaimer alongside so any client showing MLB
// data has the legal text in-payload.
mlbRouter.get('/teams', async (_req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  try {
    const teams = await listMlbTeamsFromDb();
    res.json({ teams, disclaimer: MLB_DISCLAIMER });
  } catch (err) {
    console.error('mlb/teams failed', err);
    res.status(500).json({ error: 'mlb teams fetch failed' });
  }
});

// GET /api/mlb/health — verification endpoint. Reports row counts so
// we can confirm the sync scripts wrote what we expect. Useful both
// for ops and as the v1 acceptance smoke test.
mlbRouter.get('/health', async (_req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  try {
    const counts = await getMlbCounts();
    res.json({
      counts,
      disclaimer: MLB_DISCLAIMER,
      ready: counts.teams >= 30,
    });
  } catch (err) {
    console.error('mlb/health failed', err);
    res.status(500).json({ error: 'mlb health check failed' });
  }
});

// GET /api/mlb/disclaimer — surfaces the required legal text so any
// frontend page can fetch it without needing to bundle the constant.
mlbRouter.get('/disclaimer', (_req, res) => {
  res.json({ disclaimer: MLB_DISCLAIMER });
});
