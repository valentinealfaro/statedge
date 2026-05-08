// MLB routes mounted at /api/mlb. Phase 0/1 surface area: enough to
// verify the data pipeline (teams + counts + disclaimer) without
// shipping any user-facing pages yet. Projection / slate / compare
// endpoints land in Phase 2+ once the engines exist.

import { Router } from 'express';
import { getPool, isDbConfigured } from '../db.js';
import { MLB_DISCLAIMER } from '../mlb/client.js';
import {
  ensureMlbTables,
  getMlbCounts,
  listMlbTeamsFromDb,
} from '../mlb/db.js';
import {
  computeMlbLast10,
  MlbPlayerNotFoundError,
  MlbStatTypeMismatchError,
} from '../services/mlbLast10Engine.js';
import { projectMlbStat } from '../services/mlbProjectionEngine.js';
import {
  listStatsForPlayerType,
  statMeta,
  type MlbPlayerType,
  type MlbStatKey,
} from '../mlb/stats.js';

export const mlbRouter: Router = Router();

// GET /api/mlb/teams — list all 30 MLB teams from the DB cache.
// Matches the NBA pattern (GET /api/teams returns the static team
// list). Returns the disclaimer alongside so any client showing MLB
// data has the legal text in-payload.
mlbRouter.get('/teams', async (_req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  try {
    const teams = await listMlbTeamsFromDb();
    res.json({ teams, disclaimer: MLB_DISCLAIMER });
  } catch (err) {
    console.error('mlb/teams failed', err);
    res.status(500).json({ error: 'mlb teams fetch failed' });
  }
});

// GET /api/mlb/health — verification endpoint. Reports row counts so
// we can confirm the sync scripts wrote what we expect. Useful both
// for ops and as the v1 acceptance smoke test.
mlbRouter.get('/health', async (_req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  try {
    const counts = await getMlbCounts();
    res.json({
      counts,
      disclaimer: MLB_DISCLAIMER,
      ready: counts.teams >= 30,
    });
  } catch (err) {
    console.error('mlb/health failed', err);
    res.status(500).json({ error: 'mlb health check failed' });
  }
});

// GET /api/mlb/disclaimer — surfaces the required legal text so any
// frontend page can fetch it without needing to bundle the constant.
mlbRouter.get('/disclaimer', (_req, res) => {
  res.json({ disclaimer: MLB_DISCLAIMER });
});

// GET /api/mlb/stats?type=hitter|pitcher — list available stat keys
// for the requested player type. Drives the frontend stat picker so
// users can't accidentally pick a hitter stat for a pitcher (the
// type-restriction rule).
mlbRouter.get('/stats', (req, res) => {
  const type = req.query.type as string | undefined;
  if (type !== 'hitter' && type !== 'pitcher') {
    res.status(400).json({ error: 'type must be "hitter" or "pitcher"' });
    return;
  }
  res.json({ stats: listStatsForPlayerType(type as MlbPlayerType) });
});

// GET /api/mlb/search/players?query=  — fuzzy-ish player search for
// the compare page. Diacritic-insensitive via the unaccent extension
// already enabled at the schema level. Limit caps results to 25 so
// the dropdown stays responsive.
mlbRouter.get('/search/players', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const query = (req.query.query as string | undefined)?.trim() ?? '';
  if (query.length < 2) {
    res.json({ players: [] });
    return;
  }
  try {
    await ensureMlbTables();
    const { rows } = await getPool().query<{
      id: number;
      full_name: string;
      position: string | null;
      bats: string | null;
      throws: string | null;
      is_pitcher: boolean;
      team_id: number | null;
      team_full_name: string | null;
      team_abbreviation: string | null;
    }>(
      `SELECT p.id, p.full_name, p.position, p.bats, p.throws, p.is_pitcher,
              p.team_id, t.full_name AS team_full_name, t.abbreviation AS team_abbreviation
         FROM mlb_players p
         LEFT JOIN mlb_teams t ON t.id = p.team_id
        WHERE p.is_active = TRUE
          AND unaccent(lower(p.full_name)) LIKE unaccent(lower($1))
        ORDER BY p.full_name
        LIMIT 25`,
      [`%${query}%`],
    );
    res.json({
      players: rows.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        position: r.position,
        bats: r.bats,
        throws: r.throws,
        playerType: r.is_pitcher ? 'pitcher' : 'hitter',
        team: r.team_id !== null ? {
          id: r.team_id,
          fullName: r.team_full_name,
          abbreviation: r.team_abbreviation,
        } : null,
      })),
    });
  } catch (err) {
    console.error('mlb/search/players failed', err);
    res.status(500).json({ error: 'mlb search failed' });
  }
});

// GET /api/mlb/player/:playerId/last-10?stat=&line=&direction=
//
// Reads the player's most recent 10 games from the appropriate stats
// table (hitting if the player is a hitter, pitching if a pitcher).
// Enforces the type-restriction rule — requesting a hitter stat on a
// pitcher (or vice versa) returns 400 with a helpful message.
mlbRouter.get('/player/:playerId/last-10', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const playerId = Number(req.params.playerId);
  if (!Number.isFinite(playerId) || playerId <= 0) {
    res.status(400).json({ error: 'playerId must be a positive integer' });
    return;
  }
  const statKey = req.query.stat as string | undefined;
  if (!statKey || !statMeta(statKey)) {
    res.status(400).json({
      error: 'stat is required and must be a known MLB stat key',
    });
    return;
  }
  const lineRaw = req.query.line as string | undefined;
  const directionRaw = req.query.direction as string | undefined;
  const line = lineRaw !== undefined ? Number(lineRaw) : undefined;
  if (line !== undefined && !Number.isFinite(line)) {
    res.status(400).json({ error: 'line must be numeric when provided' });
    return;
  }
  const direction =
    directionRaw === 'OVER' || directionRaw === 'UNDER' ? directionRaw : undefined;
  if ((line !== undefined) !== (direction !== undefined)) {
    res.status(400).json({
      error: 'line and direction must be provided together',
    });
    return;
  }
  try {
    const result = await computeMlbLast10({
      playerId,
      statKey: statKey as MlbStatKey,
      line,
      direction,
    });
    res.json({ ...result, disclaimer: MLB_DISCLAIMER });
  } catch (err) {
    if (err instanceof MlbPlayerNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof MlbStatTypeMismatchError) {
      res.status(400).json({
        error: 'Selected stat is not available for this player type.',
        detail: err.message,
        playerType: err.playerType,
      });
      return;
    }
    console.error('mlb/player/last-10 failed', err);
    res.status(500).json({ error: 'mlb last-10 fetch failed' });
  }
});

// GET /api/mlb/projection?playerId=&stat=&line=&direction=&opponentTeamId=&isHome=
//
// Single-leg projection. Returns the model's projected value, the
// probability the line hits in the requested direction, plus risk /
// trap / edge / EV scores and human-readable reason codes. v0 doesn't
// take park / weather / pitch-arsenal context — those land with later
// phases. Slate-builder eligibility flags surface here so frontend
// can show "qualifies for Safe / Balanced" before Phase 4 ships.
mlbRouter.get('/projection', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const playerId = Number(req.query.playerId);
  if (!Number.isFinite(playerId) || playerId <= 0) {
    res.status(400).json({ error: 'playerId is required' });
    return;
  }
  const statKey = req.query.stat as string | undefined;
  if (!statKey || !statMeta(statKey)) {
    res.status(400).json({ error: 'stat is required and must be a known MLB stat key' });
    return;
  }
  const line = Number(req.query.line);
  if (!Number.isFinite(line)) {
    res.status(400).json({ error: 'line is required and must be numeric' });
    return;
  }
  const direction = req.query.direction as string | undefined;
  if (direction !== 'OVER' && direction !== 'UNDER') {
    res.status(400).json({ error: 'direction must be OVER or UNDER' });
    return;
  }
  const opponentRaw = req.query.opponentTeamId as string | undefined;
  const opponentTeamId = opponentRaw !== undefined ? Number(opponentRaw) : undefined;
  if (opponentTeamId !== undefined && !Number.isFinite(opponentTeamId)) {
    res.status(400).json({ error: 'opponentTeamId must be numeric when provided' });
    return;
  }
  const isHomeRaw = req.query.isHome as string | undefined;
  const isHome =
    isHomeRaw === 'true' ? true : isHomeRaw === 'false' ? false : undefined;

  try {
    const result = await projectMlbStat({
      playerId,
      statKey: statKey as MlbStatKey,
      line,
      direction,
      opponentTeamId,
      isHome,
    });
    res.json({ ...result, disclaimer: MLB_DISCLAIMER });
  } catch (err) {
    if (err instanceof MlbPlayerNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof MlbStatTypeMismatchError) {
      res.status(400).json({
        error: 'Selected stat is not available for this player type.',
        detail: err.message,
        playerType: err.playerType,
      });
      return;
    }
    console.error('mlb/projection failed', err);
    res.status(500).json({ error: 'mlb projection failed' });
  }
});
