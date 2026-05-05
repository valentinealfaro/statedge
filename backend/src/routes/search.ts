import { Router } from 'express';
import { NbaUpstreamBlockedError, searchPlayers } from '../nba/client.js';

export const searchRouter: Router = Router();

searchRouter.get('/players', async (req, res) => {
  const query = String(req.query.query ?? '');
  if (!query) {
    res.status(400).json({ error: 'query param is required' });
    return;
  }
  try {
    const results = await searchPlayers(query);
    res.json({ results });
  } catch (err) {
    if (err instanceof NbaUpstreamBlockedError) {
      res.status(504).json({ error: err.message, code: 'upstream_blocked' });
      return;
    }
    console.error('player search failed', err);
    res.status(502).json({ error: 'upstream NBA stats request failed' });
  }
});
