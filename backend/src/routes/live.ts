import { Router } from 'express';
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

    const byPlayer: Record<string, NbaLiveTodayPlayer> = {};
    for (const result of summaryResults) {
      if (result.status !== 'fulfilled') continue;
      const { eventId, summary } = result.value;
      for (const side of [summary.away, summary.home]) {
        for (const p of [...side.starters, ...side.bench]) {
          if (!p.athleteId) continue;
          byPlayer[p.athleteId] = projectLivePlayer(p, eventId);
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
    console.error('nba live/today failed', err);
    res.status(500).json({ error: 'nba live today fetch failed' });
  }
});
