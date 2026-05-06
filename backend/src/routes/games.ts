import { Router } from 'express';
import { currentSeason } from '../nba/client.js';
import {
  getBoxscoreFromDb,
  getRecentGamesFromDb,
  isDbConfigured,
} from '../db.js';
import { fetchGameSummary, fetchScoreboard } from '../nba/espn.js';

export const gamesRouter: Router = Router();

// Most recent completed NBA games (paired team scores). Used to populate
// a 'last night around the league' card on the Home page — no live data
// dependency, just the same DB cache that drives the comparison views.
// Today's slate from ESPN's public scoreboard. Returns scheduled games
// (state=pre) before tipoff and live/final scores once they begin.
// Optional ?date=YYYY-MM-DD overrides; default is today by ESPN's clock.
gamesRouter.get('/today', async (req, res) => {
  const date = req.query.date ? String(req.query.date) : undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  try {
    const data = await fetchScoreboard(date);
    res.json(data);
  } catch (err) {
    console.error('today scoreboard failed', err);
    res.status(502).json({ error: 'ESPN scoreboard request failed' });
  }
});

// Full ESPN game summary — boxscore (with starter/bench split), injury
// reports per team, statistical leaders. Used by /espn-game/:eventId.
gamesRouter.get('/espn/:eventId', async (req, res) => {
  const eventId = String(req.params.eventId ?? '');
  if (!eventId) {
    res.status(400).json({ error: 'eventId required' });
    return;
  }
  try {
    const summary = await fetchGameSummary(eventId);
    res.json({ summary });
  } catch (err) {
    console.error('espn summary failed', err);
    res.status(502).json({ error: 'ESPN summary request failed' });
  }
});

// Full boxscore for a single game — both teams + every player's stat line.
gamesRouter.get('/:gameId/boxscore', async (req, res) => {
  const gameId = String(req.params.gameId ?? '');
  if (!gameId) {
    res.status(400).json({ error: 'gameId required' });
    return;
  }
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Boxscore requires DB' });
    return;
  }
  const season = String(req.query.season ?? currentSeason());

  try {
    const boxscore = await getBoxscoreFromDb(season, gameId);
    if (!boxscore) {
      res.status(404).json({ error: 'Game not found in cache' });
      return;
    }
    res.json({ boxscore });
  } catch (err) {
    console.error('boxscore failed', err);
    res.status(500).json({ error: 'failed to compute boxscore' });
  }
});

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
