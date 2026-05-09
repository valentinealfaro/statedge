// MMA routes — Phase 107a foundation.
//
// Just upcoming events for now. Future slices: pull moneyline + method-
// of-victory odds from The Odds API (already supports
// 'mma_mixed_martial_arts'), wire fight-night recap articles into the
// big-game cron, add fighter profile pages mirroring NBA/MLB.

import { Router } from 'express';
import { fetchUfcScoreboard } from '../mma/espn.js';

export const mmaRouter: Router = Router();

mmaRouter.get('/scoreboard', async (req, res) => {
  try {
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const events = await fetchUfcScoreboard({ startDate, endDate });
    res.json({
      events,
      count: events.length,
      // Bucket counts so the frontend can land on the right tab
      // without re-iterating the whole list.
      upcoming: events.filter((e) => e.state === 'pre').length,
      live: events.filter((e) => e.state === 'in').length,
      completed: events.filter((e) => e.state === 'post').length,
    });
  } catch (err) {
    console.error('mma/scoreboard failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

mmaRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', sport: 'mma', league: 'ufc' });
});
