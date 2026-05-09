import { Router } from 'express';
import { getPool, isDbConfigured } from '../db.js';
import { getScoreboardForDate, isConfigured, todayDateUtc } from '../nba/balldontlie.js';
import { fetchGameSummary, fetchScoreboard, type EspnPlayerLine } from '../nba/espn.js';

export const liveRouter: Router = Router();

liveRouter.get('/scoreboard', async (req, res) => {
  if (!isConfigured()) {
    res.status(503).json({
      error: 'Live scoreboard unavailable: set BALLDONTLIE_API_KEY in env to enable.',
    });
    return;
  }
  const date = String(req.query.date ?? todayDateUtc());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  try {
    const games = await getScoreboardForDate(date);
    res.json({ date, games });
  } catch (err) {
    console.error('scoreboard failed', err);
    res.status(502).json({ error: 'balldontlie request failed' });
  }
});

// Bulk live stats keyed by athleteId for ALL of today's NBA games.
// Powers per-leg live grading on /nba/slate cards. Same shape as
// /api/mlb/live/today but with NBA stats. ESPN's free public summary
// endpoint has per-player game stats baked in — no auth, no rate
// limit pain. Server-side cache (25s TTL) debounces upstream traffic.
let liveTodayCache: { fetchedAt: number; payload: unknown } | null = null;
const LIVE_TODAY_TTL_MS = 25_000;

type NbaLiveTodayPlayer = {
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
  offensiveRebounds: number;
  defensiveRebounds: number;
  pra: number;
  pr: number;
  pa: number;
  ra: number;
  stocks: number;
  doubleDouble: number;
};

// Parse "X-Y" string (made-attempted) → [made, attempted]. Tolerates
// undefined / empty / single-number strings.
function parseMadeAttempted(s: string | undefined): { made: number; attempted: number } {
  if (!s) return { made: 0, attempted: 0 };
  const [m, a] = s.split('-').map((p) => Number(p));
  return {
    made: Number.isFinite(m) ? (m ?? 0) : 0,
    attempted: Number.isFinite(a) ? (a ?? 0) : 0,
  };
}

function projectLivePlayer(p: EspnPlayerLine, eventId: string): NbaLiveTodayPlayer {
  const { made: fgM, attempted: fgA } = parseMadeAttempted(p.fg);
  const { made: tpM, attempted: tpA } = parseMadeAttempted(p.threePt);
  const { made: ftM, attempted: ftA } = parseMadeAttempted(p.ft);
  const points = p.points ?? 0;
  const rebounds = p.rebounds ?? 0;
  const assists = p.assists ?? 0;
  const steals = p.steals ?? 0;
  const blocks = p.blocks ?? 0;
  // Double-double: ≥2 of {points, rebounds, assists, steals, blocks} ≥ 10.
  // PrizePicks' DD prop counts steals/blocks too — match that.
  const ddCount =
    (points    >= 10 ? 1 : 0) +
    (rebounds  >= 10 ? 1 : 0) +
    (assists   >= 10 ? 1 : 0) +
    (steals    >= 10 ? 1 : 0) +
    (blocks    >= 10 ? 1 : 0);
  return {
    eventId,
    points,
    rebounds,
    assists,
    steals,
    blocks,
    turnovers: p.turnovers ?? 0,
    threePtMade: tpM,
    threePtAttempted: tpA,
    fgMade: fgM,
    fgAttempted: fgA,
    ftMade: ftM,
    ftAttempted: ftA,
    personalFouls: p.fouls ?? 0,
    // ESPN's flat box doesn't separate OREB/DREB by default; use 0 if
    // unavailable. The slate rarely uses OREB/DREB props on their own.
    offensiveRebounds: 0,
    defensiveRebounds: 0,
    pra: points + rebounds + assists,
    pr:  points + rebounds,
    pa:  points + assists,
    ra:  rebounds + assists,
    stocks: steals + blocks,
    doubleDouble: ddCount >= 2 ? 1 : 0,
  };
}

liveRouter.get('/today', async (_req, res) => {
  const now = Date.now();
  if (liveTodayCache && now - liveTodayCache.fetchedAt < LIVE_TODAY_TTL_MS) {
    res.json(liveTodayCache.payload);
    return;
  }

  try {
    const scoreboard = await fetchScoreboard();
    const games = scoreboard.games;

    // Per-game state for the UI (state badge, score, status text).
    // We always include ALL games — pregame ones still let the slate
    // page show "no games live" instead of "no live data."
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

    // Only fetch summaries for games that are live or final — pregame
    // boxscores have no player stats yet and would just waste calls.
    const interesting = games.filter(
      (g) => g.status.state === 'in' || g.status.state === 'post',
    );

    const summaryResults = await Promise.allSettled(
      interesting.map((g) => fetchGameSummary(g.id).then((s) => ({ eventId: g.id, summary: s }))),
    );

    // Collect every (athleteId, displayName, eventId) triple from the
    // summaries. The byPlayer map needs to be keyed by stats.nba.com
    // playerId (because that's what the slate uses when it stores
    // resolved legs) — NOT by ESPN's athleteId. We translate by
    // joining on name against the local nba_players table. Without
    // this translation, every NBA live grading silently fails because
    // the ID systems don't overlap.
    type RawLine = { line: EspnPlayerLine; eventId: string };
    const rawLines: RawLine[] = [];
    for (const result of summaryResults) {
      if (result.status !== 'fulfilled') continue;
      const { eventId, summary } = result.value;
      for (const side of [summary.away, summary.home]) {
        for (const p of [...side.starters, ...side.bench]) {
          if (!p.athleteId) continue;
          rawLines.push({ line: p, eventId });
        }
      }
    }

    // Build name → stats.nba.com playerId map. One DB round-trip for
    // every active player who appeared on a roster tonight.
    const nameToStatsId = new Map<string, number>();
    if (isDbConfigured() && rawLines.length > 0) {
      const names = [...new Set(rawLines.map((r) => r.line.displayName).filter(Boolean))];
      try {
        const { rows } = await getPool().query<{ id: number; full_name: string }>(
          `SELECT id, full_name FROM players WHERE full_name = ANY($1::text[])`,
          [names],
        );
        for (const r of rows) nameToStatsId.set(r.full_name.toLowerCase(), r.id);
      } catch (err) {
        // Table missing or DB hiccup — fall back to athleteId keys
        // below. Better to ship something than 500.
        console.warn('nba live/today: name→playerId lookup failed:', (err as Error).message);
      }
    }

    const byPlayer: Record<string, NbaLiveTodayPlayer> = {};
    for (const { line: p, eventId } of rawLines) {
      const stats = projectLivePlayer(p, eventId);
      // Primary key — stats.nba.com playerId (what slate uses).
      const statsId = nameToStatsId.get(p.displayName.toLowerCase());
      if (statsId !== undefined) {
        byPlayer[String(statsId)] = stats;
      }
      // Also key by ESPN athleteId for callers that still want it
      // (e.g. EspnGameDetail starters table), and as a fallback when
      // the name lookup fails. Two keys, one object — cheap and safe.
      byPlayer[p.athleteId] = stats;
    }

    const payload = {
      fetchedAt: new Date().toISOString(),
      byGame,
      byPlayer,
    };

    liveTodayCache = { fetchedAt: now, payload };
    res.json(payload);
  } catch (err) {
    console.error('nba live/today failed', err);
    res.status(500).json({ error: 'nba live today fetch failed' });
  }
});
