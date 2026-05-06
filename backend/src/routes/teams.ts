import { Router } from 'express';
import {
  currentSeason,
  getTeamGameLog,
  NbaUpstreamBlockedError,
  type TeamGame,
} from '../nba/client.js';
import { NBA_TEAMS, teamById } from './../nba/teams.js';
import {
  getTeamGameLogFromDb,
  getTeamRosterFromDb,
  isDbConfigured,
} from '../db.js';

export const teamsRouter: Router = Router();

teamsRouter.get('/', (_req, res) => {
  res.json({ teams: NBA_TEAMS });
});

// Active roster for a team, sorted by minutes played this season so
// rotation guys come first. Used by the Slate's Build-mode team-pick
// modal so users can pick a player without typing — and the Compare
// view's quick-pick lists could use it later too.
teamsRouter.get('/:teamId/roster', async (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!teamId) {
    res.status(400).json({ error: 'teamId must be numeric' });
    return;
  }
  const team = teamById(teamId);
  if (!team) {
    res.status(404).json({ error: 'Unknown teamId' });
    return;
  }
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Roster lookup requires DB' });
    return;
  }

  try {
    const players = await getTeamRosterFromDb(currentSeason(), teamId);
    res.json({ team, players });
  } catch (err) {
    console.error('roster failed', err);
    res.status(500).json({ error: 'roster lookup failed' });
  }
});

// Last 10 games for a team across ALL opponents — used to embed a recent-form
// snapshot inside the Team vs Team comparison view (and anywhere else that
// wants raw recent-form data without an opponent filter).
teamsRouter.get('/:teamId/last-10', async (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!teamId) {
    res.status(400).json({ error: 'teamId must be numeric' });
    return;
  }
  const team = teamById(teamId);
  if (!team) {
    res.status(404).json({ error: 'Unknown teamId' });
    return;
  }

  try {
    let games: TeamGame[] | null = null;
    if (isDbConfigured()) {
      games = await getTeamGameLogFromDb(teamId, currentSeason());
    }
    if (!games) games = await getTeamGameLog(teamId, currentSeason());

    const last10 = games.slice(0, 10);
    res.json({
      team,
      gamesAnalyzed: last10.length,
      gameLog: last10,
    });
  } catch (err) {
    if (err instanceof NbaUpstreamBlockedError) {
      res.status(504).json({ error: err.message, code: 'upstream_blocked' });
      return;
    }
    console.error('team last-10 failed', err);
    res.status(502).json({ error: 'upstream NBA stats request failed' });
  }
});
