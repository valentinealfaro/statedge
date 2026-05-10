// Trending players + teams — NBA-only, season-leaderboard-shaped.
// Backs the Home page's TrendingPlayers / TrendingTeams rails so
// fresh visitors have something to click without typing a search.
//
// "Trending" here = top season scorers (active, min-games gated),
// NOT per-user popularity. We don't track user-level engagement;
// the leaderboard is anchored to whoever's putting up the biggest
// numbers in the synced cache.

import { Router } from 'express';
import { currentSeason } from '../nba/client.js';
import {
  getTrendingPlayersFromDb,
  getTrendingTeamsFromDb,
  isDbConfigured,
} from '../db.js';

export const trendingRouter: Router = Router();

// Top N season scorers (active, min-games gated). The Home page uses this
// to populate a "trending players" rail without needing per-user usage
// tracking — popularity here is "who's putting up the biggest numbers".
trendingRouter.get('/players', async (req, res) => {
  if (!isDbConfigured()) {
    res.json({ players: [], season: null, source: 'no-db' });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 8), 1), 20);
  const season = String(req.query.season ?? currentSeason());

  try {
    const players = await getTrendingPlayersFromDb(season, limit);
    res.json({ players, season, source: 'db' });
  } catch (err) {
    console.error('trending players failed', err);
    res.status(500).json({ error: 'failed to compute trending players' });
  }
});

trendingRouter.get('/teams', async (req, res) => {
  if (!isDbConfigured()) {
    res.json({ teams: [], season: null, source: 'no-db' });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 8), 1), 30);
  const season = String(req.query.season ?? currentSeason());

  try {
    const teams = await getTrendingTeamsFromDb(season, limit);
    res.json({ teams, season, source: 'db' });
  } catch (err) {
    console.error('trending teams failed', err);
    res.status(500).json({ error: 'failed to compute trending teams' });
  }
});
