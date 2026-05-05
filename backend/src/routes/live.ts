import { Router } from 'express';
import { getScoreboardForDate, isConfigured, todayDateUtc } from '../nba/balldontlie.js';

export const liveRouter: Router = Router();

liveRouter.get('/scoreboard', async (req, res) => {
  if (!isConfigured()) {
    res.status(503).json({
      error: 'Live scoreboard unavailable: set BALLDONTLIE_API_KEY in env to enable.',
    });
    return;
  }
  const date = String(req.query.date ?? todayDateUtc());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  try {
    const games = await getScoreboardForDate(date);
    res.json({ date, games });
  } catch (err) {
    console.error('scoreboard failed', err);
    res.status(502).json({ error: 'balldontlie request failed' });
  }
});
