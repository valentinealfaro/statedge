// Article generation orchestrator — Phase 104.
//
// Wraps the templates + persistence into one entry per cron / trigger:
//   - generateSlatePublishArticles(date) — runs after a slate is
//     published. Pulls top edges across sports, fires top_mispricings,
//     trap_watch (per sport), why_market_wrong (per top dislocation).
//   - generateBigGameArticles() — runs from the evening cron. Pulls
//     completed games from live boxscore feeds, runs the big-game
//     detector, finds YouTube highlights, persists.
//   - generateClvRecap(date) — daily cron. Pulls yesterday's CLV
//     summary per sport, persists.
//   - generateEdgePreview(date) — morning cron. Same data as
//     top_mispricings but framed as forward-looking preview.
//
// All called from cron handlers / event hooks. Each is idempotent
// via slug-based upsert in store.ts.

import { getStandingsFromDb } from '../db.js';
import { computeMlbClv, computeWnbaClv } from '../market/clv.js';
import { computeMlbStandings } from '../services/mlbStandings.js';
import { detectBigGames, type Detection, type DetectionInput } from './bigGameDetector.js';
import { findLineSteam } from './lineSteam.js';
import type { FightNightInput } from './mmaFightNightFetcher.js';
import { upsertArticle } from './store.js';
import {
  generateClvRecap,
  generateEdgePreview,
  generateFightNight,
  generateLineSteamArticle,
  generatePowerRankings,
  generateTopMispricings,
  generateTrapWatch,
  generateWhyMarketWrong,
  generateBigGame,
  type EdgeLeg,
  type LineSteamMover,
  type PowerRankingTeam,
} from './templates.js';
import { findBigGameHighlight } from './youtubeHighlights.js';
import type { Article } from './types.js';

// ET date helper — same canonical timezone the slate uses. Inlined to
// avoid a dependency on mlb/client.ts (which wasn't exporting this).
function todayEt(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ---------- Slate-publish bundle ----------
//
// Fired from prizepicks/ingest when a slate auto-publishes. Produces
// up to: 1 cross-sport top mispricings + 3 trap watches (one per
// active sport) + 3 why-market-wrong (top 3 dislocations).
export async function generateSlatePublishArticles(opts: {
  edges: EdgeLeg[];
  date?: string;
}): Promise<Article[]> {
  const date = opts.date ?? todayEt();
  const out: Article[] = [];

  // 1. Top mispricings (cross-sport)
  const topDraft = generateTopMispricings({ edges: opts.edges, date });
  if (topDraft) out.push(await upsertArticle(topDraft));

  // 2. Trap watches per sport
  for (const sport of ['mlb', 'nba', 'wnba'] as const) {
    const draft = generateTrapWatch({ edges: opts.edges, sport, date });
    if (draft) out.push(await upsertArticle(draft));
  }

  // 3. Why-market-wrong on top-3 dislocations
  const top3 = [...opts.edges]
    .filter((e) => Math.abs(e.edgePercent) >= 10)
    .sort((a, b) => Math.abs(b.edgePercent) - Math.abs(a.edgePercent))
    .slice(0, 3);
  for (const edge of top3) {
    const draft = generateWhyMarketWrong({ edge, date });
    if (draft) out.push(await upsertArticle(draft));
  }

  return out;
}

// ---------- Big-game bundle ----------
//
// Cron fires every 30 min during evening. Pulls completed games,
// runs detector, generates articles. YouTube highlights are best-
// effort — articles publish regardless.
export async function generateBigGameArticles(opts: {
  inputs: DetectionInput[];
  // Optional: a function to look up season averages for delta calc.
  // Kept as a callback so the orchestrator doesn't import the live-
  // stats helpers (avoids circular deps).
  seasonAvgFor?: (
    sport: 'mlb' | 'nba' | 'wnba',
    playerId: number | string,
    statKey: string,
  ) => Promise<number | null>;
  // Optional: lookup our own projection for this player+stat tonight.
  projectionFor?: (
    sport: 'mlb' | 'nba' | 'wnba',
    playerId: number | string,
    statKey: string,
  ) => Promise<{ value: number; line: number; direction: 'OVER' | 'UNDER' } | null>;
}): Promise<Article[]> {
  const detections = detectBigGames(opts.inputs);
  if (detections.length === 0) return [];

  const out: Article[] = [];
  for (const d of detections) {
    out.push(await renderBigGameArticle(d, opts));
  }
  return out;
}

async function renderBigGameArticle(
  d: Detection,
  opts: {
    seasonAvgFor?: (sport: 'mlb' | 'nba' | 'wnba', playerId: number | string, statKey: string) => Promise<number | null>;
    projectionFor?: (sport: 'mlb' | 'nba' | 'wnba', playerId: number | string, statKey: string) => Promise<{ value: number; line: number; direction: 'OVER' | 'UNDER' } | null>;
  },
): Promise<Article> {
  // Hydrate season averages for the headline + supporting stats.
  const headlineStat = await hydrateStat(d, opts, d.headlineStat);
  const supportingStats: Array<typeof headlineStat> = [];
  for (const s of d.supportingStats) {
    supportingStats.push(await hydrateStat(d, opts, s));
  }

  // Look up our projection for this player's headline stat.
  let projection: { value: number; line: number; direction: 'OVER' | 'UNDER' } | null = null;
  if (opts.projectionFor) {
    try {
      projection = await opts.projectionFor(d.sport, d.player.id, d.headlineStat.key);
    } catch (err) {
      console.warn('big-game projection lookup failed:', (err as Error).message);
    }
  }

  // Best-effort YouTube highlight (will be null if no key set).
  let highlight: Awaited<ReturnType<typeof findBigGameHighlight>> = null;
  try {
    highlight = await findBigGameHighlight({
      playerName: d.player.name,
      team: d.player.team,
      gameDate: d.game.gameDate,
      sport: d.sport,
    });
  } catch (err) {
    console.warn('youtube highlight lookup failed:', (err as Error).message);
  }

  const draft = generateBigGame({
    player: { ...d.player, sport: d.sport },
    game: {
      // Game date now flows from the fetcher (which knows it from the
      // cron arg) instead of falling back to the current ET wall clock.
      // Late-night games that finish past midnight ET get the actual
      // game date in the slug + byline, not tomorrow's date.
      date: d.game.gameDate,
      awayTeam: d.game.awayTeam,
      homeTeam: d.game.homeTeam,
      awayScore: d.game.awayScore,
      homeScore: d.game.homeScore,
      finalState: d.game.state,
    },
    headlineStat,
    supportingStats,
    projection,
    highlight,
  });
  return upsertArticle(draft);
}

async function hydrateStat(
  d: Detection,
  opts: { seasonAvgFor?: (sport: 'mlb' | 'nba' | 'wnba', playerId: number | string, statKey: string) => Promise<number | null> },
  stat: { key: string; label: string; actual: number },
): Promise<{ key: string; label: string; actual: number; seasonAvg: number | null; delta: number | null }> {
  let seasonAvg: number | null = null;
  if (opts.seasonAvgFor) {
    try {
      seasonAvg = await opts.seasonAvgFor(d.sport, d.player.id, stat.key);
    } catch {
      seasonAvg = null;
    }
  }
  const delta = seasonAvg !== null ? Math.round((stat.actual - seasonAvg) * 10) / 10 : null;
  return { ...stat, seasonAvg, delta };
}

// ---------- Fight Night recap bundle (Phase 107e) ----------
//
// Daily cron runs this against the past 7 days of completed UFC
// events. Each completed event becomes one fight-night article.
// YouTube highlight is best-effort — articles publish without it.
export async function generateFightNightArticles(opts: {
  inputs: FightNightInput[];
}): Promise<Article[]> {
  if (opts.inputs.length === 0) return [];
  const out: Article[] = [];
  for (const input of opts.inputs) {
    out.push(await renderFightNightArticle(input));
  }
  return out;
}

async function renderFightNightArticle(input: FightNightInput): Promise<Article> {
  const event = input.event;
  const main = input.fights.find((f) => f.isMain) ?? input.fights[0]!;

  // Best-effort highlight pulled with the winner's name + UFC card
  // identifier as the search query. Trusted-channel filter in
  // youtubeHighlights guards against random uploads slipping through.
  let highlight: Awaited<ReturnType<typeof findBigGameHighlight>> = null;
  try {
    if (main.winnerName) {
      highlight = await findBigGameHighlight({
        playerName: main.winnerName,
        team: null,
        gameDate: event.date.slice(0, 10),
        sport: 'mma',
      });
    }
  } catch (err) {
    console.warn('fight-night highlight lookup failed:', (err as Error).message);
  }

  const draft = generateFightNight({
    eventId: event.id,
    eventName: event.name,
    eventShortName: event.shortName,
    date: event.date.slice(0, 10),
    venue: event.venue,
    fights: input.fights,
    highlight,
  });
  if (!draft) {
    throw new Error(`generateFightNight returned null for event ${event.id}`);
  }
  return upsertArticle(draft);
}

// ---------- CLV recap bundle ----------
//
// Daily morning cron. Reads yesterday's CLV summary from market/clv.ts,
// persists per sport.
export async function generateDailyClvRecaps(opts: { date: string }): Promise<Article[]> {
  const out: Article[] = [];
  for (const sport of ['mlb', 'wnba'] as const) {
    const summary = sport === 'mlb' ? await computeMlbClv({ windowDays: 1 })
      : await computeWnbaClv({ windowDays: 1 });
    if (summary.withClosing === 0) continue;

    const topBeats = summary.rows
      .filter((r) => r.beatMarket === true && r.lineDelta !== null)
      .sort((a, b) => Math.abs(b.lineDelta!) - Math.abs(a.lineDelta!))
      .slice(0, 5)
      .map((r) => ({
        playerName: r.rawPlayerName ?? `Player ${r.playerId ?? '?'}`,
        statLabel: r.statKey,
        line: r.publishLine,
        lineDelta: r.lineDelta!,
      }));

    const draft = generateClvRecap({
      sport,
      date: opts.date,
      beatRate: summary.beatRate,
      beatCount: summary.beatMarket,
      lostCount: summary.lostToMarket,
      withClosing: summary.withClosing,
      averageBeat: summary.averageBeatMagnitude,
      topBeats,
    });
    if (draft) out.push(await upsertArticle(draft));
  }
  return out;
}

// ---------- Power Rankings bundle (Phase 115) ----------
//
// Weekly cron generates one power-rankings article per active sport.
// Pulls from existing standings infrastructure: NBA team_game_logs
// JSONB, MLB mlb_games table. WNBA's standings function is sport-
// internal; falls through gracefully if its season isn't active.
//
// "Active" = standings have at least 10 teams with >0 games. Off-
// season sports return empty and the article isn't generated.
export async function generatePowerRankingsArticles(opts: { date: string }): Promise<Article[]> {
  const out: Article[] = [];

  // NBA
  try {
    // Current season — derived the same way the standings route does
    // (current calendar year as a string). NBA seasons span Oct-Apr
    // but the standings table is keyed by the year of the fall start.
    const nbaSeason = String(new Date().getUTCFullYear());
    const standings = await getStandingsFromDb(nbaSeason);
    const teams = [...standings.east, ...standings.west].filter((t) => t.wins + t.losses > 0);
    if (teams.length >= 10) {
      const teamsForTemplate: PowerRankingTeam[] = teams.map((t) => ({
        abbreviation: t.abbreviation,
        fullName: t.fullName,
        wins: t.wins,
        losses: t.losses,
        winPct: t.winPct,
        l10Wins: t.l10Wins,
        l10Losses: t.l10Losses,
        pointRate: t.ppg,
      }));
      const draft = generatePowerRankings({ sport: 'nba', date: opts.date, teams: teamsForTemplate });
      if (draft) out.push(await upsertArticle(draft));
    }
  } catch (err) {
    console.warn('power-rankings nba failed:', (err as Error).message);
  }

  // MLB
  try {
    const standings = await computeMlbStandings();
    const teams = standings.teams.filter((t) => t.wins + t.losses > 0);
    if (teams.length >= 10) {
      const teamsForTemplate: PowerRankingTeam[] = teams.map((t) => ({
        abbreviation: t.abbreviation,
        fullName: t.fullName,
        wins: t.wins,
        losses: t.losses,
        winPct: t.winPct,
        l10Wins: t.last10.wins,
        l10Losses: t.last10.losses,
        pointRate: t.runsScoredPerGame,
      }));
      const draft = generatePowerRankings({ sport: 'mlb', date: opts.date, teams: teamsForTemplate });
      if (draft) out.push(await upsertArticle(draft));
    }
  } catch (err) {
    console.warn('power-rankings mlb failed:', (err as Error).message);
  }

  return out;
}

// ---------- Line Steam bundle (Phase 109c) ----------
//
// Daily afternoon-ET cron. Reads market_snapshots over the last 24h,
// finds the biggest line moves per (player, stat, direction), emits
// one article per sport listing the day's top movers.
export async function generateLineSteamArticles(opts: { date: string; hours?: number }): Promise<Article[]> {
  const movers = await findLineSteam({ hours: opts.hours ?? 24, limit: 30 });
  if (movers.length === 0) return [];

  // Group by sport and build the LineSteamMover shape templates expect.
  const bySport: Record<'mlb' | 'nba' | 'wnba', LineSteamMover[]> = { mlb: [], nba: [], wnba: [] };
  for (const m of movers) {
    if (m.sport !== 'mlb' && m.sport !== 'nba' && m.sport !== 'wnba') continue;
    bySport[m.sport].push({
      sport: m.sport,
      playerName: m.playerName,
      team: m.team,
      statLabel: m.statKey,                    // raw key — template renders as-is
      firstLine: m.firstLine,
      latestLine: m.latestLine,
      lineDelta: m.lineDelta,
      firstImplied: m.firstImplied,
      latestImplied: m.latestImplied,
      snapshotCount: m.snapshotCount,
    });
  }

  const out: Article[] = [];
  for (const sport of ['mlb', 'nba', 'wnba'] as const) {
    if (bySport[sport].length === 0) continue;
    const draft = generateLineSteamArticle({ sport, date: opts.date, movers: bySport[sport] });
    if (draft) out.push(await upsertArticle(draft));
  }
  return out;
}

// ---------- Daily Edge Preview bundle ----------
export async function generateDailyEdgePreviews(opts: {
  edges: EdgeLeg[];
  date: string;
}): Promise<Article[]> {
  const out: Article[] = [];
  for (const sport of ['mlb', 'nba', 'wnba'] as const) {
    const draft = generateEdgePreview({ edges: opts.edges, sport, date: opts.date });
    if (draft) out.push(await upsertArticle(draft));
  }
  return out;
}
