// WNBA routes mounted at /api/wnba. Phase 74 surface area: enough to
// power the WNBA standings page + nav entry + future scoreboard rail.
// Compare/slate/calibration land in subsequent phases.

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

wnbaRouter.get('/slate/today', async (_req, res) => {
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

    // Sort by edge desc — top edges first.
    projected.sort((a, b) => b.edgePercent - a.edgePercent);

    const payload = {
      slate: {
        date: stored.date,
        count: stored.lines.length,
        rawText: stored.rawText,
        updatedAt: stored.updatedAt,
      },
      resolved: {
        lines: projected,
        unresolved,
        lineCount: projected.length,
        disclaimer: WNBA_DISCLAIMER,
      },
    };
    wnbaSlateProjectionCache = { fetchedAt: Date.now(), data: payload };
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

    // Invalidate projection cache so the next GET re-projects.
    wnbaSlateProjectionCache = null;

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
