import { Router } from 'express';
import { getPlayerGameLog } from '../nba/client.js';
import { teamById } from '../nba/teams.js';
import { calculatePlayerVsTeam, type PlayerVsTeamReport } from '../services/comparisonEngine.js';

export const compareRouter: Router = Router();

const ALLOWED_RANGES = new Set(['last5', 'last10', 'last20', 'season']);

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

  try {
    const seasonGames = await getPlayerGameLog(playerId);
    const report = calculatePlayerVsTeam(seasonGames, team.abbreviation, { range, playerId, teamId });
    res.json({ team, report });
  } catch (err) {
    console.error('player-vs-team failed', err);
    res.status(502).json({ error: 'upstream NBA stats request failed' });
  }
});
