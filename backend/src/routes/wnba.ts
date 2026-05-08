// WNBA routes mounted at /api/wnba. Phase 74 surface area: enough to
// power the WNBA standings page + nav entry + future scoreboard rail.
// Compare/slate/calibration land in subsequent phases.

import { Router } from 'express';
import {
  fetchWnbaGameSummary,
  fetchWnbaPlayerGameLog,
  fetchWnbaPlayerSearch,
  fetchWnbaScoreboard,
  fetchWnbaStandings,
  fetchWnbaTeams,
} from '../wnba/espn.js';

export const wnbaRouter: Router = Router();

const WNBA_DISCLAIMER =
  'StatEdge provides sports analytics, projections, probability ' +
  'estimates, and historical trend analysis only. StatEdge does not ' +
  'provide gambling advice, financial advice, or guaranteed outcomes. ' +
  'Users are responsible for how they interpret and use the information.';

// In-memory caches — ESPN data is cheap to refetch but we coalesce
// concurrent users. 5min TTL on teams (rarely change), 5min on
// standings (game-by-game updates), 60s on scoreboard.
type Cache<T> = { fetchedAt: number; data: T };
let teamsCache: Cache<unknown> | null = null;
let standingsCache: Cache<unknown> | null = null;
const scoreboardCache = new Map<string, Cache<unknown>>();
const TEAMS_TTL = 5 * 60_000;
const STANDINGS_TTL = 5 * 60_000;
const SCOREBOARD_TTL = 60_000;

wnbaRouter.get('/teams', async (_req, res) => {
  const now = Date.now();
  if (teamsCache && now - teamsCache.fetchedAt < TEAMS_TTL) {
    res.json(teamsCache.data);
    return;
  }
  try {
    const teams = await fetchWnbaTeams();
    const payload = { teams, disclaimer: WNBA_DISCLAIMER };
    teamsCache = { fetchedAt: now, data: payload };
    res.json(payload);
  } catch (err) {
    console.error('wnba/teams failed', err);
    res.status(502).json({ error: 'wnba teams fetch failed' });
  }
});

wnbaRouter.get('/standings', async (_req, res) => {
  const now = Date.now();
  if (standingsCache && now - standingsCache.fetchedAt < STANDINGS_TTL) {
    res.json(standingsCache.data);
    return;
  }
  try {
    const teams = await fetchWnbaStandings();
    const eastern = teams.filter((t) => t.conference === 'Eastern');
    const western = teams.filter((t) => t.conference === 'Western');
    const payload = {
      eastern,
      western,
      total: teams.length,
      disclaimer: WNBA_DISCLAIMER,
    };
    standingsCache = { fetchedAt: now, data: payload };
    res.json(payload);
  } catch (err) {
    console.error('wnba/standings failed', err);
    res.status(502).json({ error: 'wnba standings fetch failed' });
  }
});

// Per-game summary cache. Identical pattern to NBA's espn-game route
// — 30s TTL while live, frontend handles polling.
const summaryCache = new Map<string, Cache<unknown>>();
const SUMMARY_TTL = 30_000;

wnbaRouter.get('/game/:eventId', async (req, res) => {
  const eventId = String(req.params.eventId);
  if (!eventId) {
    res.status(400).json({ error: 'eventId required' });
    return;
  }
  const now = Date.now();
  const cached = summaryCache.get(eventId);
  if (cached && now - cached.fetchedAt < SUMMARY_TTL) {
    res.json(cached.data);
    return;
  }
  try {
    const summary = await fetchWnbaGameSummary(eventId);
    const payload = { summary, disclaimer: WNBA_DISCLAIMER };
    summaryCache.set(eventId, { fetchedAt: now, data: payload });
    res.json(payload);
  } catch (err) {
    console.error('wnba/game/:eventId failed', err);
    res.status(502).json({ error: 'wnba game summary fetch failed' });
  }
});

// Player search — small, fast, ESPN-proxied. 60s cache per query.
const searchCache = new Map<string, Cache<unknown>>();
const SEARCH_TTL = 60_000;

wnbaRouter.get('/players/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) {
    res.json({ players: [] });
    return;
  }
  const now = Date.now();
  const cached = searchCache.get(q.toLowerCase());
  if (cached && now - cached.fetchedAt < SEARCH_TTL) {
    res.json(cached.data);
    return;
  }
  try {
    const players = await fetchWnbaPlayerSearch(q);
    const payload = { players };
    searchCache.set(q.toLowerCase(), { fetchedAt: now, data: payload });
    res.json(payload);
  } catch (err) {
    console.error('wnba/players/search failed', err);
    res.status(502).json({ error: 'wnba search failed' });
  }
});

// Player gamelog — current season, last N games. 5min cache per
// player; ESPN updates within minutes after a game finishes anyway.
const gamelogCache = new Map<string, Cache<unknown>>();
const GAMELOG_TTL = 5 * 60_000;

wnbaRouter.get('/player/:athleteId/gamelog', async (req, res) => {
  const athleteId = String(req.params.athleteId);
  if (!athleteId) {
    res.status(400).json({ error: 'athleteId required' });
    return;
  }
  const now = Date.now();
  const cached = gamelogCache.get(athleteId);
  if (cached && now - cached.fetchedAt < GAMELOG_TTL) {
    res.json(cached.data);
    return;
  }
  try {
    const games = await fetchWnbaPlayerGameLog(athleteId);
    const payload = { athleteId, games, disclaimer: WNBA_DISCLAIMER };
    gamelogCache.set(athleteId, { fetchedAt: now, data: payload });
    res.json(payload);
  } catch (err) {
    console.error('wnba/player/gamelog failed', err);
    res.status(502).json({ error: 'wnba gamelog failed' });
  }
});

wnbaRouter.get('/today', async (req, res) => {
  const dateRaw = req.query.date as string | undefined;
  const date = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : undefined;
  const cacheKey = date ?? 'today';
  const now = Date.now();
  const cached = scoreboardCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < SCOREBOARD_TTL) {
    res.json(cached.data);
    return;
  }
  try {
    const data = await fetchWnbaScoreboard(date);
    const payload = { ...data, disclaimer: WNBA_DISCLAIMER };
    scoreboardCache.set(cacheKey, { fetchedAt: now, data: payload });
    res.json(payload);
  } catch (err) {
    console.error('wnba/today failed', err);
    res.status(502).json({ error: 'wnba scoreboard fetch failed' });
  }
});
