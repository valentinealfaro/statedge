import { Router } from 'express';
import { NBA_TEAMS } from '../nba/teams.js';

export const teamsRouter: Router = Router();

teamsRouter.get('/', (_req, res) => {
  res.json({ teams: NBA_TEAMS });
});
