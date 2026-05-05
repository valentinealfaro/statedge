import { Router } from 'express';
import { NbaUpstreamBlockedError, searchPlayers } from '../nba/client.js';
import { isDbConfigured, searchPlayersFromDb } from '../db.js';

export const searchRouter: Router = Router();

searchRouter.get('/players', async (req, res) => {
  const query = String(req.query.query ?? '');
  if (!query) {
    res.status(400).json({ error: 'query param is required' });
    return;
  }
  try {
    // Prefer DB cache (works in any environment). Fall back to live NBA API if not configured.
    const results = isDbConfigured()
      ? await searchPlayersFromDb(query)
      : await searchPlayers(query);
    res.json({ results, source: isDbConfigured() ? 'db' : 'live' });
  } catch (err) {
    if (err instanceof NbaUpstreamBlockedError) {
      res.status(504).json({ error: err.message, code: 'upstream_blocked' });
      return;
    }
    console.error('player search failed', err);
    res.status(502).json({ error: 'upstream NBA stats request failed' });
  }
});
