// MLB routes mounted at /api/mlb. Phase 0/1 surface area: enough to
// verify the data pipeline (teams + counts + disclaimer) without
// shipping any user-facing pages yet. Projection / slate / compare
// endpoints land in Phase 2+ once the engines exist.

import { Router } from 'express';
import { getPool, isDbConfigured } from '../db.js';
import {
  getEspnMlbOddsByMatchup,
  getTodaysMlbGames,
  MLB_DISCLAIMER,
  type MlbTodayGame,
  type EspnMlbOdds,
} from '../mlb/client.js';
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
import { resolveMlbSlate, type RawMlbLine } from '../services/mlbSlatePipeline.js';
import { buildMlbSlate, type MlbSlateMode } from '../services/mlbSlateBuilder.js';
import {
  recordMlbSlateProjections,
  type RecordableMlbCombo,
} from '../services/mlbProjectionHistory.js';
import { parseMlbSlateText } from '../services/mlbSlateTextParser.js';
import { gradeMlbProjections } from '../services/mlbGrader.js';
import { computeMlbCalibration } from '../services/mlbCalibration.js';
import { computeMlbStandings } from '../services/mlbStandings.js';
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

// GET /api/mlb/player/:playerId — basic player info for the game-log
// page (header). Returns name, position, team, handedness. 404 when
// the ID isn't in mlb_players.
mlbRouter.get('/player/:playerId', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const playerId = Number(req.params.playerId);
  if (!Number.isFinite(playerId) || playerId <= 0) {
    res.status(400).json({ error: 'playerId must be a positive integer' });
    return;
  }
  try {
    const { rows } = await getPool().query<{
      id: number;
      full_name: string;
      position: string | null;
      bats: string | null;
      throws: string | null;
      is_pitcher: boolean;
      team_id: number | null;
      team_abbr: string | null;
      team_name: string | null;
    }>(
      `SELECT p.id, p.full_name, p.position, p.bats, p.throws, p.is_pitcher,
              p.team_id, t.abbreviation AS team_abbr, t.full_name AS team_name
         FROM mlb_players p
         LEFT JOIN mlb_teams t ON t.id = p.team_id
        WHERE p.id = $1`,
      [playerId],
    );
    const r = rows[0];
    if (!r) {
      res.status(404).json({ error: `Player ${playerId} not found.` });
      return;
    }
    res.json({
      id: r.id,
      fullName: r.full_name,
      position: r.position,
      bats: r.bats,
      throws: r.throws,
      playerType: r.is_pitcher ? 'pitcher' : 'hitter',
      team: r.team_id !== null
        ? { id: r.team_id, fullName: r.team_name, abbreviation: r.team_abbr }
        : null,
      disclaimer: MLB_DISCLAIMER,
    });
  } catch (err) {
    console.error('mlb/player failed', err);
    res.status(500).json({ error: 'mlb player fetch failed' });
  }
});

// GET /api/mlb/player/:playerId/last-10?stat=&line=&direction=&limit=
//
// Reads the player's most recent N games from the appropriate stats
// table (hitting if the player is a hitter, pitching if a pitcher).
// Default N=10; pass limit=200 for the full season log on the
// player game-log page.
//
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
  // Optional limit override — UI's last-10 sticks with default 10;
  // game-log page asks for 200 to get the full season.
  const limitRaw = req.query.limit as string | undefined;
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 500)) {
    res.status(400).json({ error: 'limit must be 1..500 when provided' });
    return;
  }
  try {
    const result = await computeMlbLast10({
      playerId,
      statKey: statKey as MlbStatKey,
      line,
      direction,
      limit,
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
  // Optional game-context inputs. When gamePk is provided the engine
  // pulls venue + weather + lineup from the MLB API; opposingPitcherId
  // unlocks the BvP layer for hitter projections.
  const gamePkRaw = req.query.gamePk as string | undefined;
  const gamePk = gamePkRaw !== undefined ? Number(gamePkRaw) : undefined;
  if (gamePk !== undefined && !Number.isFinite(gamePk)) {
    res.status(400).json({ error: 'gamePk must be numeric when provided' });
    return;
  }
  const opposingPitcherIdRaw = req.query.opposingPitcherId as string | undefined;
  const opposingPitcherId =
    opposingPitcherIdRaw !== undefined ? Number(opposingPitcherIdRaw) : undefined;
  if (opposingPitcherId !== undefined && !Number.isFinite(opposingPitcherId)) {
    res.status(400).json({ error: 'opposingPitcherId must be numeric when provided' });
    return;
  }

  try {
    const result = await projectMlbStat({
      playerId,
      statKey: statKey as MlbStatKey,
      line,
      direction,
      opponentTeamId,
      isHome,
      gamePk,
      opposingPitcherId,
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

// POST /api/mlb/slate
// Body: { lines: RawMlbLine[], mode?: MlbSlateMode }
//
// Single-shot slate construction. Admin pastes tonight's lines as
// JSON, we project + rank + build cards. v1 doesn't persist
// snapshots (the NBA equivalent does — we'll add MLB grading after
// Phase 5). Returns the resolved mode (Auto's underlying choice),
// each card slot's status (combo built or eligibility-gated reason),
// and any unresolved input lines with reasons.
mlbRouter.post('/slate', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const body = req.body as {
    lines?: RawMlbLine[];
    text?: string;
    mode?: MlbSlateMode;
    gameDate?: string;
  } | undefined;
  if (!body || ((!Array.isArray(body.lines) || body.lines.length === 0) && !body.text)) {
    res.status(400).json({
      error: 'POST body must be { lines: RawMlbLine[] | text: pipe-format string, mode?: SlateMode, gameDate?: YYYY-MM-DD }.',
    });
    return;
  }
  // Resolve `text` (pipe format) into lines if provided. Errors here
  // accumulate into the response's `unresolved` field — the slate
  // still builds with whatever parsed cleanly.
  let textParseUnresolved: Array<{ rawLine: string; reason: string }> = [];
  let resolvedLines: RawMlbLine[] = Array.isArray(body.lines) ? body.lines : [];
  if (body.text) {
    try {
      const parsed = await parseMlbSlateText(body.text);
      resolvedLines = [...resolvedLines, ...parsed.lines];
      textParseUnresolved = parsed.unresolved;
    } catch (err) {
      res.status(500).json({
        error: 'mlb slate text parse failed',
        detail: (err as Error).message,
      });
      return;
    }
  }
  if (resolvedLines.length === 0) {
    res.status(400).json({
      error: 'No usable lines after parsing.',
      unresolved: textParseUnresolved,
    });
    return;
  }
  // Hard cap on slate size. Each leg does ~4-5 sequential DB queries
  // (player lookup + projection + last10 + season/opponent averages)
  // which adds up past Vercel's serverless timeout on big pastes.
  // PrizePicks rarely posts more than ~500 MLB lines on a single
  // night — anything well above that is usually duplicates or cross-
  // sport pollution. Surface a clean error rather than time out.
  const MLB_SLATE_MAX_LINES = 500;
  if (resolvedLines.length > MLB_SLATE_MAX_LINES) {
    res.status(413).json({
      error: `Slate too large: ${resolvedLines.length} lines received, max ${MLB_SLATE_MAX_LINES}. Trim to MLB-only and dedupe — PrizePicks rarely posts more than ~500 MLB props in a night.`,
      received: resolvedLines.length,
      maxLines: MLB_SLATE_MAX_LINES,
    });
    return;
  }
  const mode: MlbSlateMode =
    body.mode === 'safe' || body.mode === 'balanced' || body.mode === 'aggressive'
      || body.mode === 'insane' || body.mode === 'auto'
      ? body.mode
      : 'balanced';
  // gameDate is optional. When supplied, the slate is persisted to
  // mlb_projection_history for grading + calibration. Without it,
  // the slate is built but not stored — useful for dev / one-off
  // exploration without polluting the calibration data.
  const gameDate = body.gameDate;
  if (gameDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) {
    res.status(400).json({ error: 'gameDate must be YYYY-MM-DD when provided.' });
    return;
  }
  try {
    const { lines, unresolved } = await resolveMlbSlate(resolvedLines);
    const slate = buildMlbSlate(lines, mode);

    // Persist if gameDate provided. Failure to persist doesn't fail
    // the response — we still return the built slate. Calibration
    // gracefully reports "no data" if writes are missing.
    let recorded: number | null = null;
    if (gameDate) {
      try {
        const recordable: RecordableMlbCombo[] = slate.combos
          .filter((c) => c.combo !== null)
          .map((c) => ({ combo: c.combo!, cardType: c.label }));
        if (recordable.length > 0) {
          const r = await recordMlbSlateProjections({
            combos: recordable,
            gameDate,
          });
          recorded = r.inserted;
        }
      } catch (err) {
        console.warn('mlb/slate persistence failed (slate still served):', (err as Error).message);
      }
    }

    res.json({
      ...slate,
      requestedMode: mode,
      lineCount: lines.length,
      unresolved: [
        // Player-resolution failures (parser couldn't find player) +
        // pipeline failures (bad stat type, sync gap, etc).
        ...textParseUnresolved.map((u) => ({ raw: { playerId: 0, statKey: 'unknown', line: 0 } as unknown, reason: `Parse: ${u.reason} · "${u.rawLine}"` })),
        ...unresolved,
      ],
      gameDate: gameDate ?? null,
      recordedProjections: recorded,
      disclaimer: MLB_DISCLAIMER,
    });
  } catch (err) {
    console.error('mlb/slate failed', err);
    res.status(500).json({ error: 'mlb slate construction failed' });
  }
});

// GET /api/mlb/standings?season=&asOfDate=
//
// Per-team aggregations: W/L, run differential, starter/bullpen ERA,
// park-adjusted run rate, home/away splits, last-10. Mission-aligned
// "institutional, not basic ESPN" — derives everything from data
// we already sync. Empty teams[] when DB is unseeded; UI handles.
mlbRouter.get('/standings', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const season = req.query.season as string | undefined;
  const asOfDate = req.query.asOfDate as string | undefined;
  if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    res.status(400).json({ error: 'asOfDate must be YYYY-MM-DD' });
    return;
  }
  try {
    const result = await computeMlbStandings({ season, asOfDate });
    res.json({ ...result, disclaimer: MLB_DISCLAIMER });
  } catch (err) {
    console.error('mlb/standings failed', err);
    res.status(500).json({ error: 'mlb standings fetch failed' });
  }
});

// GET /api/mlb/calibration?windowDays=30
//
// Returns predicted-vs-actual buckets across the rolling window.
// Lazy-grades any ungraded rows whose game_date is now in the past
// before aggregating, so the report always reflects whatever stats
// have synced. Bayesian-smoothed hit rates ensure thin samples don't
// fake-claim accuracy. Mission alignment: this IS the truth surface.
mlbRouter.get('/calibration', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const windowRaw = req.query.windowDays as string | undefined;
  const windowDays =
    windowRaw !== undefined && Number.isFinite(Number(windowRaw))
      ? Math.max(7, Math.min(365, Math.round(Number(windowRaw))))
      : 30;
  try {
    // Lazy-grade first — if the daily MLB sync ran since we last
    // queried, ripe rows now have stat-table matches. Failure here
    // doesn't block the report (graceful degradation).
    let gradeResult: Awaited<ReturnType<typeof gradeMlbProjections>> | null = null;
    try {
      gradeResult = await gradeMlbProjections({ windowDays });
    } catch (err) {
      console.warn('mlb/calibration lazy grade failed:', (err as Error).message);
    }
    const report = await computeMlbCalibration({ windowDays });
    res.json({
      ...report,
      gradedThisRequest: gradeResult,
      disclaimer: MLB_DISCLAIMER,
    });
  } catch (err) {
    console.error('mlb/calibration failed', err);
    res.status(500).json({ error: 'mlb calibration fetch failed' });
  }
});

// GET /api/mlb/today?date=YYYY-MM-DD
//
// Tonight's MLB games with everything users see on ESPN's front page:
//   - Home/away teams + records + scores + status
//   - Probable starters + their season stats (W-L, ERA, IP, K/BB, WHIP)
//   - Moneyline odds + implied win probability per side
//   - Venue
//
// Two sources stitched together:
//   1. statsapi.mlb.com — schedule + probable pitcher + season stats
//      (rich pitcher data ESPN's page only shows summary of)
//   2. ESPN public scoreboard — moneyline odds (DraftKings via ESPN's
//      free public JSON; same source we already use for NBA games)
//
// Mission framing: ML odds rendered as IMPLIED WIN PROBABILITY, not
// "betting odds." Reflects sportsbook consensus as a context signal
// for game-script analysis, not as a betting recommendation.
mlbRouter.get('/today', async (req, res) => {
  const dateRaw = req.query.date as string | undefined;
  const date = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
    ? dateRaw
    : undefined;     // client falls back to today

  try {
    // Run both fetches in parallel — independent sources, no shared
    // dependencies. ESPN failure is non-fatal (odds become null);
    // MLB Stats API failure returns empty games[].
    const [games, oddsByMatchup] = await Promise.all([
      getTodaysMlbGames(date).catch((err) => {
        console.warn('mlb/today MLB Stats API fetch failed:', (err as Error).message);
        return [] as MlbTodayGame[];
      }),
      getEspnMlbOddsByMatchup(date).catch(() => new Map<string, EspnMlbOdds>()),
    ]);

    // Merge ESPN odds into each game's payload by matching team
    // abbreviations (ESPN doesn't ship gamePk; abbreviation pair is
    // unique per date). Odds field is null when unmatched.
    const enriched = games.map((g) => {
      const key = `${g.home.abbreviation}-${g.away.abbreviation}`;
      const odds = oddsByMatchup.get(key) ?? null;
      return { ...g, odds };
    });

    res.json({
      date: date ?? new Date().toISOString().slice(0, 10),
      games: enriched,
      disclaimer: MLB_DISCLAIMER,
    });
  } catch (err) {
    console.error('mlb/today failed', err);
    res.status(500).json({ error: 'mlb today fetch failed' });
  }
});
