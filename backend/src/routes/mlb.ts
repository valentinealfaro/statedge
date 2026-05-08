// MLB routes mounted at /api/mlb. Phase 0/1 surface area: enough to
// verify the data pipeline (teams + counts + disclaimer) without
// shipping any user-facing pages yet. Projection / slate / compare
// endpoints land in Phase 2+ once the engines exist.

import { Router } from 'express';
import {
  clearMlbDailySlateFromDb,
  getMlbDailySlateFromDb,
  getMlbSlateCache,
  getPool,
  isDbConfigured,
  purgeMlbSlateCacheDb,
  setMlbDailySlateInDb,
  setMlbSlateCache,
  type MlbStoredDailyLine,
} from '../db.js';
import {
  getBoxscore,
  getEspnMlbOddsByMatchup,
  getLiveGameFeed,
  getTeamInjuredList,
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
  listMlbProjections,
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

// Cross-instance cache for the resolved /slate/today response. Backed
// by Postgres (mlb_slate_cache table) because Vercel's serverless
// model spawns multiple instances; an in-memory Map only helps the
// instance that did the projection. With Postgres-backed cache, the
// FIRST visitor across the whole pool pays the 25s projection cost
// and every other instance hits the cache until TTL.
//
// Keyed by `${date}::${mode}::${updatedAt}` so a same-day publish
// with a different mode doesn't collide and a re-publish auto-
// invalidates (the new entry has a new key; old entries fall away
// at TTL or on explicit purge).
const SLATE_CACHE_TTL_MS = 5 * 60 * 1000;

async function purgeMlbSlateCache(): Promise<void> {
  await purgeMlbSlateCacheDb().catch(() => { /* best-effort */ });
  // History-snapshot tracking is per-instance memory only; we still
  // clear it so the local instance's tracking matches the DB state.
  slateHistorySnapshotted.clear();
}

// GET /api/mlb/slate/today
//
// Returns today's admin-published slate (as raw lines + the built
// card combos). Public endpoint — anyone visiting /mlb/slate sees
// whatever the admin most-recently posted for today's ET date. If
// no slate has been published, returns { slate: null, resolved: null }.
//
// "Today" is the US Eastern calendar date; matches the NBA flow so
// MLB's daily-slate semantics are consistent.
mlbRouter.get('/slate/today', async (req, res) => {
  if (!isDbConfigured()) {
    res.json({ slate: null, resolved: null });
    return;
  }
  try {
    const stored = await getMlbDailySlateFromDb();
    if (!stored || stored.lines.length === 0) {
      res.json({ slate: null, resolved: null });
      return;
    }
    const mode: MlbSlateMode =
      stored.mode === 'safe' || stored.mode === 'balanced' ||
      stored.mode === 'aggressive' || stored.mode === 'insane' ||
      stored.mode === 'auto'
        ? stored.mode
        : 'balanced';
    const requestedMode = (req.query.mode as MlbSlateMode | undefined) ?? mode;

    // Cache lookup (cross-instance via Postgres). Key includes the
    // stored updatedAt so a republish auto-invalidates.
    const cacheKey = `${stored.date}::${requestedMode}::${stored.updatedAt}`;
    const cached = await getMlbSlateCache(cacheKey).catch(() => null);
    if (cached !== null) {
      res.setHeader('X-Slate-Cache', 'HIT');
      res.json(cached);
      return;
    }
    res.setHeader('X-Slate-Cache', 'MISS');

    const { lines: resolvedLines, unresolved } = await resolveMlbSlate(
      stored.lines.map((l) => ({
        playerId: l.playerId,
        statKey: l.statKey as MlbStatKey,
        line: l.line,
        direction: l.direction,
        gamePk: l.gamePk,
        opponentTeamId: l.opponentTeamId,
        isHome: l.isHome,
        opposingPitcherId: l.opposingPitcherId,
      })),
    );
    const slate = buildMlbSlate(resolvedLines, requestedMode);
    const payload = {
      slate: {
        date: stored.date,
        count: stored.lines.length,
        rawText: stored.rawText,
        mode: stored.mode,
        updatedAt: stored.updatedAt,
      },
      resolved: {
        ...slate,
        unresolved,
        lineCount: resolvedLines.length,
        requestedMode,
        disclaimer: MLB_DISCLAIMER,
      },
    };
    // Persist to the cross-instance Postgres cache. Best-effort —
    // a write failure shouldn't fail the response (next GET will
    // just re-project).
    await setMlbSlateCache(cacheKey, payload, SLATE_CACHE_TTL_MS).catch(() => {
      /* best-effort cache write */
    });

    // Snapshot to mlb_projection_history for L9 calibration. We do
    // this on cache MISS only — first visitor of the day pays the
    // write cost, subsequent visits hit the cache and skip. Idempotent
    // via the table's primary key (slate_date + player_id + stat
    // + line) so re-publishes safely overwrite. Best-effort: a
    // history-write failure must not break the slate response.
    if (!slateHistorySnapshotted.has(cacheKey)) {
      try {
        const recordable: RecordableMlbCombo[] = slate.combos
          .filter((c) => c.combo !== null)
          .map((c) => ({ combo: c.combo!, cardType: c.label }));
        if (recordable.length > 0) {
          await recordMlbSlateProjections({
            combos: recordable,
            gameDate: stored.date,
          });
          slateHistorySnapshotted.add(cacheKey);
        }
      } catch (snapErr) {
        console.warn('mlb/slate/today history snapshot failed:', (snapErr as Error).message);
      }
    }

    res.json(payload);
  } catch (err) {
    console.error('mlb/slate/today GET failed', err);
    res.status(500).json({ error: 'mlb slate today fetch failed' });
  }
});

// Tracks which cache-keys have already had their history rows
// written today. Cleared on every POST/DELETE alongside the cache
// itself so a re-publish triggers a fresh snapshot.
const slateHistorySnapshotted = new Set<string>();

// POST /api/mlb/slate/today
// Body: { text?: string, lines?: RawMlbLine[], mode?: MlbSlateMode }
//
// Admin endpoint — replaces today's slate wholesale. Requires
// SLATE_ADMIN_SECRET env var to be set; client must send the
// `x-admin-secret` header. Same auth pattern as /api/slate/today
// for NBA.
//
// Persists the parsed RawMlbLine[] AND the original raw text (so the
// admin can edit the next day's slate against what they posted),
// AND the chosen mode.
mlbRouter.post('/slate/today', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const secret = process.env.SLATE_ADMIN_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'SLATE_ADMIN_SECRET not configured on server' });
    return;
  }
  const provided = req.header('x-admin-secret');
  if (provided !== secret) {
    res.status(401).json({ error: 'admin secret mismatch' });
    return;
  }
  const body = req.body as {
    lines?: RawMlbLine[];
    text?: string;
    mode?: MlbSlateMode;
  } | undefined;
  if (!body || ((!Array.isArray(body.lines) || body.lines.length === 0) && !body.text)) {
    res.status(400).json({
      error: 'Body must include `lines` (RawMlbLine[]) or `text` (pipe-format string).',
    });
    return;
  }
  // Resolve text → lines if provided. Same parser the /slate POST uses.
  let parsedLines: RawMlbLine[] = Array.isArray(body.lines) ? body.lines : [];
  let parseUnresolved: Array<{ rawLine: string; reason: string }> = [];
  if (body.text) {
    try {
      const parsed = await parseMlbSlateText(body.text);
      parsedLines = [...parsedLines, ...parsed.lines];
      parseUnresolved = parsed.unresolved;
    } catch (err) {
      res.status(500).json({
        error: 'mlb slate text parse failed',
        detail: (err as Error).message,
      });
      return;
    }
  }
  if (parsedLines.length === 0) {
    res.status(400).json({
      error: 'No usable lines after parsing.',
      unresolved: parseUnresolved,
    });
    return;
  }
  // Cap matches the build endpoint. 4000 covers PrizePicks's full MLB
  // slate (~3000-3500 real MLB props on a 15-game night, counting
  // every stat type × Demon/Goblin variant per player). POST is fast
  // — just resolves player IDs and persists raw lines; projection
  // happens lazily on GET, so this cap doesn't impact serverless
  // timeout.
  if (parsedLines.length > 4000) {
    res.status(413).json({
      error: `Slate too large: ${parsedLines.length} lines, max 4000.`,
      received: parsedLines.length,
      maxLines: 4000,
    });
    return;
  }
  const stored: MlbStoredDailyLine[] = parsedLines.map((l) => ({
    playerId: l.playerId,
    statKey: l.statKey,
    line: l.line,
    direction: l.direction,
    gamePk: l.gamePk,
    opponentTeamId: l.opponentTeamId,
    isHome: l.isHome,
    opposingPitcherId: l.opposingPitcherId,
  }));
  try {
    const out = await setMlbDailySlateInDb({
      lines: stored,
      rawText: body.text ?? null,
      mode: body.mode ?? 'balanced',
    });
    // Wipe the cache so the newly-published slate resolves fresh.
    await purgeMlbSlateCache();

    // Pre-warm: synchronously resolve the slate + write the cache + record
    // history. Admin's POST takes ~30-45s for a 3000-leg slate, but every
    // public visitor afterwards gets an instant cache HIT — no 25s wait
    // for the first viewer of the day. Best-effort: a pre-warm failure
    // shouldn't fail the publish (raw lines are saved; the next GET will
    // resolve normally).
    const mode: MlbSlateMode = body.mode ?? 'balanced';
    try {
      const refreshed = await getMlbDailySlateFromDb();
      if (refreshed) {
        const { lines: resolvedLines, unresolved: prewarmUnresolved } =
          await resolveMlbSlate(
            refreshed.lines.map((l) => ({
              playerId: l.playerId,
              statKey: l.statKey as MlbStatKey,
              line: l.line,
              direction: l.direction,
              gamePk: l.gamePk,
              opponentTeamId: l.opponentTeamId,
              isHome: l.isHome,
              opposingPitcherId: l.opposingPitcherId,
            })),
          );
        const slate = buildMlbSlate(resolvedLines, mode);
        const payload = {
          slate: {
            date: refreshed.date,
            count: refreshed.lines.length,
            rawText: refreshed.rawText,
            mode: refreshed.mode,
            updatedAt: refreshed.updatedAt,
          },
          resolved: {
            ...slate,
            unresolved: prewarmUnresolved,
            lineCount: resolvedLines.length,
            requestedMode: mode,
            disclaimer: MLB_DISCLAIMER,
          },
        };
        const cacheKey = `${refreshed.date}::${mode}::${refreshed.updatedAt}`;
        await setMlbSlateCache(cacheKey, payload, 5 * 60 * 1000).catch(() => {});
        // Snapshot history at publish time too — admin sees the
        // calibration counter increment immediately.
        try {
          const recordable: RecordableMlbCombo[] = slate.combos
            .filter((c) => c.combo !== null)
            .map((c) => ({ combo: c.combo!, cardType: c.label }));
          if (recordable.length > 0) {
            await recordMlbSlateProjections({
              combos: recordable,
              gameDate: refreshed.date,
            });
          }
        } catch (snapErr) {
          console.warn('mlb/slate/today prewarm history failed:', (snapErr as Error).message);
        }
      }
    } catch (prewarmErr) {
      console.warn('mlb/slate/today prewarm failed (slate still saved):', (prewarmErr as Error).message);
    }
    res.json({ ok: true, ...out, unresolved: parseUnresolved });
  } catch (err) {
    console.error('mlb/slate/today POST failed', err);
    res.status(500).json({ error: 'mlb slate today write failed' });
  }
});

// GET /api/mlb/slate/history?windowDays=30
//
// Past published slates with hit-rate aggregates per day. Reads
// from mlb_projection_history (populated automatically on every GET
// /slate/today cache miss). Grouped by game_date so the UI can
// render a date-by-date track record.
//
// Public endpoint — accountability is the whole point.
mlbRouter.get('/slate/history', async (req, res) => {
  if (!isDbConfigured()) {
    res.json({ days: [] });
    return;
  }
  const windowDays = Math.max(1, Math.min(365, Number(req.query.windowDays ?? 30)));
  try {
    const all = await listMlbProjections({ windowDays, graded: 'all' });

    type CardBucket = {
      cardType: string;
      legs: number;
      hits: number;
      misses: number;
      pending: number;
      // A card is "cleared" only if every leg hit (any miss = parlay dead).
      cleared: boolean | null;   // null while pending
    };

    type DayBucket = {
      date: string;
      totalLegs: number;
      gradedLegs: number;
      hits: number;
      misses: number;
      pending: number;
      byCardType: Record<string, CardBucket>;
    };

    const byDate = new Map<string, DayBucket>();

    for (const r of all) {
      const date = r.gameDate;
      let bucket = byDate.get(date);
      if (!bucket) {
        bucket = { date, totalLegs: 0, gradedLegs: 0, hits: 0, misses: 0, pending: 0, byCardType: {} };
        byDate.set(date, bucket);
      }
      bucket.totalLegs += 1;
      if (r.hitOrMiss === true) { bucket.hits += 1; bucket.gradedLegs += 1; }
      else if (r.hitOrMiss === false) { bucket.misses += 1; bucket.gradedLegs += 1; }
      else { bucket.pending += 1; }

      // Per-card-type breakdown. Same leg can appear in multiple
      // cards (Best 4 ⊃ Best 3 ⊃ Best 2) — that duplication is
      // intentional in the history table because each card has its
      // own pass/fail outcome.
      const ct = r.cardType ?? 'Other';
      let card = bucket.byCardType[ct];
      if (!card) {
        card = { cardType: ct, legs: 0, hits: 0, misses: 0, pending: 0, cleared: null };
        bucket.byCardType[ct] = card;
      }
      card.legs += 1;
      if (r.hitOrMiss === true) card.hits += 1;
      else if (r.hitOrMiss === false) card.misses += 1;
      else card.pending += 1;
    }

    // Resolve "cleared" per card after counting: cleared = all legs
    // graded AND zero misses. While any leg is pending, cleared = null.
    for (const day of byDate.values()) {
      for (const card of Object.values(day.byCardType)) {
        if (card.pending > 0) card.cleared = null;
        else card.cleared = card.misses === 0;
      }
    }

    const days = [...byDate.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((d) => ({
        ...d,
        hitRate: d.gradedLegs > 0 ? Math.round((d.hits / d.gradedLegs) * 1000) / 10 : null,
      }));

    // Per-stat-type+direction rollup across the window. Tells the user
    // WHERE the model is edge-positive vs edge-negative — "hits OVER
    // is +12% vs market, but home_runs UNDER is -8%."
    const byStatTypeMap = new Map<string, {
      stat: string;
      direction: 'OVER' | 'UNDER';
      legs: number;
      hits: number;
      misses: number;
      pending: number;
    }>();
    for (const r of all) {
      const key = `${r.selectedStat}::${r.direction}`;
      let bucket = byStatTypeMap.get(key);
      if (!bucket) {
        bucket = {
          stat: r.selectedStat,
          direction: r.direction,
          legs: 0, hits: 0, misses: 0, pending: 0,
        };
        byStatTypeMap.set(key, bucket);
      }
      bucket.legs += 1;
      if (r.hitOrMiss === true) bucket.hits += 1;
      else if (r.hitOrMiss === false) bucket.misses += 1;
      else bucket.pending += 1;
    }
    const byStatType = [...byStatTypeMap.values()]
      .map((b) => {
        const settled = b.hits + b.misses;
        return {
          ...b,
          hitRate: settled > 0 ? Math.round((b.hits / settled) * 1000) / 10 : null,
        };
      })
      // Surface the strongest signal first (highest hit rate among ≥5
      // legs) — but de-emphasize buckets with thin samples.
      .sort((a, b) => {
        const aSettled = a.hits + a.misses;
        const bSettled = b.hits + b.misses;
        if (aSettled < 5 && bSettled >= 5) return 1;
        if (bSettled < 5 && aSettled >= 5) return -1;
        return (b.hitRate ?? 0) - (a.hitRate ?? 0);
      });

    res.json({ windowDays, days, byStatType, disclaimer: MLB_DISCLAIMER });
  } catch (err) {
    console.error('mlb/slate/history failed', err);
    res.status(500).json({ error: 'mlb slate history failed' });
  }
});

// POST /api/mlb/slate/today/rebuild — admin only. Re-runs the
// builder against the stored raw lines without requiring a full
// re-publish. Useful when new card-construction logic deploys
// (Phases 28-33 etc.) and the admin wants to apply it to today's
// already-published slate without re-pasting 3000 lines.
//
// Purges the cache, then pre-warms with current code. ~30-45s.
mlbRouter.post('/slate/today/rebuild', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const secret = process.env.SLATE_ADMIN_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'SLATE_ADMIN_SECRET not configured on server' });
    return;
  }
  const provided = req.header('x-admin-secret');
  if (provided !== secret) {
    res.status(401).json({ error: 'admin secret mismatch' });
    return;
  }
  try {
    const stored = await getMlbDailySlateFromDb();
    if (!stored || stored.lines.length === 0) {
      res.status(404).json({ error: 'No slate to rebuild — publish first.' });
      return;
    }
    await purgeMlbSlateCache();
    // Re-bump updatedAt so the cache key changes (forces fresh
    // computation everywhere even if the old cache key's TTL hadn't
    // expired). Same pattern POST uses.
    await setMlbDailySlateInDb({
      lines: stored.lines,
      rawText: stored.rawText,
      mode: stored.mode,
    });
    // Pre-warm with current code.
    const refreshed = await getMlbDailySlateFromDb();
    if (refreshed) {
      const mode: MlbSlateMode =
        refreshed.mode === 'safe' || refreshed.mode === 'balanced'
          || refreshed.mode === 'aggressive' || refreshed.mode === 'insane'
          || refreshed.mode === 'auto'
          ? refreshed.mode : 'balanced';
      const { lines: resolvedLines, unresolved: prewarmUnresolved } =
        await resolveMlbSlate(
          refreshed.lines.map((l) => ({
            playerId: l.playerId,
            statKey: l.statKey as MlbStatKey,
            line: l.line,
            direction: l.direction,
            gamePk: l.gamePk,
            opponentTeamId: l.opponentTeamId,
            isHome: l.isHome,
            opposingPitcherId: l.opposingPitcherId,
          })),
        );
      const slate = buildMlbSlate(resolvedLines, mode);
      const payload = {
        slate: {
          date: refreshed.date,
          count: refreshed.lines.length,
          rawText: refreshed.rawText,
          mode: refreshed.mode,
          updatedAt: refreshed.updatedAt,
        },
        resolved: {
          ...slate,
          unresolved: prewarmUnresolved,
          lineCount: resolvedLines.length,
          requestedMode: mode,
          disclaimer: MLB_DISCLAIMER,
        },
      };
      const cacheKey = `${refreshed.date}::${mode}::${refreshed.updatedAt}`;
      await setMlbSlateCache(cacheKey, payload, 5 * 60 * 1000).catch(() => {});
    }
    res.json({
      ok: true,
      message: `Rebuilt today's slate with current engine code. Cache primed.`,
      date: stored.date,
      count: stored.lines.length,
    });
  } catch (err) {
    console.error('mlb/slate/today/rebuild failed', err);
    res.status(500).json({ error: 'mlb slate rebuild failed' });
  }
});

// DELETE /api/mlb/slate/today — admin only. Wipes today's slate so
// the public page renders empty until the next POST.
mlbRouter.delete('/slate/today', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const secret = process.env.SLATE_ADMIN_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'SLATE_ADMIN_SECRET not configured on server' });
    return;
  }
  const provided = req.header('x-admin-secret');
  if (provided !== secret) {
    res.status(401).json({ error: 'admin secret mismatch' });
    return;
  }
  try {
    await clearMlbDailySlateFromDb();
    await purgeMlbSlateCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('mlb/slate/today DELETE failed', err);
    res.status(500).json({ error: 'mlb slate today clear failed' });
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
  // Hard cap on slate size. resolveMlbSlate now runs projections in
  // parallel batches (~30 concurrent), so 3000-leg slates fit within
  // Vercel Pro's serverless timeout. 4000 is the absolute ceiling —
  // covers the largest realistic PrizePicks MLB board.
  const MLB_SLATE_MAX_LINES = 4000;
  if (resolvedLines.length > MLB_SLATE_MAX_LINES) {
    res.status(413).json({
      error: `Slate too large: ${resolvedLines.length} lines received, max ${MLB_SLATE_MAX_LINES}.`,
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

// GET /api/mlb/team/:teamId/last-5
//
// The five most-recent games for a team, with W/L results. Powers
// the "Last 5" strip on the game-detail page (mirrors ESPN).
mlbRouter.get('/team/:teamId/last-5', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const teamId = Number(req.params.teamId);
  if (!Number.isFinite(teamId) || teamId <= 0) {
    res.status(400).json({ error: 'teamId must be a positive integer' });
    return;
  }
  try {
    const { rows } = await getPool().query<{
      id: number;
      game_date: Date;
      home_team_id: number | null;
      away_team_id: number | null;
      home_score: number | null;
      away_score: number | null;
      home_abbr: string | null;
      away_abbr: string | null;
    }>(
      `SELECT g.id, g.game_date, g.home_team_id, g.away_team_id,
              g.home_score, g.away_score,
              ht.abbreviation AS home_abbr, at.abbreviation AS away_abbr
         FROM mlb_games g
         LEFT JOIN mlb_teams ht ON ht.id = g.home_team_id
         LEFT JOIN mlb_teams at ON at.id = g.away_team_id
        WHERE (g.home_team_id = $1 OR g.away_team_id = $1)
          AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        ORDER BY g.game_date DESC
        LIMIT 5`,
      [teamId],
    );
    const games = rows.map((r) => {
      const isHome = r.home_team_id === teamId;
      const opp = isHome ? r.away_abbr : r.home_abbr;
      const myScore = isHome ? r.home_score : r.away_score;
      const oppScore = isHome ? r.away_score : r.home_score;
      const result = (myScore ?? 0) > (oppScore ?? 0) ? 'W' : (myScore ?? 0) < (oppScore ?? 0) ? 'L' : 'T';
      const date = r.game_date;
      return {
        gameId: r.id,
        date: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`,
        opponent: opp,
        isHome,
        result,
        score: `${myScore ?? '—'}-${oppScore ?? '—'}`,
      };
    });
    res.json({ teamId, games });
  } catch (err) {
    console.error('mlb/team/last-5 failed', err);
    res.status(500).json({ error: 'mlb team last-5 failed' });
  }
});

// GET /api/mlb/game/:gamePk/sgp
//
// Top edge legs for THIS matchup, drawn from today's full slate
// (not just the legs that made it onto the Best 2-6 cards). Phase
// 58's diversification engine intentionally rotates players across
// cards, so any single matchup typically contributes 0-2 legs to
// the union of cards. The Same-Game Parlay UI needs a deeper pool
// than that: this endpoint resolves every line from the matchup
// regardless of card placement, sorts by edge%, and returns the top
// 10. Lets users build a coherent SGP even when the slate engine
// doesn't pick the matchup's headline edges for its institutional
// portfolio.
mlbRouter.get('/game/:gamePk/sgp', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const gamePk = Number(req.params.gamePk);
  if (!Number.isFinite(gamePk) || gamePk <= 0) {
    res.status(400).json({ error: 'gamePk must be a positive integer' });
    return;
  }
  try {
    const stored = await getMlbDailySlateFromDb();
    if (!stored || stored.lines.length === 0) {
      res.json({ legs: [], reason: 'No published slate today.' });
      return;
    }
    // Stored lines don't always carry gamePk (the admin's pipe-format
    // paste doesn't include it). Filter by player team membership
    // instead: find the game's home + away team ids, then pull every
    // stored line whose player belongs to either team.
    const todaysGames = await getTodaysMlbGames().catch(() => []);
    const matchup = todaysGames.find((g) => g.gamePk === gamePk);
    if (!matchup) {
      res.json({ legs: [], reason: 'Game not on today\'s schedule.' });
      return;
    }
    const teamIds = [matchup.away.id, matchup.home.id];
    const { rows: playerRows } = await getPool().query<{ id: number }>(
      `SELECT id FROM mlb_players WHERE team_id = ANY($1::int[])`,
      [teamIds],
    );
    const matchupPlayerIds = new Set(playerRows.map((r) => r.id));
    const matchupLines = stored.lines.filter((l) => matchupPlayerIds.has(l.playerId));
    if (matchupLines.length === 0) {
      res.json({
        legs: [],
        reason: `No lines in today's slate for ${matchup.away.abbreviation} or ${matchup.home.abbreviation} players.`,
      });
      return;
    }

    const { lines: resolvedLines } = await resolveMlbSlate(
      matchupLines.map((l) => ({
        playerId: l.playerId,
        statKey: l.statKey as MlbStatKey,
        line: l.line,
        direction: l.direction,
        gamePk: l.gamePk,
        opponentTeamId: l.opponentTeamId,
        isHome: l.isHome,
        opposingPitcherId: l.opposingPitcherId,
      })),
    );

    // Sort by edge% descending, take top 10. Apply the same player-
    // dedup that ComboCard uses (only one stat per player) so the
    // SGP feels like a balanced parlay, not five Aaron Judge props.
    const seenPlayer = new Set<number>();
    const top: typeof resolvedLines = [];
    const sorted = [...resolvedLines].sort(
      (a, b) => b.projection.edgePercent - a.projection.edgePercent,
    );
    for (const l of sorted) {
      if (seenPlayer.has(l.playerId)) continue;
      seenPlayer.add(l.playerId);
      top.push(l);
      if (top.length >= 10) break;
    }

    res.json({
      gamePk,
      legs: top.map((l) => ({
        playerId: l.playerId,
        playerName: l.playerName,
        team: l.team.abbr,
        statKey: l.statKey,
        statLabel: l.statLabel,
        line: l.line,
        direction: l.modelDirection,
        probability: l.projection.probability,
        projection: l.projection.projection,
        edgePercent: l.projection.edgePercent,
        trapScore: l.projection.trapScore,
        fragilityScore: l.projection.fragilityScore,
      })),
      disclaimer: MLB_DISCLAIMER,
    });
  } catch (err) {
    console.error('mlb/game/sgp failed', err);
    res.status(500).json({ error: 'mlb game sgp failed' });
  }
});

// GET /api/mlb/game/:gamePk/preview
//
// Phase B of the game-detail page. Returns:
//   - lineups: posted batting orders (empty until ~2h before first
//     pitch, when MLB posts official lineups)
//   - injuries: players on each team's IL with status descriptions
//   - leaders: top 3 hitters by AVG (min 80 PA), top 3 by HR, and
//     top 3 starters by ERA (min 30 IP) — computed from our local
//     mlb_hitting_stats / mlb_pitching_stats tables for both teams
//
// All three pieces are independent — partial data still renders.
mlbRouter.get('/game/:gamePk/preview', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'MLB requires DB' });
    return;
  }
  const gamePk = Number(req.params.gamePk);
  if (!Number.isFinite(gamePk) || gamePk <= 0) {
    res.status(400).json({ error: 'gamePk must be a positive integer' });
    return;
  }

  try {
    // 1) Boxscore (lineups). Failure here means lineups are TBD — we
    //    return empty arrays so the UI can show "Lineup TBD."
    const boxscore = await getBoxscore(gamePk).catch((err) => {
      console.warn('mlb/game/preview boxscore failed:', (err as Error).message);
      return null;
    });

    const homeTeamId = boxscore?.teams.home.team.id ?? null;
    const awayTeamId = boxscore?.teams.away.team.id ?? null;

    // 2) Injuries — parallel fetch, non-fatal on miss.
    const [awayIl, homeIl] = await Promise.all([
      awayTeamId ? getTeamInjuredList(awayTeamId) : Promise.resolve([]),
      homeTeamId ? getTeamInjuredList(homeTeamId) : Promise.resolve([]),
    ]);

    // 3) Team leaders from our local DB. Single query per team /
    //    category so we don't blow up the request when one side is
    //    missing data. Bayesian-friendly thresholds: 80 PA / 30 IP.
    const teamLeaders = async (teamId: number | null) => {
      if (!teamId) {
        return { hittingAvg: [], hittingHr: [], pitchingEra: [] };
      }
      const pool = getPool();
      const [avgRows, hrRows, eraRows] = await Promise.all([
        pool.query<{
          player_id: number;
          full_name: string;
          pa: string;
          hits: string;
          ab: string;
          avg: string;
        }>(
          `SELECT p.id AS player_id, p.full_name,
                  SUM(s.plate_appearances)::text AS pa,
                  SUM(s.hits)::text AS hits,
                  SUM(s.at_bats)::text AS ab,
                  ROUND(SUM(s.hits)::numeric / NULLIF(SUM(s.at_bats),0), 3)::text AS avg
             FROM mlb_hitting_stats s
             JOIN mlb_players p ON p.id = s.player_id
            WHERE s.team_id = $1
            GROUP BY p.id, p.full_name
           HAVING SUM(s.plate_appearances) >= 80
            ORDER BY (SUM(s.hits)::numeric / NULLIF(SUM(s.at_bats),0)) DESC NULLS LAST
            LIMIT 3`,
          [teamId],
        ),
        pool.query<{ player_id: number; full_name: string; hr: string; pa: string }>(
          `SELECT p.id AS player_id, p.full_name,
                  SUM(s.home_runs)::text AS hr,
                  SUM(s.plate_appearances)::text AS pa
             FROM mlb_hitting_stats s
             JOIN mlb_players p ON p.id = s.player_id
            WHERE s.team_id = $1
            GROUP BY p.id, p.full_name
            ORDER BY SUM(s.home_runs) DESC NULLS LAST
            LIMIT 3`,
          [teamId],
        ),
        pool.query<{
          player_id: number;
          full_name: string;
          ip: string;
          er: string;
          era: string;
          k: string;
        }>(
          `SELECT p.id AS player_id, p.full_name,
                  SUM(s.outs_recorded)::numeric / 3 AS ip_num,
                  ROUND((SUM(s.outs_recorded)::numeric / 3)::numeric, 1)::text AS ip,
                  SUM(s.earned_runs_allowed)::text AS er,
                  ROUND( SUM(s.earned_runs_allowed)::numeric * 9
                         / NULLIF(SUM(s.outs_recorded)::numeric / 3, 0), 2)::text AS era,
                  SUM(s.strikeouts)::text AS k
             FROM mlb_pitching_stats s
             JOIN mlb_players p ON p.id = s.player_id
            WHERE s.team_id = $1 AND s.is_starter = true
            GROUP BY p.id, p.full_name
           HAVING SUM(s.outs_recorded) >= 90
            ORDER BY ( SUM(s.earned_runs_allowed)::numeric * 9
                       / NULLIF(SUM(s.outs_recorded)::numeric / 3, 0) ) ASC NULLS LAST
            LIMIT 3`,
          [teamId],
        ),
      ]);
      return {
        hittingAvg: avgRows.rows.map((r) => ({
          playerId: r.player_id,
          name: r.full_name,
          stat: 'AVG',
          value: r.avg,
          context: `${r.pa} PA · ${r.hits}/${r.ab}`,
        })),
        hittingHr: hrRows.rows.map((r) => ({
          playerId: r.player_id,
          name: r.full_name,
          stat: 'HR',
          value: r.hr,
          context: `${r.pa} PA`,
        })),
        pitchingEra: eraRows.rows.map((r) => ({
          playerId: r.player_id,
          name: r.full_name,
          stat: 'ERA',
          value: r.era,
          context: `${r.ip} IP · ${r.k} K · ${r.er} ER`,
        })),
      };
    };

    const [awayLeaders, homeLeaders] = await Promise.all([
      teamLeaders(awayTeamId).catch(() => ({ hittingAvg: [], hittingHr: [], pitchingEra: [] })),
      teamLeaders(homeTeamId).catch(() => ({ hittingAvg: [], hittingHr: [], pitchingEra: [] })),
    ]);

    // Lineups — turn battingOrder into ordered cards. The API stores
    // batting order codes like "100","200"…"900"; sort numerically.
    const buildLineup = (side: typeof boxscore extends null ? null : NonNullable<typeof boxscore>['teams']['home']) => {
      if (!side) return [];
      const players = Object.values(side.players ?? {});
      const lineup = players
        .filter((p) => p.battingOrder)
        .sort((a, b) => Number(a.battingOrder ?? 0) - Number(b.battingOrder ?? 0))
        .map((p) => ({
          playerId: p.person.id,
          name: p.person.fullName,
          position: p.position?.abbreviation ?? '',
          battingOrder: Math.floor(Number(p.battingOrder ?? 0) / 100),
          avg: p.seasonStats?.batting?.avg ?? null,
          hr: p.seasonStats?.batting?.homeRuns ?? null,
          rbi: p.seasonStats?.batting?.rbi ?? null,
          ops: p.seasonStats?.batting?.ops ?? null,
        }));
      return lineup;
    };

    const lineups = {
      away: boxscore ? buildLineup(boxscore.teams.away) : [],
      home: boxscore ? buildLineup(boxscore.teams.home) : [],
    };

    const formatIl = (entries: typeof awayIl) =>
      entries.map((e) => ({
        playerId: e.person.id,
        name: e.person.fullName,
        position: e.position?.abbreviation ?? null,
        status: e.status?.description ?? e.status?.code ?? 'IL',
      }));

    res.json({
      gamePk,
      lineups,
      injuries: {
        away: formatIl(awayIl),
        home: formatIl(homeIl),
      },
      leaders: {
        away: awayLeaders,
        home: homeLeaders,
      },
      disclaimer: MLB_DISCLAIMER,
    });
  } catch (err) {
    console.error('mlb/game/preview failed', err);
    res.status(500).json({ error: 'mlb game preview failed' });
  }
});

// GET /api/mlb/game/:gamePk/live
//
// Phase C — slim wrapper around statsapi.mlb.com's live game feed.
// The full feed is ~2MB; we project just what the play-by-play UI
// renders: current state (inning/count/outs/runners/score) and the
// recent plays array. Frontend polls this every 15s during live
// games. For pregame / final games we still return cleanly so the
// UI can render the same component without conditionally fetching.
mlbRouter.get('/game/:gamePk/live', async (req, res) => {
  const gamePk = Number(req.params.gamePk);
  if (!Number.isFinite(gamePk) || gamePk <= 0) {
    res.status(400).json({ error: 'gamePk must be a positive integer' });
    return;
  }

  try {
    const feed = await getLiveGameFeed(gamePk);
    const status = feed.gameData.status;
    const linescore = feed.liveData.linescore ?? {};
    const plays = feed.liveData.plays ?? { allPlays: [] };
    const allPlays = plays.allPlays ?? [];

    // Most-recent 12 plays. Reverse so the latest renders at the top.
    const recentPlays = allPlays.slice(-12).reverse().map((p) => ({
      atBatIndex: p.about.atBatIndex ?? null,
      inning: p.about.inning ?? null,
      halfInning: p.about.halfInning ?? null,
      description: p.result.description ?? '',
      eventType: p.result.eventType ?? null,
      isScoringPlay: p.about.isScoringPlay ?? false,
      awayScore: p.result.awayScore ?? null,
      homeScore: p.result.homeScore ?? null,
      batter: p.matchup?.batter?.fullName ?? null,
      pitcher: p.matchup?.pitcher?.fullName ?? null,
    }));

    const currentPlay = plays.currentPlay
      ? {
          inning: plays.currentPlay.about.inning ?? null,
          halfInning: plays.currentPlay.about.halfInning ?? null,
          batter: plays.currentPlay.matchup?.batter?.fullName ?? null,
          pitcher: plays.currentPlay.matchup?.pitcher?.fullName ?? null,
          balls: plays.currentPlay.count?.balls ?? null,
          strikes: plays.currentPlay.count?.strikes ?? null,
          outs: plays.currentPlay.count?.outs ?? null,
          description: plays.currentPlay.result.description ?? null,
        }
      : null;

    const abstractState = status.abstractGameState; // Preview / Live / Final
    const state: 'pregame' | 'live' | 'final' =
      abstractState === 'Live' ? 'live'
      : abstractState === 'Final' ? 'final'
      : 'pregame';

    // Per-player current stats for live leg grading. Project the
    // boxscore down to the same statKeys we use on slate legs so the
    // frontend can match by playerId without a translation layer.
    // Pre-game: empty map (no in-game stats yet). Live/final: filled.
    const playerStats: Record<string, {
      hits: number | null;
      atBats: number | null;
      runs: number | null;
      rbis: number | null;
      walks: number | null;
      strikeouts: number | null;
      homeRuns: number | null;
      doubles: number | null;
      triples: number | null;
      stolenBases: number | null;
      totalBases: number | null;
      hitByPitch: number | null;
      // Pitching
      inningsPitched: number | null;        // numeric (4.2 = 4 + 2/3)
      outsRecorded: number | null;
      pitcherStrikeouts: number | null;
      hitsAllowed: number | null;
      earnedRunsAllowed: number | null;
      walksAllowed: number | null;
      homeRunsAllowed: number | null;
    }> = {};

    const ipStringToOuts = (ip: string | undefined): number | null => {
      if (ip === undefined || ip === null || ip === '') return null;
      // MLB API ships "4.2" meaning 4 full innings + 2 outs. Not 4.667.
      const [whole, frac] = String(ip).split('.');
      const wholeN = Number(whole);
      const fracN = Number(frac ?? '0');
      if (!Number.isFinite(wholeN) || !Number.isFinite(fracN)) return null;
      return wholeN * 3 + fracN;
    };

    const boxscore = feed.liveData.boxscore;
    if (boxscore) {
      for (const sideKey of ['away', 'home'] as const) {
        const side = boxscore.teams[sideKey];
        for (const key of Object.keys(side.players ?? {})) {
          const p = side.players[key];
          const id = p.person.id;
          const b = p.stats?.batting;
          const pi = p.stats?.pitching;
          const outs = ipStringToOuts(pi?.inningsPitched) ?? (pi?.outs ?? null);
          playerStats[id] = {
            hits:           b?.hits ?? null,
            atBats:         b?.atBats ?? null,
            runs:           b?.runs ?? null,
            rbis:           b?.rbi ?? null,
            walks:          b?.baseOnBalls ?? null,
            strikeouts:     b?.strikeOuts ?? null,
            homeRuns:       b?.homeRuns ?? null,
            doubles:        b?.doubles ?? null,
            triples:        b?.triples ?? null,
            stolenBases:    b?.stolenBases ?? null,
            totalBases:     b?.totalBases ?? null,
            hitByPitch:     b?.hitByPitch ?? null,
            inningsPitched: outs !== null ? Math.round((outs / 3) * 10) / 10 : null,
            outsRecorded:   outs,
            pitcherStrikeouts:  pi?.strikeOuts ?? null,
            hitsAllowed:        pi?.hits ?? null,
            earnedRunsAllowed:  pi?.earnedRuns ?? null,
            walksAllowed:       pi?.baseOnBalls ?? null,
            homeRunsAllowed:    pi?.homeRuns ?? null,
          };
        }
      }
    }

    res.json({
      gamePk,
      state,
      detailedState: status.detailedState,
      inning: {
        number: linescore.currentInning ?? null,
        ordinal: linescore.currentInningOrdinal ?? null,
        half: linescore.inningHalf ?? null,
      },
      count: {
        balls: linescore.balls ?? null,
        strikes: linescore.strikes ?? null,
        outs: linescore.outs ?? null,
      },
      runners: {
        first: linescore.offense?.first?.fullName ?? null,
        second: linescore.offense?.second?.fullName ?? null,
        third: linescore.offense?.third?.fullName ?? null,
      },
      atBat: {
        batter: linescore.offense?.batter?.fullName ?? null,
        pitcher: linescore.offense?.pitcher?.fullName ?? null,
      },
      score: {
        away: linescore.teams?.away?.runs ?? null,
        home: linescore.teams?.home?.runs ?? null,
      },
      currentPlay,
      recentPlays,
      playerStats,
    });
  } catch (err) {
    console.error('mlb/game/live failed', err);
    res.status(500).json({ error: 'mlb game live failed' });
  }
});

// In-memory cache for the bulk live-stats response. The route fans
// out to ~15 boxscore fetches per call; without a cache, every slate
// page load + 30s poll would hammer statsapi. 25s TTL keeps the
// data fresh enough for live grading while ensuring exactly one
// upstream round-trip per refresh interval.
let liveTodayCache: { fetchedAt: number; payload: unknown } | null = null;
const LIVE_TODAY_TTL_MS = 25_000;

// GET /api/mlb/live/today
//
// Bulk live stats keyed by playerId, for ALL of today's MLB games.
// Powers per-leg live grading on /mlb/slate: each card leg looks up
// its player in `byPlayer` to see current value vs line. Returns
// only what the slate cards need — no play-by-play, no boxscore
// metadata — to keep the payload small (~50KB even on a full slate).
mlbRouter.get('/live/today', async (_req, res) => {
  const now = Date.now();
  if (liveTodayCache && now - liveTodayCache.fetchedAt < LIVE_TODAY_TTL_MS) {
    res.json(liveTodayCache.payload);
    return;
  }

  try {
    const todayGames = await getTodaysMlbGames();

    // Only fetch boxscores for games that are live or final — pregame
    // boxscores have no player stats yet and would just waste calls.
    const interesting = todayGames.filter(
      (g) => g.status.abstractGameState === 'Live' || g.status.abstractGameState === 'Final',
    );

    // Per-game live state for the UI (inning, score, status). We
    // already have most of this from /today; project just the
    // fields the slate cards render.
    const byGame: Record<string, {
      state: 'pregame' | 'live' | 'final';
      detailedState: string;
      awayAbbr: string;
      homeAbbr: string;
      awayScore: number | null;
      homeScore: number | null;
    }> = {};

    for (const g of todayGames) {
      const abs = g.status.abstractGameState;
      const state: 'pregame' | 'live' | 'final' =
        abs === 'Live' ? 'live' : abs === 'Final' ? 'final' : 'pregame';
      byGame[g.gamePk] = {
        state,
        detailedState: g.status.detailedState,
        awayAbbr: g.away.abbreviation,
        homeAbbr: g.home.abbreviation,
        awayScore: g.away.score,
        homeScore: g.home.score,
      };
    }

    // Parallel boxscore fetches. Failure on one game doesn't poison
    // the rest — settled-allSettled and ignore rejections.
    const boxResults = await Promise.allSettled(
      interesting.map((g) => getBoxscore(g.gamePk).then((b) => ({ gamePk: g.gamePk, box: b }))),
    );

    const byPlayer: Record<string, {
      gamePk: number;
      hits: number | null;
      atBats: number | null;
      runs: number | null;
      rbis: number | null;
      walks: number | null;
      strikeouts: number | null;
      homeRuns: number | null;
      doubles: number | null;
      triples: number | null;
      stolenBases: number | null;
      totalBases: number | null;
      hitByPitch: number | null;
      outsRecorded: number | null;
      pitcherStrikeouts: number | null;
      hitsAllowed: number | null;
      earnedRunsAllowed: number | null;
      walksAllowed: number | null;
      homeRunsAllowed: number | null;
    }> = {};

    const ipStringToOuts = (ip: string | undefined): number | null => {
      if (ip === undefined || ip === null || ip === '') return null;
      const [whole, frac] = String(ip).split('.');
      const wholeN = Number(whole);
      const fracN = Number(frac ?? '0');
      if (!Number.isFinite(wholeN) || !Number.isFinite(fracN)) return null;
      return wholeN * 3 + fracN;
    };

    for (const result of boxResults) {
      if (result.status !== 'fulfilled') continue;
      const { gamePk, box } = result.value;
      for (const sideKey of ['away', 'home'] as const) {
        const players = box.teams[sideKey].players ?? {};
        for (const key of Object.keys(players)) {
          const p = players[key];
          const id = p.person.id;
          const b = p.stats?.batting;
          const pi = p.stats?.pitching;
          const outs = ipStringToOuts(pi?.inningsPitched) ?? (pi?.outs ?? null);
          byPlayer[id] = {
            gamePk,
            hits:           b?.hits ?? null,
            atBats:         b?.atBats ?? null,
            runs:           b?.runs ?? null,
            rbis:           b?.rbi ?? null,
            walks:          b?.baseOnBalls ?? null,
            strikeouts:     b?.strikeOuts ?? null,
            homeRuns:       b?.homeRuns ?? null,
            doubles:        b?.doubles ?? null,
            triples:        b?.triples ?? null,
            stolenBases:    b?.stolenBases ?? null,
            totalBases:     b?.totalBases ?? null,
            hitByPitch:     b?.hitByPitch ?? null,
            outsRecorded:   outs,
            pitcherStrikeouts:  pi?.strikeOuts ?? null,
            hitsAllowed:        pi?.hits ?? null,
            earnedRunsAllowed:  pi?.earnedRuns ?? null,
            walksAllowed:       pi?.baseOnBalls ?? null,
            homeRunsAllowed:    pi?.homeRuns ?? null,
          };
        }
      }
    }

    const payload = {
      fetchedAt: new Date().toISOString(),
      byGame,
      byPlayer,
    };

    liveTodayCache = { fetchedAt: now, payload };
    res.json(payload);
  } catch (err) {
    console.error('mlb/live/today failed', err);
    res.status(500).json({ error: 'mlb live today fetch failed' });
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
