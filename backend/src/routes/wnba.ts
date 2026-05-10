// WNBA routes mounted at /api/wnba. Phases 74-78 shipped the full
// WNBA surface area: standings, scoreboard, team list, compare,
// slate, calibration, game detail. Per the 2026-05-09 sport-
// priorities decision WNBA is now on maintenance only — these routes
// stay live but no new WNBA features are scoped (MMA replaced WNBA
// as the third focus sport).

import { Router } from 'express';
import {
  clearWnbaDailySlateFromDb,
  getWnbaDailySlateFromDb,
  isDbConfigured,
  setWnbaDailySlateInDb,
  type WnbaStoredDailyLine,
} from '../db.js';
import {
  fetchWnbaGameSummary,
  fetchWnbaPlayerGameLog,
  fetchWnbaPlayerSearch,
  fetchWnbaScoreboard,
  fetchWnbaStandings,
  fetchWnbaTeams,
} from '../wnba/espn.js';
import {
  isValidWnbaStatKey,
  listWnbaStatKeys,
  projectWnbaLine,
  type ProjectedWnbaLine,
} from '../wnba/projection.js';
import { buildWnbaSlate, type WnbaSlateMode } from '../wnba/slateBuilder.js';
import {
  computeWnbaCalibration,
  gradeWnbaProjections,
  listWnbaProjections,
  recordWnbaProjections,
  type RecordableWnbaLeg,
} from '../wnba/projectionHistory.js';
import { prizepicksProvider } from '../market/providers/prizepicks.js';
import { writeMarketSnapshots } from '../market/snapshots.js';

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

// ---------- Slate (Phase 77 — top-edges; Best 2-6 cards in 77b) ----------

const SLATE_ADMIN_HEADER = 'x-admin-secret';

function isSlateAdmin(req: import('express').Request): boolean {
  const expected = process.env.SLATE_ADMIN_SECRET;
  if (!expected) return false;
  const header = req.header(SLATE_ADMIN_HEADER);
  return !!header && header === expected;
}

// Pipe-format parser. Same shape as MLB:
//   Player Name|TEAM|stat_key|line|direction
// Tolerant of spaces, blank lines, comments (#), and trailing pipes.
type ParsedRawLine = {
  playerName: string;
  team: string | null;
  statKey: string;
  line: number;
  direction: 'over' | 'under' | 'both';
  rawText: string;
};

function parseWnbaSlateText(text: string): {
  lines: ParsedRawLine[];
  errors: Array<{ line: string; reason: string }>;
} {
  const lines: ParsedRawLine[] = [];
  const errors: Array<{ line: string; reason: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('|').map((p) => p.trim());
    if (parts.length < 4) {
      errors.push({ line: trimmed, reason: 'Expected at least 4 fields: name|team|stat|line[|direction]' });
      continue;
    }
    const [playerName, team, statKey, lineStr, dirRaw] = parts;
    if (!playerName || !statKey) {
      errors.push({ line: trimmed, reason: 'Player name and stat key required.' });
      continue;
    }
    if (!isValidWnbaStatKey(statKey)) {
      errors.push({ line: trimmed, reason: `Unknown stat key '${statKey}'. Valid keys: ${listWnbaStatKeys().map((s) => s.key).join(', ')}` });
      continue;
    }
    const line = Number(lineStr);
    if (!Number.isFinite(line)) {
      errors.push({ line: trimmed, reason: `Line value '${lineStr}' is not numeric.` });
      continue;
    }
    const direction: 'over' | 'under' | 'both' =
      dirRaw === 'over' ? 'over'
      : dirRaw === 'under' ? 'under'
      : 'both';
    lines.push({
      playerName,
      team: team || null,
      statKey,
      line,
      direction,
      rawText: trimmed,
    });
  }
  return { lines, errors };
}

// GET /api/wnba/slate/today
//
// Returns the published slate (raw lines + projections). Uses ESPN
// gamelogs (cached) so first hit per slate publish is slow; subsequent
// hits hit a 5-min in-memory projection cache.
type WnbaSlateProjectionCache = { fetchedAt: number; data: unknown };
let wnbaSlateProjectionCache: WnbaSlateProjectionCache | null = null;
const WNBA_SLATE_TTL = 5 * 60_000;

// Tracks which slate-publish keys have already been snapshotted.
// One snapshot per (date × updatedAt) so republishing creates a
// fresh row set. Cleared when the slate cache is invalidated.
const wnbaSlateSnapshotted = new Set<string>();

wnbaRouter.get('/slate/today', async (req, res) => {
  if (!isDbConfigured()) {
    res.json({ slate: null, resolved: null });
    return;
  }
  try {
    const stored = await getWnbaDailySlateFromDb();
    if (!stored || stored.lines.length === 0) {
      res.json({ slate: null, resolved: null });
      return;
    }
    const cacheKey = `${stored.date}::${stored.updatedAt}`;
    if (wnbaSlateProjectionCache && Date.now() - wnbaSlateProjectionCache.fetchedAt < WNBA_SLATE_TTL) {
      res.json(wnbaSlateProjectionCache.data);
      return;
    }

    // Resolve athleteIds — stored lines carry them already from the
    // publish step. Just call projectWnbaLine for each.
    const projected: ProjectedWnbaLine[] = [];
    const unresolved: Array<{ raw: WnbaStoredDailyLine; reason: string }> = [];

    // Parallel batch — limit to 10 in flight to be polite to ESPN.
    const BATCH = 10;
    for (let i = 0; i < stored.lines.length; i += BATCH) {
      const batch = stored.lines.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (l) => {
          const dir: 'OVER' | 'UNDER' = l.direction === 'under' ? 'UNDER' : 'OVER';
          const proj = await projectWnbaLine(l.athleteId, l.playerName, l.team, l.statKey, l.line, dir);
          if (!proj) throw new Error(`Failed to project ${l.playerName} ${l.statKey}`);
          return proj;
        }),
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j]!;
        if (r.status === 'fulfilled') projected.push(r.value);
        else unresolved.push({ raw: batch[j]!, reason: (r.reason as Error)?.message ?? 'unknown' });
      }
    }

    // Sort by edge desc — top edges first (pre-sort lets the slate
    // builder rely on stable input ordering for tiebreaks).
    projected.sort((a, b) => b.edgePercent - a.edgePercent);

    // Run the Phase 77b institutional slate builder — Best 2-6 cards
    // with full Phase-58 exposure controls, family caps, hard slate
    // caps. Mode pulled from query string (?mode=balanced) or
    // defaults to auto.
    const requestedMode = (req.query.mode as WnbaSlateMode | undefined) ?? 'auto';
    const validMode: WnbaSlateMode =
      requestedMode === 'safe' || requestedMode === 'balanced' ||
      requestedMode === 'aggressive' || requestedMode === 'insane' ||
      requestedMode === 'auto'
        ? requestedMode
        : 'balanced';
    const built = buildWnbaSlate(projected, validMode);

    const payload = {
      slate: {
        date: stored.date,
        count: stored.lines.length,
        rawText: stored.rawText,
        updatedAt: stored.updatedAt,
      },
      resolved: {
        lines: projected,
        combos: built.combos,
        resolvedMode: built.resolvedMode,
        requestedMode: validMode,
        unresolved,
        lineCount: projected.length,
        disclaimer: WNBA_DISCLAIMER,
      },
    };
    wnbaSlateProjectionCache = { fetchedAt: Date.now(), data: payload };

    // Snapshot every projected line into wnba_projection_history once
    // per (date, updatedAt). The grader fills in actuals later. Card-
    // type marks legs that made it onto Best 2-6; everything else is
    // tagged 'top-edges' so calibration can segment by card type. Best-
    // effort — snapshot failure must not break the slate response.
    const snapshotKey = `${stored.date}::${stored.updatedAt}`;
    if (!wnbaSlateSnapshotted.has(snapshotKey)) {
      try {
        const cardLineKey = (l: ProjectedWnbaLine): string =>
          `${l.athleteId}::${l.statKey}::${l.line}::${l.direction}`;
        const cardTypeByLine = new Map<string, string>();
        for (const slot of built.combos) {
          if (!slot.combo) continue;
          for (const leg of slot.combo.legs) {
            const k = cardLineKey(leg);
            if (!cardTypeByLine.has(k)) cardTypeByLine.set(k, slot.combo.label);
          }
        }
        const recordable: RecordableWnbaLeg[] = projected.map((l) => ({
          line: l,
          cardType: cardTypeByLine.get(cardLineKey(l)) ?? 'top-edges',
        }));
        await recordWnbaProjections({ legs: recordable, gameDate: stored.date });
        wnbaSlateSnapshotted.add(snapshotKey);
      } catch (snapErr) {
        console.warn('wnba snapshot failed:', (snapErr as Error).message);
      }
    }

    res.json(payload);
  } catch (err) {
    console.error('wnba/slate/today GET failed', err);
    res.status(500).json({ error: 'wnba slate today fetch failed' });
  }
});

// POST /api/wnba/slate/today — admin only.
// Body: { rawText, lines? }. If `lines` provided, use directly;
// otherwise parse rawText. Each parsed line still needs an athleteId
// resolved via ESPN search before storing.
wnbaRouter.post('/slate/today', async (req, res) => {
  if (!isSlateAdmin(req)) {
    res.status(401).json({ error: 'admin secret required' });
    return;
  }
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'WNBA requires DB' });
    return;
  }
  try {
    const body = (req.body ?? {}) as { rawText?: string };
    const rawText = String(body.rawText ?? '');
    if (!rawText.trim()) {
      res.status(400).json({ error: 'rawText required' });
      return;
    }
    const { lines: parsed, errors } = parseWnbaSlateText(rawText);
    if (parsed.length === 0) {
      res.status(400).json({ error: 'no parseable lines', parseErrors: errors });
      return;
    }

    // Resolve each parsed line's player → athleteId via ESPN search.
    // Cache resolutions across batch so duplicate names hit ESPN once.
    const nameCache = new Map<string, string | null>();
    const resolveAthleteId = async (name: string): Promise<string | null> => {
      const key = name.toLowerCase();
      if (nameCache.has(key)) return nameCache.get(key) ?? null;
      const results = await fetchWnbaPlayerSearch(name).catch(() => []);
      const exact = results.find((r) => r.displayName.toLowerCase() === key);
      const id = exact?.id ?? results[0]?.id ?? null;
      nameCache.set(key, id);
      return id;
    };

    const stored: WnbaStoredDailyLine[] = [];
    const unresolved: Array<{ rawText: string; reason: string }> = [];
    for (const p of parsed) {
      const athleteId = await resolveAthleteId(p.playerName);
      if (!athleteId) {
        unresolved.push({ rawText: p.rawText, reason: `Player not found: ${p.playerName}` });
        continue;
      }
      stored.push({
        athleteId,
        playerName: p.playerName,
        team: p.team,
        statKey: p.statKey,
        line: p.line,
        direction: p.direction,
        rawText: p.rawText,
      });
    }

    const result = await setWnbaDailySlateInDb({
      lines: stored,
      rawText,
    });

    // Invalidate projection cache + snapshot dedup so the next GET
    // re-projects AND the new slate creates fresh history rows.
    wnbaSlateProjectionCache = null;
    wnbaSlateSnapshotted.clear();

    // Phase 103a — Market Brain snapshot. Same pattern as MLB: treat
    // the admin paste as our first-party PrizePicks feed. Best-effort
    // — failure shouldn't fail the publish.
    //
    // Phase 103c enrichment: use resolved athleteId from `stored` so
    // CLV can join cleanly (wnba_projection_history.athlete_id ↔
    // market_snapshots.internal_player_id).
    try {
      const props = prizepicksProvider.parse({
        text: rawText,
        sport: 'wnba',
        league: 'WNBA',
        gameDate: result.date,
      });
      const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const idByName = new Map<string, string>();
      for (const l of stored) {
        idByName.set(fold(l.playerName), l.athleteId);
      }
      const enriched = props.map((p) => {
        const id = idByName.get(fold(p.rawPlayerName));
        return id ? { ...p, internalPlayerId: id } : p;
      });
      await writeMarketSnapshots(enriched);
    } catch (err) {
      console.warn('wnba/slate market snapshot failed:', (err as Error).message);
    }

    res.json({
      ok: true,
      ...result,
      parseErrors: errors,
      unresolved,
    });
  } catch (err) {
    console.error('wnba/slate/today POST failed', err);
    res.status(500).json({ error: 'wnba slate today write failed' });
  }
});

wnbaRouter.delete('/slate/today', async (req, res) => {
  if (!isSlateAdmin(req)) {
    res.status(401).json({ error: 'admin secret required' });
    return;
  }
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'WNBA requires DB' });
    return;
  }
  try {
    await clearWnbaDailySlateFromDb();
    wnbaSlateProjectionCache = null;
    wnbaSlateSnapshotted.clear();
    res.json({ ok: true });
  } catch (err) {
    console.error('wnba/slate/today DELETE failed', err);
    res.status(500).json({ error: 'wnba slate today clear failed' });
  }
});

// Public stat catalog so the frontend admin form can show valid keys.
wnbaRouter.get('/slate/stats', (_req, res) => {
  res.json({ stats: listWnbaStatKeys() });
});

// ---------- Bulk live stats for WNBA slate per-leg grading ----------
//
// Same pattern as /api/mlb/live/today + /api/live/today (NBA): one
// endpoint that fans out to ESPN summaries for every live/final game,
// projects per-athlete current stats keyed by athleteId so the
// frontend can grade slate legs without 12 separate fetches.
//
// Server-side cache (25s TTL) absorbs concurrent slate-page polling.

type WnbaLiveCacheEntry = { fetchedAt: number; payload: unknown };
let wnbaLiveTodayCache: WnbaLiveCacheEntry | null = null;
const WNBA_LIVE_TTL_MS = 25_000;

function parseShootingMA(s: string): { made: number; attempted: number } {
  const [m, a] = (s ?? '').split('-').map(Number);
  return {
    made: Number.isFinite(m) ? (m ?? 0) : 0,
    attempted: Number.isFinite(a) ? (a ?? 0) : 0,
  };
}

wnbaRouter.get('/live/today', async (_req, res) => {
  const now = Date.now();
  if (wnbaLiveTodayCache && now - wnbaLiveTodayCache.fetchedAt < WNBA_LIVE_TTL_MS) {
    res.json(wnbaLiveTodayCache.payload);
    return;
  }
  try {
    const sb = await fetchWnbaScoreboard();
    const games = sb.games;

    const byGame: Record<string, {
      state: 'pregame' | 'live' | 'final';
      detailedState: string;
      awayAbbr: string;
      homeAbbr: string;
      awayScore: number | null;
      homeScore: number | null;
    }> = {};
    for (const g of games) {
      const state: 'pregame' | 'live' | 'final' =
        g.status.state === 'in' ? 'live'
        : g.status.state === 'post' ? 'final'
        : 'pregame';
      byGame[g.id] = {
        state,
        detailedState: g.status.detail,
        awayAbbr: g.away.abbreviation,
        homeAbbr: g.home.abbreviation,
        awayScore: g.away.score ? Number(g.away.score) : null,
        homeScore: g.home.score ? Number(g.home.score) : null,
      };
    }

    // Only fetch summaries for games that are live or final — pre-game
    // boxscores have no player stats yet.
    const interesting = games.filter(
      (g) => g.status.state === 'in' || g.status.state === 'post',
    );

    const byPlayer: Record<string, {
      eventId: string;
      points: number;
      rebounds: number;
      assists: number;
      steals: number;
      blocks: number;
      turnovers: number;
      threePtMade: number;
      threePtAttempted: number;
      fgMade: number;
      fgAttempted: number;
      ftMade: number;
      ftAttempted: number;
      personalFouls: number;
      pra: number;
      pr: number;
      pa: number;
      ra: number;
      stocks: number;
    }> = {};

    const summaryResults = await Promise.allSettled(
      interesting.map((g) => fetchWnbaGameSummary(g.id).then((s) => ({ eventId: g.id, summary: s }))),
    );

    for (const r of summaryResults) {
      if (r.status !== 'fulfilled') continue;
      const { eventId, summary } = r.value;
      for (const side of [summary.away, summary.home]) {
        for (const p of [...side.starters, ...side.bench]) {
          if (!p.athleteId) continue;
          const fg = parseShootingMA(p.fg);
          const tp = parseShootingMA(p.threePt);
          const ft = parseShootingMA(p.ft);
          const pts = p.points ?? 0;
          const reb = p.rebounds ?? 0;
          const ast = p.assists ?? 0;
          const stl = p.steals ?? 0;
          const blk = p.blocks ?? 0;
          byPlayer[p.athleteId] = {
            eventId,
            points: pts,
            rebounds: reb,
            assists: ast,
            steals: stl,
            blocks: blk,
            turnovers: p.turnovers ?? 0,
            threePtMade: tp.made,
            threePtAttempted: tp.attempted,
            fgMade: fg.made,
            fgAttempted: fg.attempted,
            ftMade: ft.made,
            ftAttempted: ft.attempted,
            personalFouls: p.fouls ?? 0,
            pra: pts + reb + ast,
            pr:  pts + reb,
            pa:  pts + ast,
            ra:  reb + ast,
            stocks: stl + blk,
          };
        }
      }
    }

    const payload = {
      fetchedAt: new Date().toISOString(),
      byGame,
      byPlayer,
    };
    wnbaLiveTodayCache = { fetchedAt: now, payload };
    res.json(payload);
  } catch (err) {
    console.error('wnba/live/today failed', err);
    res.status(500).json({ error: 'wnba live today fetch failed' });
  }
});

// GET /api/wnba/calibration?windowDays=30
//
// Predicted-vs-observed accuracy. Lazy-grades any ungraded rows
// whose game_date is in the past before aggregating. Same shape
// MLB calibration ships — Bayesian-smoothed hit rates so thin
// samples don't fake-claim accuracy.
wnbaRouter.get('/calibration', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'WNBA requires DB' });
    return;
  }
  const windowRaw = req.query.windowDays as string | undefined;
  const windowDays =
    windowRaw !== undefined && Number.isFinite(Number(windowRaw))
      ? Math.max(7, Math.min(365, Math.round(Number(windowRaw))))
      : 30;
  try {
    let gradeResult: Awaited<ReturnType<typeof gradeWnbaProjections>> | null = null;
    try {
      gradeResult = await gradeWnbaProjections({ windowDays });
    } catch (err) {
      console.warn('wnba/calibration grade failed:', (err as Error).message);
    }
    const report = await computeWnbaCalibration({ windowDays });
    res.json({
      ...report,
      gradedThisRequest: gradeResult,
      disclaimer: WNBA_DISCLAIMER,
    });
  } catch (err) {
    console.error('wnba/calibration failed', err);
    res.status(500).json({ error: 'wnba calibration fetch failed' });
  }
});

// GET /api/wnba/slate/history?windowDays=30
//
// Past published slates with hit-rate aggregates per day. Same shape
// MLB ships — date-grouped buckets + per-card-type rollup + per-stat-
// type rollup. Public endpoint; accountability is the whole point.
wnbaRouter.get('/slate/history', async (req, res) => {
  if (!isDbConfigured()) {
    res.json({ days: [] });
    return;
  }
  const windowDays = Math.max(1, Math.min(365, Number(req.query.windowDays ?? 30)));
  try {
    // Lazy-grade before reading so the response reflects fresh outcomes.
    try { await gradeWnbaProjections({ windowDays }); } catch (err) {
      console.warn('wnba/slate/history grade failed:', (err as Error).message);
    }
    const all = await listWnbaProjections({ windowDays });

    type CardBucket = {
      cardType: string;
      legs: number;
      hits: number;
      misses: number;
      pending: number;
      cleared: boolean | null;
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
      let day = byDate.get(r.gameDate);
      if (!day) {
        day = { date: r.gameDate, totalLegs: 0, gradedLegs: 0, hits: 0, misses: 0, pending: 0, byCardType: {} };
        byDate.set(r.gameDate, day);
      }
      day.totalLegs += 1;
      if (r.hitOrMiss === true)       { day.hits += 1; day.gradedLegs += 1; }
      else if (r.hitOrMiss === false) { day.misses += 1; day.gradedLegs += 1; }
      else                             { day.pending += 1; }

      const ct = r.cardType ?? 'Other';
      let card = day.byCardType[ct];
      if (!card) {
        card = { cardType: ct, legs: 0, hits: 0, misses: 0, pending: 0, cleared: null };
        day.byCardType[ct] = card;
      }
      card.legs += 1;
      if (r.hitOrMiss === true)       card.hits += 1;
      else if (r.hitOrMiss === false) card.misses += 1;
      else                             card.pending += 1;
    }

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

    // Per-stat-type rollup (stat + direction).
    const byStatTypeMap = new Map<string, {
      stat: string;
      direction: 'OVER' | 'UNDER';
      legs: number;
      hits: number;
      misses: number;
      pending: number;
    }>();
    for (const r of all) {
      const key = `${r.statKey}::${r.direction}`;
      let bucket = byStatTypeMap.get(key);
      if (!bucket) {
        bucket = { stat: r.statKey, direction: r.direction, legs: 0, hits: 0, misses: 0, pending: 0 };
        byStatTypeMap.set(key, bucket);
      }
      bucket.legs += 1;
      if (r.hitOrMiss === true)       bucket.hits += 1;
      else if (r.hitOrMiss === false) bucket.misses += 1;
      else                             bucket.pending += 1;
    }
    const byStatType = [...byStatTypeMap.values()]
      .map((b) => {
        const settled = b.hits + b.misses;
        return {
          ...b,
          hitRate: settled > 0 ? Math.round((b.hits / settled) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => {
        const aSettled = a.hits + a.misses;
        const bSettled = b.hits + b.misses;
        if (aSettled < 5 && bSettled >= 5) return 1;
        if (bSettled < 5 && aSettled >= 5) return -1;
        return (b.hitRate ?? 0) - (a.hitRate ?? 0);
      });

    res.json({ windowDays, days, byStatType, disclaimer: WNBA_DISCLAIMER });
  } catch (err) {
    console.error('wnba/slate/history failed', err);
    res.status(500).json({ error: 'wnba slate history failed' });
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
