import { Router } from 'express';
import {
  currentSeason,
  getPlayerGameLog,
  NbaUpstreamBlockedError,
  recentSeasons,
  type PlayerGame,
} from '../nba/client.js';
import {
  getPlayerByIdFromDb,
  getPlayerGameLogFromDb,
  getPlayerGameLogsMultiFromDb,
  isDbConfigured,
} from '../db.js';
import {
  buildLast10Report,
  LAST10_LABELS,
  LAST10_STATS,
  type Last10StatId,
} from '../services/last10.js';
import { computeHitProbability } from '../services/comparisonEngine.js';

export const playerRouter: Router = Router();

const ALLOWED_STATS = new Set<Last10StatId>(LAST10_STATS);

// Pull the player's most recent ~2 seasons so we always have at least 10
// games even early in a new season.
async function fetchRecentGames(playerId: number): Promise<PlayerGame[]> {
  const seasons = recentSeasons(2);
  if (isDbConfigured()) {
    const merged = await getPlayerGameLogsMultiFromDb(playerId, seasons);
    if (merged) return merged;
    const single = await getPlayerGameLogFromDb(playerId, currentSeason());
    if (single) return single;
  }
  return getPlayerGameLog(playerId, currentSeason());
}

// Resolve a single player by id. Used by the frontend when rehydrating a
// matchup from a shared/saved/recent URL where we only have IDs.
playerRouter.get('/:playerId', async (req, res) => {
  const playerId = Number(req.params.playerId);
  if (!playerId) {
    res.status(400).json({ error: 'playerId must be numeric' });
    return;
  }
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Player lookup requires DB' });
    return;
  }
  const player = await getPlayerByIdFromDb(playerId);
  if (!player) {
    res.status(404).json({ error: 'Unknown playerId' });
    return;
  }
  res.json({ player });
});

playerRouter.get('/:playerId/last-10', async (req, res) => {
  const playerId = Number(req.params.playerId);
  if (!playerId) {
    res.status(400).json({ error: 'playerId required' });
    return;
  }
  const rawStat = String(req.query.selectedStat ?? 'points');
  if (!ALLOWED_STATS.has(rawStat as Last10StatId)) {
    res.status(400).json({
      error: 'invalid selectedStat',
      allowed: LAST10_STATS,
    });
    return;
  }
  const selectedStat = rawStat as Last10StatId;

  // Optional ?line=14.5 — returns hit-probability when the selected stat is
  // numeric (double_double has no line — booleans don't compare against a line).
  const lineRaw = req.query.line;
  const line = lineRaw == null ? null : Number(lineRaw);
  if (line != null && !Number.isFinite(line)) {
    res.status(400).json({ error: 'line must be a number' });
    return;
  }

  try {
    const games = await fetchRecentGames(playerId);
    const report = buildLast10Report(games, selectedStat);

    let hitProbability = null;
    if (line != null && report.selectedStat !== 'double_double') {
      hitProbability = computeHitProbability(report.values, line);
    }

    res.json({
      playerId,
      availableStats: LAST10_STATS,
      labels: LAST10_LABELS,
      ...report,
      ...(hitProbability != null ? { hitProbability, line } : {}),
    });
  } catch (err) {
    if (err instanceof NbaUpstreamBlockedError) {
      res.status(504).json({ error: err.message, code: 'upstream_blocked' });
      return;
    }
    console.error('last-10 failed', err);
    res.status(502).json({ error: 'failed to load last 10 games' });
  }
});
