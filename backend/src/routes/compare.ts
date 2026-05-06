import { Router } from 'express';
import {
  currentSeason,
  getPlayerGameLog,
  getTeamGameLog,
  NbaUpstreamBlockedError,
  recentSeasons,
  type PlayerGame,
  type TeamGame,
} from '../nba/client.js';
import { teamById } from '../nba/teams.js';
import {
  getPlayerGameLogFromDb,
  getPlayerGameLogsMultiFromDb,
  getTeamGameLogFromDb,
  getTeamGameLogsMultiFromDb,
  isDbConfigured,
} from '../db.js';
import {
  calculatePlayerVsTeam,
  calculatePlayerVsPlayer,
  calculateTeamVsTeam,
  computeHitProbability,
  type PlayerVsTeamReport,
} from '../services/comparisonEngine.js';
import { calculateComboStats } from '../services/statCombos.js';
import {
  calculateAdvancedStats,
  getStatValue,
  SELECTED_STATS,
  type SelectedStat,
} from '../services/advancedStats.js';

export const compareRouter: Router = Router();

const ALLOWED_RANGES = new Set(['last5', 'last10', 'last20', 'season']);
type Range = 'last5' | 'last10' | 'last20' | 'season';

// Number of seasons to load. seasons=current → 1, seasons=last3 → 3, etc.
type SeasonRange = 'current' | 'last2' | 'last3' | 'last5';

function seasonsFor(range: SeasonRange): string[] {
  switch (range) {
    case 'current': return [currentSeason()];
    case 'last2':   return recentSeasons(2);
    case 'last3':   return recentSeasons(3);
    case 'last5':   return recentSeasons(5);
  }
}

async function fetchPlayerGameLog(
  playerId: number,
  range: SeasonRange,
): Promise<PlayerGame[]> {
  const seasons = seasonsFor(range);
  if (isDbConfigured()) {
    if (seasons.length === 1) {
      const cached = await getPlayerGameLogFromDb(playerId, seasons[0]!);
      if (cached) return cached;
    } else {
      const cached = await getPlayerGameLogsMultiFromDb(playerId, seasons);
      if (cached) return cached;
    }
    // DB configured but nothing cached for this player — fall through.
  }
  // Live fallback: only the first season (multi-season live would blow the timeout).
  return getPlayerGameLog(playerId, seasons[0]!);
}

async function fetchTeamGameLog(
  teamId: number,
  range: SeasonRange,
): Promise<TeamGame[]> {
  const seasons = seasonsFor(range);
  if (isDbConfigured()) {
    if (seasons.length === 1) {
      const cached = await getTeamGameLogFromDb(teamId, seasons[0]!);
      if (cached) return cached;
    } else {
      const cached = await getTeamGameLogsMultiFromDb(teamId, seasons);
      if (cached) return cached;
    }
  }
  return getTeamGameLog(teamId, seasons[0]!);
}

const ALLOWED_SEASON_RANGES = new Set<SeasonRange>(['current', 'last2', 'last3', 'last5']);
function parseSeasonRange(raw: unknown): SeasonRange {
  const v = String(raw ?? 'current') as SeasonRange;
  return ALLOWED_SEASON_RANGES.has(v) ? v : 'current';
}

compareRouter.get('/player-vs-team', async (req, res) => {
  const playerId = Number(req.query.playerId);
  const teamId = Number(req.query.teamId);
  const range = String(req.query.range ?? 'last5') as PlayerVsTeamReport['range'];

  if (!playerId || !teamId) {
    res.status(400).json({ error: 'playerId and teamId are required' });
    return;
  }
  if (!ALLOWED_RANGES.has(range)) {
    res.status(400).json({ error: `range must be one of ${[...ALLOWED_RANGES].join(', ')}` });
    return;
  }

  const team = teamById(teamId);
  if (!team) {
    res.status(404).json({ error: 'Unknown teamId' });
    return;
  }

  const seasonRange = parseSeasonRange(req.query.seasons);

  const rawStat = String(req.query.selectedStat ?? 'PRA');
  const selectedStat: SelectedStat = (SELECTED_STATS as readonly string[]).includes(rawStat)
    ? (rawStat as SelectedStat)
    : 'PRA';

  // Optional hit-probability inputs. `statKey` defaults to whatever the user
  // already picked for the advanced section if present — otherwise points.
  // `line` is the prop line they want a "might hit" reading for. Both must
  // parse for hitProbability to be returned. Computed over the player's last
  // 10 season games (regardless of opponent), which gives a stable signal —
  // vs-team subsets are typically too small (3-4 games) to be reliable.
  const lineRaw = req.query.line;
  const line = lineRaw == null ? null : Number(lineRaw);
  if (line != null && !Number.isFinite(line)) {
    res.status(400).json({ error: 'line must be a number' });
    return;
  }
  const statKeyRaw = req.query.statKey;
  const hitStatKey: SelectedStat | null =
    statKeyRaw && (SELECTED_STATS as readonly string[]).includes(String(statKeyRaw))
      ? (String(statKeyRaw) as SelectedStat)
      : null;

  try {
    const seasonGames = await fetchPlayerGameLog(playerId, seasonRange);
    const report = calculatePlayerVsTeam(seasonGames, team.abbreviation, { range, playerId, teamId });
    const combos = calculateComboStats(report.gamesAgainstTeam);
    const advanced = calculateAdvancedStats(report.gamesAgainstTeam, seasonGames, selectedStat);

    let hitProbability = null;
    if (line != null && hitStatKey) {
      const last10Values = seasonGames.slice(0, 10).map(getStatValue(hitStatKey));
      hitProbability = computeHitProbability(last10Values, line);
    }

    res.json({
      team,
      seasons: seasonsFor(seasonRange),
      seasonRange,
      gamesAnalyzed: report.gamesAgainstTeam.length,
      combos,
      advanced,
      report,
      ...(hitProbability ? { hitProbability, line, statKey: hitStatKey } : {}),
    });
  } catch (err) {
    if (err instanceof NbaUpstreamBlockedError) {
      res.status(504).json({ error: err.message, code: 'upstream_blocked' });
      return;
    }
    console.error('player-vs-team failed', err);
    res.status(502).json({ error: 'upstream NBA stats request failed' });
  }
});

compareRouter.get('/player-vs-player', async (req, res) => {
  const aId = Number(req.query.aId);
  const bId = Number(req.query.bId);
  const range = String(req.query.range ?? 'last5') as Range;

  if (!aId || !bId) {
    res.status(400).json({ error: 'aId and bId are required' });
    return;
  }
  if (!ALLOWED_RANGES.has(range)) {
    res.status(400).json({ error: 'invalid range' });
    return;
  }

  const seasonRange = parseSeasonRange(req.query.seasons);

  try {
    const [aGames, bGames] = await Promise.all([
      fetchPlayerGameLog(aId, seasonRange),
      fetchPlayerGameLog(bId, seasonRange),
    ]);
    const report = calculatePlayerVsPlayer(aGames, bGames, range);
    res.json({ aId, bId, seasons: seasonsFor(seasonRange), seasonRange, report });
  } catch (err) {
    if (err instanceof NbaUpstreamBlockedError) {
      res.status(504).json({ error: err.message, code: 'upstream_blocked' });
      return;
    }
    console.error('player-vs-player failed', err);
    res.status(502).json({ error: 'upstream NBA stats request failed' });
  }
});

compareRouter.get('/team-vs-team', async (req, res) => {
  const aId = Number(req.query.aId);
  const bId = Number(req.query.bId);
  const range = String(req.query.range ?? 'last5') as Range;

  if (!aId || !bId) {
    res.status(400).json({ error: 'aId and bId are required' });
    return;
  }
  if (!ALLOWED_RANGES.has(range)) {
    res.status(400).json({ error: 'invalid range' });
    return;
  }

  const aTeam = teamById(aId);
  const bTeam = teamById(bId);
  if (!aTeam || !bTeam) {
    res.status(404).json({ error: 'Unknown team' });
    return;
  }

  const seasonRange = parseSeasonRange(req.query.seasons);

  try {
    const [aGames, bGames] = await Promise.all([
      fetchTeamGameLog(aId, seasonRange),
      fetchTeamGameLog(bId, seasonRange),
    ]);
    const report = calculateTeamVsTeam(aGames, bGames, range);
    res.json({ a: aTeam, b: bTeam, seasons: seasonsFor(seasonRange), seasonRange, report });
  } catch (err) {
    if (err instanceof NbaUpstreamBlockedError) {
      res.status(504).json({ error: err.message, code: 'upstream_blocked' });
      return;
    }
    console.error('team-vs-team failed', err);
    res.status(502).json({ error: 'upstream NBA stats request failed' });
  }
});
