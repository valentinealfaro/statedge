// Market Brain admin/diagnostic routes — Phase 103a.
//
// Exposes the snapshot pipeline's health + recent activity for ops
// visibility. NOT a public consumer surface; the slate engines and
// dashboard read from market_snapshots directly via the market/
// modules.
//
// Future routes (Phase 103b+):
//   GET  /consensus/:sport/:date — multi-book consensus per prop
//   GET  /movement/:player/:stat — line-history time-series
//   POST /provider/:source/ingest — webhook for paid feeds

import { Router } from 'express';
import { getPool, isDbConfigured, setMlbDailySlateInDb, type MlbStoredDailyLine } from '../db.js';
import { computeMlbClv, computeWnbaClv } from '../market/clv.js';
import { getBudgetStatus } from '../market/creditBudget.js';
import {
  bulkResolveMlbPlayers,
  resolveMlbTeamFromFullName,
} from '../market/playerResolver.js';
import {
  fetchPrizepicksProjections,
} from '../market/providers/prizepicksApi.js';
import {
  fetchToaEventOdds,
  fetchToaEvents,
  fetchToaHistoricalEventOdds,
  fetchToaHistoricalEvents,
  theOddsApiProvider,
} from '../market/providers/theOddsApi.js';
import {
  getSnapshotsHealth,
  listRecentSnapshots,
  writeMarketSnapshots,
} from '../market/snapshots.js';
import type {
  Bookmaker,
  MarketSport,
  NormalizedProp,
  ProviderSource,
} from '../market/types.js';

export const marketRouter: Router = Router();

// ---------- Phase 103e-bis — TOA snapshot enrichment ----------
//
// The Odds API emits player props with full team names ("Toronto Blue
// Jays") and player display names ("Jack Kochanowicz"), with no
// internal IDs. Our market_snapshots table needs internal_player_id
// + team abbreviation + game_key populated for CLV to JOIN against
// projection_history cleanly.
//
// This enricher resolves what it can via the existing playerResolver
// + new team resolver. Best-effort: when resolution fails (unknown
// player / sport not yet wired), we still persist the row with raw
// name preserved so the resolver can re-resolve later as it improves.
// Same forgiveness model the PrizePicks paste pipeline uses.

type EnrichedProps = {
  props: NormalizedProp[];
  resolvedPlayers: number;
  resolvedTeams: number;
  unresolvedPlayers: number;
};

// Phase 103g-quat: bulk resolution. Replaces the previous per-name
// loop that did one query per unique player + used plain LOWER() (no
// unaccent), which missed every accented name (Jesús/José/Jesús would
// resolve only when the DB happened to also lack the accent).
//
// Now: one bulk query for all unique names using
// regexp_replace(unaccent(lower(...))) on both sides — same matching
// strategy services/mlbSlateTextParser.ts uses. Plus a per-event team
// resolution pass when events are provided (TOA path); skipped on the
// PrizePicks path because PP doesn't return event-level team data.
async function enrichToaSnapshots(
  props: NormalizedProp[],
  events: Array<{ id: string; home_team: string; away_team: string }>,
): Promise<EnrichedProps> {
  // Step 1: bulk-resolve every unique player name in one DB query.
  const uniqueNames = [...new Set(props.map((p) => p.rawPlayerName).filter(Boolean))];
  const playerLookup = props.length > 0 && props[0]?.sport === 'mlb'
    ? await bulkResolveMlbPlayers(uniqueNames)
    : new Map();

  // Step 2: resolve event teams (one DB query per unique team name —
  // small set, ~30 MLB teams max even across full slate).
  const teamCache = new Map<string, string | null>();
  async function resolveTeam(fullName: string): Promise<string | null> {
    if (teamCache.has(fullName)) return teamCache.get(fullName) ?? null;
    const resolved = await resolveMlbTeamFromFullName(fullName);
    teamCache.set(fullName, resolved?.abbreviation ?? null);
    return resolved?.abbreviation ?? null;
  }
  const eventTeams = new Map<string, { home: string | null; away: string | null }>();
  for (const ev of events) {
    const [home, away] = await Promise.all([
      resolveTeam(ev.home_team),
      resolveTeam(ev.away_team),
    ]);
    eventTeams.set(ev.id, { home, away });
  }

  // Step 3: stitch each prop. Same unaccent fold the bulk resolver
  // produces — names match by canonical-folded form, not raw.
  const folded = (s: string): string =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

  let resolvedPlayers = 0;
  let resolvedTeams = 0;
  let unresolvedPlayers = 0;
  const enriched: NormalizedProp[] = [];

  for (const p of props) {
    const eventTeam = p.providerGameId ? eventTeams.get(p.providerGameId) : null;
    const player = playerLookup.get(folded(p.rawPlayerName));

    const playerTeam = player?.team ?? p.team ?? null;

    let opponent: string | null = null;
    if (playerTeam && eventTeam?.home && eventTeam?.away) {
      if (playerTeam === eventTeam.home) opponent = eventTeam.away;
      else if (playerTeam === eventTeam.away) opponent = eventTeam.home;
    }

    let gameKey: string | null = null;
    if (eventTeam?.home && eventTeam?.away) {
      gameKey = [eventTeam.home, eventTeam.away].sort().join('-');
    } else if (playerTeam && opponent) {
      gameKey = [playerTeam, opponent].sort().join('-');
    }

    if (player) resolvedPlayers += 1;
    else unresolvedPlayers += 1;
    if (playerTeam) resolvedTeams += 1;

    enriched.push({
      ...p,
      internalPlayerId: player?.internalId ?? null,
      team: playerTeam,
      opponent,
      gameKey,
    });
  }

  return { props: enriched, resolvedPlayers, resolvedTeams, unresolvedPlayers };
}

// GET /api/market/health
//
// "Is the snapshot pipeline alive?" Returns total snapshot count,
// last-24h count, by-bookmaker + by-sport rollups, and the date
// range. Public — same accountability principle as /api/calibration:
// users can audit how much market memory we've accumulated.
marketRouter.get('/health', async (_req, res) => {
  try {
    const health = await getSnapshotsHealth();
    res.json(health);
  } catch (err) {
    console.error('market/health failed', err);
    res.status(500).json({ error: 'market health failed' });
  }
});

// GET /api/market/snapshots/recent?hours=24&sport=mlb&bookmaker=prizepicks&limit=200
//
// Diagnostic feed of recent snapshots. Bounded by hours window so
// big tables stay queryable. Defaults: 24 hours, 500 rows. All
// filters optional; combined with AND.
// GET /api/market/clv?sport=mlb&windowDays=30&limit=500
//
// Closing Line Value engine. Joins each published projection against
// the latest later market snapshot for the same prop and computes
// direction-aware "did we beat the close?" stats. The first REAL
// truth metric for the platform — independent of game-outcome variance.
marketRouter.get('/clv', async (req, res) => {
  try {
    const sport = String(req.query.sport ?? 'mlb').toLowerCase();
    const windowDays = req.query.windowDays
      ? Math.max(1, Math.min(365, Number(req.query.windowDays)))
      : 30;
    const limit = req.query.limit
      ? Math.max(1, Math.min(2000, Number(req.query.limit)))
      : 500;
    if (sport !== 'mlb' && sport !== 'wnba') {
      res.status(400).json({ error: 'sport must be mlb or wnba' });
      return;
    }
    const summary = sport === 'mlb'
      ? await computeMlbClv({ windowDays, limit })
      : await computeWnbaClv({ windowDays, limit });
    // Trim rows to first 100 in the response payload — full set is
    // available via larger limit if needed. Summary aggregates already
    // included.
    res.json({
      ...summary,
      rows: summary.rows.slice(0, 100),
      rowsTrimmed: summary.rows.length > 100,
    });
  } catch (err) {
    console.error('market/clv failed', err);
    res.status(500).json({ error: 'market clv failed' });
  }
});

// GET /api/market/odds-api/budget
//
// Reports current month's credit usage against ODDS_API_MONTHLY_CREDITS.
// Public read — same accountability principle as /api/market/health.
marketRouter.get('/odds-api/budget', async (_req, res) => {
  try {
    const status = await getBudgetStatus('the_odds_api', 'ODDS_API_MONTHLY_CREDITS');
    res.json(status);
  } catch (err) {
    console.error('odds-api/budget failed', err);
    res.status(500).json({ error: 'budget query failed' });
  }
});

// POST /api/market/odds-api/test  (admin only)
//
// Phase 103e integration test. Pulls events for the requested sport
// (free — no credits), then fetches event-odds for ONE event with ONE
// market — minimum-cost validation that the integration works end-to-
// end. Spends ~1 credit. Persists the result via writeMarketSnapshots
// so the snapshot pipeline gets exercised too.
//
// Body: { sport: 'mlb' | 'nba' | 'mma', market?: string }
// Returns: { events, eventTested, cost, snapshotsInserted, sample }
marketRouter.post('/odds-api/test', async (req, res) => {
  // Admin gate — same pattern MLB / WNBA slate POSTs use.
  const expected = process.env.SLATE_ADMIN_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'SLATE_ADMIN_SECRET not configured' });
    return;
  }
  if (req.header('x-admin-secret') !== expected) {
    res.status(401).json({ error: 'admin secret required' });
    return;
  }

  const body = (req.body ?? {}) as { sport?: string; market?: string };
  const sport = (body.sport ?? 'mlb') as MarketSport;
  // Default test market — pitcher_strikeouts is universally available
  // on MLB game days; player_points for NBA; mma uses h2h game-level
  // since fighter props are spotty across books on TOA.
  const defaultMarket = sport === 'mlb' ? 'pitcher_strikeouts'
    : sport === 'nba' ? 'player_points'
    : sport === 'wnba' ? 'player_points'
    : sport === 'mma' ? 'h2h'
    : 'player_points';
  const market = body.market ?? defaultMarket;

  try {
    // Step 1: list events (free).
    const eventsRes = await fetchToaEvents(sport);
    if (eventsRes.data.length === 0) {
      res.json({
        ok: true,
        sport,
        events: 0,
        eventTested: null,
        cost: 0,
        snapshotsInserted: 0,
        message: `No events scheduled for ${sport} in the Odds API window (typically only games starting within ~7 days).`,
        budgetAfter: await getBudgetStatus('the_odds_api', 'ODDS_API_MONTHLY_CREDITS'),
      });
      return;
    }

    // Step 2: fetch one event's odds for one market — minimum cost.
    const firstEvent = eventsRes.data[0]!;
    const oddsRes = await fetchToaEventOdds({
      sport,
      eventId: firstEvent.id,
      markets: [market],
      regions: 'us',
    });

    // Step 3: parse + enrich + persist. Phase 103e-bis: resolution
    // enricher populates internalPlayerId / team / opponent / gameKey
    // before write so CLV can JOIN cleanly against projection_history.
    const props = theOddsApiProvider.parse(oddsRes.data);
    const enriched = sport === 'mlb'
      ? await enrichToaSnapshots(props, [firstEvent])
      : { props, resolvedPlayers: 0, resolvedTeams: 0, unresolvedPlayers: props.length };
    const writeRes = await writeMarketSnapshots(enriched.props);

    res.json({
      ok: true,
      sport,
      events: eventsRes.data.length,
      eventTested: {
        id: firstEvent.id,
        away: firstEvent.away_team,
        home: firstEvent.home_team,
        commence: firstEvent.commence_time,
      },
      market,
      cost: oddsRes.quota.costThisRequest,
      requestsRemaining: oddsRes.quota.requestsRemaining,
      requestsUsed: oddsRes.quota.requestsUsed,
      snapshotsInserted: writeRes.inserted,
      resolution: {
        playersResolved: enriched.resolvedPlayers,
        teamsResolved: enriched.resolvedTeams,
        playersUnresolved: enriched.unresolvedPlayers,
      },
      // First 3 props for visual confirmation. Don't dump everything.
      sample: enriched.props.slice(0, 3),
      budgetAfter: await getBudgetStatus('the_odds_api', 'ODDS_API_MONTHLY_CREDITS'),
    });
  } catch (err) {
    console.error('odds-api/test failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/market/odds-api/backfill (admin only)
//
// Phase 103f historical backfill. Pulls historical odds for the
// requested sport over a date range and writes them through the same
// snapshot pipeline. EXPENSIVE — 10 credits per market per region per
// event-snapshot. Conservative defaults to keep the $30 / 20K plan
// envelope viable:
//   - 1 market default (caller can request more, gets warned)
//   - 1 region (us)
//   - 1 snapshot per game-day (closing line — typically the most
//     informative single timestamp)
//
// Body: {
//   sport: 'mlb' | 'nba' | 'wnba' | 'mma',
//   days: number,                     // 1-30
//   markets?: string[],               // default ['pitcher_strikeouts'] for mlb, ['player_points'] for nba/wnba, ['h2h'] for mma
//   maxCreditsPerSport?: number,      // soft cap on this run
//   dryRun?: boolean,                 // estimate cost without firing
// }
//
// Returns: { totalCredits, totalSnapshots, byDay, byEvent, dryRun }
marketRouter.post('/odds-api/backfill', async (req, res) => {
  const expected = process.env.SLATE_ADMIN_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'SLATE_ADMIN_SECRET not configured' });
    return;
  }
  if (req.header('x-admin-secret') !== expected) {
    res.status(401).json({ error: 'admin secret required' });
    return;
  }

  const body = (req.body ?? {}) as {
    sport?: MarketSport;
    days?: number;
    markets?: string[];
    maxCreditsPerSport?: number;
    dryRun?: boolean;
  };
  const sport = (body.sport ?? 'mlb') as MarketSport;
  const days = Math.max(1, Math.min(30, Math.round(Number(body.days ?? 7))));
  const dryRun = body.dryRun ?? false;
  const maxCredits = body.maxCreditsPerSport ?? 6000;
  const markets = body.markets ?? defaultBackfillMarket(sport);

  // Pre-flight budget check (rough estimate). Each historical event
  // costs 10 × markets × 1 region. Plus 1 credit per day to list
  // events. We assume ~10 events/day average (MLB heavier, NBA
  // playoffs lighter, MMA much lower).
  const eventsPerDay = sport === 'mlb' ? 15 : sport === 'mma' ? 1 : 4;
  const estimatedCost = days * (1 + eventsPerDay * 10 * markets.length);
  if (estimatedCost > maxCredits) {
    res.status(400).json({
      error: `Estimated cost ${estimatedCost} exceeds maxCreditsPerSport ${maxCredits}.`,
      hint: 'Reduce days, reduce markets, or raise maxCreditsPerSport (after confirming budget).',
      estimatedCost,
      days,
      markets,
    });
    return;
  }
  if (dryRun) {
    const budget = await getBudgetStatus('the_odds_api', 'ODDS_API_MONTHLY_CREDITS');
    res.json({
      dryRun: true,
      sport,
      days,
      markets,
      estimatedCost,
      assumptions: { eventsPerDay, costPerEvent: 10 * markets.length },
      budgetBefore: budget,
    });
    return;
  }

  // Walk back N days. For each day, list events (1 credit), then for
  // each event fetch closing-time historical odds (10×markets credits).
  let totalCredits = 0;
  let totalSnapshots = 0;
  const byDay: Array<{ date: string; events: number; snapshots: number; credits: number }> = [];
  try {
    for (let dayOffset = 1; dayOffset <= days; dayOffset += 1) {
      const targetDate = new Date();
      targetDate.setUTCDate(targetDate.getUTCDate() - dayOffset);
      // Use a "post-game" timestamp so we capture the closing line —
      // ~1 hour after typical game commence times. 03:00 UTC on the
      // day after the game-day catches MLB games (which start ET
      // afternoon/evening) at their closing snapshot.
      const dayIso = targetDate.toISOString().slice(0, 10);
      const queryTimestamp = `${dayIso}T23:00:00Z`;

      const eventsRes = await fetchToaHistoricalEvents({ sport, date: queryTimestamp });
      totalCredits += eventsRes.quota.costThisRequest ?? 1;
      const events = eventsRes.data.filter((e) => e.commence_time.startsWith(dayIso));

      let daySnapshots = 0;
      let dayCredits = eventsRes.quota.costThisRequest ?? 1;
      for (const ev of events) {
        try {
          const oddsRes = await fetchToaHistoricalEventOdds({
            sport,
            eventId: ev.id,
            date: queryTimestamp,
            markets,
            regions: 'us',
          });
          const cost = oddsRes.quota.costThisRequest ?? (10 * markets.length);
          totalCredits += cost;
          dayCredits += cost;
          const props = theOddsApiProvider.parse(oddsRes.data);
          const enriched = sport === 'mlb'
            ? await enrichToaSnapshots(props, [ev])
            : { props, resolvedPlayers: 0, resolvedTeams: 0, unresolvedPlayers: props.length };
          // Override capturedAt to reflect HISTORICAL timestamp, not now.
          // Otherwise CLV would think these were captured today.
          const historicalTimestamp = oddsRes.data.timestamp ?? queryTimestamp;
          for (const p of enriched.props) {
            p.capturedAt = historicalTimestamp;
          }
          const writeRes = await writeMarketSnapshots(enriched.props);
          totalSnapshots += writeRes.inserted;
          daySnapshots += writeRes.inserted;
        } catch (err) {
          console.warn(`backfill ${sport} ${dayIso} ${ev.id}: ${(err as Error).message}`);
        }

        // Hard stop if we'd exceed maxCredits — protect against
        // estimate undershooting reality.
        if (totalCredits >= maxCredits) {
          break;
        }
      }
      byDay.push({ date: dayIso, events: events.length, snapshots: daySnapshots, credits: dayCredits });
      if (totalCredits >= maxCredits) break;
    }

    res.json({
      ok: true,
      sport,
      days,
      markets,
      totalCredits,
      totalSnapshots,
      byDay,
      budgetAfter: await getBudgetStatus('the_odds_api', 'ODDS_API_MONTHLY_CREDITS'),
    });
  } catch (err) {
    console.error('odds-api/backfill failed', err);
    res.status(500).json({
      error: (err as Error).message,
      partial: { totalCredits, totalSnapshots, byDay },
    });
  }
});

// POST /api/market/odds-api/snapshot-edges (admin only)
//
// Phase 103f edge-driven daily snapshot. Reads the highest-edge legs
// from the published slate, groups them by event, fetches LIVE odds
// for only those events × the markets needed. Way cheaper than a
// slate-wide snapshot — typical day burns ~30-50 credits on MLB
// instead of ~165.
//
// Body: { sport, topN?, marketsPerLeg? }
// Returns: { eventsFetched, totalCredits, snapshotsInserted, budgetAfter }
marketRouter.post('/odds-api/snapshot-edges', async (req, res) => {
  const expected = process.env.SLATE_ADMIN_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'SLATE_ADMIN_SECRET not configured' });
    return;
  }
  if (req.header('x-admin-secret') !== expected) {
    res.status(401).json({ error: 'admin secret required' });
    return;
  }

  const body = (req.body ?? {}) as {
    sport?: MarketSport;
    topN?: number;
    marketsPerLeg?: number;     // unused for now; kept for forward compat
  };
  const sport = (body.sport ?? 'mlb') as MarketSport;
  const topN = Math.max(1, Math.min(50, Math.round(Number(body.topN ?? 10))));
  void body.marketsPerLeg;

  if (sport !== 'mlb') {
    // Other sports' published slates haven't standardized statKey →
    // TOA market mapping yet. MLB-first; NBA + MMA layer on later.
    res.status(400).json({
      error: `snapshot-edges currently MLB-only. Sport ${sport} support pending statKey→TOA market mapping.`,
    });
    return;
  }

  try {
    // Pull today's published MLB slate from DB. Already has resolved
    // playerIds, statKeys, and edgePercents from the projection engine.
    const { rows } = await getPool().query<{
      player_id: number;
      selected_stat: string;
      direction: string;
      line_value: string;
      edge_percent: string | null;
    }>(
      `SELECT player_id, selected_stat, direction, line_value, edge_percent
         FROM mlb_projection_history
        WHERE game_date = CURRENT_DATE
          AND edge_percent IS NOT NULL
        ORDER BY ABS(edge_percent) DESC
        LIMIT $1`,
      [topN],
    );

    if (rows.length === 0) {
      res.json({
        ok: true,
        sport,
        message: 'No published projections for today yet — nothing to snapshot.',
        eventsFetched: 0,
        totalCredits: 0,
        snapshotsInserted: 0,
        budgetAfter: await getBudgetStatus('the_odds_api', 'ODDS_API_MONTHLY_CREDITS'),
      });
      return;
    }

    // Group needed markets by player. Then list TOA events to find
    // which event each player belongs to, then dedupe.
    const marketsByPlayerId = new Map<number, Set<string>>();
    for (const r of rows) {
      const set = marketsByPlayerId.get(r.player_id) ?? new Set<string>();
      const market = mlbStatKeyToToaMarket(r.selected_stat);
      if (market) set.add(market);
      marketsByPlayerId.set(r.player_id, set);
    }

    // List today's events (free). Use TOA events to discover ids.
    const eventsRes = await fetchToaEvents(sport);
    const today = new Date().toISOString().slice(0, 10);
    const todaysEvents = eventsRes.data.filter((e) => e.commence_time.startsWith(today));

    // For each event, fetch the union of markets across all top-edge
    // players in that event. Match player → event by team-name. We
    // don't have team-by-player yet from the slate (snapshot-edges is
    // MLB-only, so resolveMlbPlayer.team gives us the abbr).
    //
    // Simpler approach for v1: just hit the top events in chronological
    // order with the union of all needed markets. Caps cost.
    const allMarkets = new Set<string>();
    for (const set of marketsByPlayerId.values()) {
      for (const m of set) allMarkets.add(m);
    }
    const marketList = [...allMarkets].slice(0, 5);  // cap at 5 markets per event call
    const maxEvents = Math.min(todaysEvents.length, 5);    // cap at 5 events per snapshot

    let totalCredits = 0;
    let totalSnapshots = 0;
    const eventsHit: string[] = [];
    for (let i = 0; i < maxEvents; i += 1) {
      const ev = todaysEvents[i]!;
      try {
        const oddsRes = await fetchToaEventOdds({
          sport,
          eventId: ev.id,
          markets: marketList,
          regions: 'us',
        });
        totalCredits += oddsRes.quota.costThisRequest ?? marketList.length;
        const props = theOddsApiProvider.parse(oddsRes.data);
        const enriched = await enrichToaSnapshots(props, [ev]);
        const writeRes = await writeMarketSnapshots(enriched.props);
        totalSnapshots += writeRes.inserted;
        eventsHit.push(ev.id);
      } catch (err) {
        console.warn(`snapshot-edges ${ev.id}: ${(err as Error).message}`);
      }
    }

    res.json({
      ok: true,
      sport,
      legsConsidered: rows.length,
      uniquePlayers: marketsByPlayerId.size,
      marketsRequested: marketList,
      eventsFetched: eventsHit.length,
      totalCredits,
      snapshotsInserted: totalSnapshots,
      budgetAfter: await getBudgetStatus('the_odds_api', 'ODDS_API_MONTHLY_CREDITS'),
    });
  } catch (err) {
    console.error('odds-api/snapshot-edges failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Sport → default backfill market. Cheapest-but-meaningful single
// market that captures the most institutional signal.
function defaultBackfillMarket(sport: MarketSport): string[] {
  if (sport === 'mlb')  return ['pitcher_strikeouts'];
  if (sport === 'nba')  return ['player_points'];
  if (sport === 'wnba') return ['player_points'];
  if (sport === 'mma')  return ['h2h'];
  return ['h2h'];
}

// MLB statKey (our canonical) → The Odds API market key. Returns null
// when there's no mapping (TOA doesn't carry that market).
function mlbStatKeyToToaMarket(statKey: string): string | null {
  const map: Record<string, string> = {
    pitcher_strikeouts: 'pitcher_strikeouts',
    hits:               'batter_hits',
    total_bases:        'batter_total_bases',
    runs:               'batter_runs',
    rbis:               'batter_rbis',
    walks:              'batter_walks',
    home_runs:          'batter_home_runs',
    strikeouts:         'batter_strikeouts',
    outs_recorded:      'pitcher_outs',
    hits_allowed:       'pitcher_hits',
    walks_allowed:      'pitcher_walks',
    earned_runs_allowed: 'pitcher_earned_runs',
  };
  return map[statKey] ?? null;
}

// POST /api/market/prizepicks/sync (admin, OR cron with header secret)
//
// Phase 103g — automated PrizePicks ingestion. Fetches the full
// projections feed for the requested sport, persists every line as a
// market_snapshot, and (when publishSlate=true) UPSERTS the published
// daily slate so downstream engines (slate builder, calibration,
// projections history) pick up the fresh lines.
//
// Replaces the manual admin-paste pipeline as the primary ingestion
// source. Paste remains the BACKUP — admin can still publish manually
// when this endpoint is rate-limited or blocked.
//
// Designed for 1-2 invocations per day (matches the user's stated
// cadence). Vercel Cron triggers it; admin can also call manually.
//
// Body: {
//   sport: 'mlb' | 'nba' | 'wnba' | 'mma',
//   publishSlate?: boolean,    // default true — also write to mlb_daily_slate
//   mode?: 'safe' | 'balanced' | 'aggressive' | 'insane' | 'auto'  // for slate publish
// }
//
// Auth: x-admin-secret header MUST match SLATE_ADMIN_SECRET (works
// for both admin invocations + Vercel Cron headers).
marketRouter.post('/prizepicks/sync', async (req, res) => {
  const expected = process.env.SLATE_ADMIN_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'SLATE_ADMIN_SECRET not configured' });
    return;
  }
  if (req.header('x-admin-secret') !== expected) {
    res.status(401).json({ error: 'admin secret required' });
    return;
  }

  const body = (req.body ?? {}) as {
    sport?: MarketSport;
    publishSlate?: boolean;
    mode?: string;
  };
  const sport = (body.sport ?? 'mlb') as MarketSport;
  const publishSlate = body.publishSlate ?? true;
  const mode = body.mode ?? 'balanced';

  try {
    // Fetch + parse PrizePicks projections (one HTTP call, no cost
    // beyond the network round-trip to PrizePicks).
    const fetched = await fetchPrizepicksProjections({ sport, perPage: 500 });

    if (fetched.props.length === 0) {
      res.json({
        ok: true,
        sport,
        propsFetched: 0,
        snapshotsInserted: 0,
        slatePublished: false,
        message: 'PrizePicks returned 0 projections — board may be down or sport not in season.',
      });
      return;
    }

    // Persist every prop as a market_snapshot. For MLB, enrich with
    // resolved internal_player_id + team + opponent + gameKey so CLV
    // can JOIN against projection_history. Other sports skip
    // enrichment for now (NBA + WNBA + MMA player resolution lands
    // in subsequent phases).
    let snapshotProps = fetched.props;
    let resolution = { resolvedPlayers: 0, resolvedTeams: 0, unresolvedPlayers: 0 };
    if (sport === 'mlb') {
      // PrizePicks doesn't surface event/home/away on its projections
      // feed — opponent enrichment is best-effort (limited to what
      // resolveMlbPlayer.team gives us). Pass an empty events array
      // to keep the enricher's contract happy.
      const enriched = await enrichToaSnapshots(snapshotProps, []);
      snapshotProps = enriched.props;
      resolution = {
        resolvedPlayers: enriched.resolvedPlayers,
        resolvedTeams: enriched.resolvedTeams,
        unresolvedPlayers: enriched.unresolvedPlayers,
      };
    }
    const writeRes = await writeMarketSnapshots(snapshotProps);

    // Optional: also publish the slate so the slate engine picks up
    // these lines. MLB-only for now — NBA + WNBA slate-publish paths
    // exist but use different data shapes.
    let slatePublished = false;
    let slateLines = 0;
    if (publishSlate && sport === 'mlb' && isDbConfigured()) {
      const stored: MlbStoredDailyLine[] = [];
      for (const p of snapshotProps) {
        if (p.sport !== 'mlb') continue;
        if (typeof p.internalPlayerId !== 'number') continue;     // skip unresolved
        // Convert side: standard → 'both'; demon → 'over'; goblin → 'under'.
        let direction: 'over' | 'under' | 'both' = 'both';
        if (p.isDemon) direction = 'over';
        else if (p.isGoblin) direction = 'under';
        else direction = 'both';
        // Map our normalized statKey back to the slate's expected
        // statKey vocabulary. They're the same for MLB (we already
        // canonicalized through normalizer.ts earlier in the same
        // pipeline) so this is a no-op here.
        stored.push({
          playerId: p.internalPlayerId,
          statKey: p.statKey as MlbStoredDailyLine['statKey'],
          line: p.line,
          direction,
          // gamePk / opponent / pitcher resolution land in a follow-up;
          // PrizePicks doesn't return them on this feed. Slate engine
          // hydrates from /api/mlb/today separately.
        });
      }
      // Dedupe — PrizePicks sometimes returns multiple projections for
      // the same (player, stat, line) when one is Demon + another is
      // Goblin. The slate stores ONE line per (player, stat) tuple; we
      // prefer 'both' when present, else demon/goblin.
      const dedup = new Map<string, MlbStoredDailyLine>();
      for (const l of stored) {
        const key = `${l.playerId}::${l.statKey}::${l.line}`;
        const existing = dedup.get(key);
        if (!existing) {
          dedup.set(key, l);
        } else if (l.direction === 'both') {
          dedup.set(key, l);
        }
      }
      const finalLines = [...dedup.values()];
      if (finalLines.length > 0) {
        await setMlbDailySlateInDb({
          lines: finalLines,
          rawText: null,
          mode,
        });
        slatePublished = true;
        slateLines = finalLines.length;
      }
    }

    res.json({
      ok: true,
      sport,
      fetchedAt: fetched.fetchedAt,
      propsFetched: fetched.props.length,
      snapshotsInserted: writeRes.inserted,
      resolution,
      slatePublished,
      slateLines,
    });
  } catch (err) {
    console.error('prizepicks/sync failed', err);
    res.status(502).json({
      error: (err as Error).message,
      hint: 'PrizePicks may be rate-limiting or blocking the source IP. Fall back to admin paste.',
    });
  }
});

// POST /api/market/prizepicks/ingest (admin only)
//
// Phase 103g-tris fallback path. Vercel datacenter IPs are blocked by
// PrizePicks Cloudflare regardless of headers, so server-side fetch
// returns 403. This endpoint accepts a PRE-FETCHED PrizePicks JSON
// response (captured by an admin's browser on a residential IP, where
// Cloudflare doesn't block) and runs the same parse + enrich +
// persist + slate-publish pipeline as /sync.
//
// Workflow:
//   1. Admin clicks "Pull from PrizePicks" button on /mlb/slate.
//   2. Frontend fetches api.prizepicks.com from THEIR browser.
//   3. Frontend POSTs the response body here for persistence.
//
// Body: {
//   raw: <full PrizePicks projections response>,
//   sport: 'mlb' | 'nba' | 'wnba' | 'mma',
//   publishSlate?: boolean,    // default true
//   mode?: 'safe' | 'balanced' | 'aggressive' | 'insane' | 'auto'
// }
marketRouter.post('/prizepicks/ingest', async (req, res) => {
  const expected = process.env.SLATE_ADMIN_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'SLATE_ADMIN_SECRET not configured' });
    return;
  }
  if (req.header('x-admin-secret') !== expected) {
    res.status(401).json({ error: 'admin secret required' });
    return;
  }

  const body = (req.body ?? {}) as {
    raw?: unknown;
    sport?: MarketSport;
    publishSlate?: boolean;
    mode?: string;
  };
  if (!body.raw) {
    res.status(400).json({ error: 'body.raw required (PrizePicks JSON response)' });
    return;
  }
  const sport = (body.sport ?? 'mlb') as MarketSport;
  const publishSlate = body.publishSlate ?? true;
  const mode = body.mode ?? 'balanced';

  try {
    const props = (await import('../market/providers/prizepicksApi.js'))
      .prizepicksApiProvider.parse(body.raw);

    if (props.length === 0) {
      res.json({
        ok: true,
        sport,
        propsFetched: 0,
        snapshotsInserted: 0,
        slatePublished: false,
        message: 'PrizePicks response had 0 parseable projections.',
      });
      return;
    }

    let snapshotProps = props;
    let resolution = { resolvedPlayers: 0, resolvedTeams: 0, unresolvedPlayers: 0 };
    if (sport === 'mlb') {
      const enriched = await enrichToaSnapshots(snapshotProps, []);
      snapshotProps = enriched.props;
      resolution = {
        resolvedPlayers: enriched.resolvedPlayers,
        resolvedTeams: enriched.resolvedTeams,
        unresolvedPlayers: enriched.unresolvedPlayers,
      };
    }
    const writeRes = await writeMarketSnapshots(snapshotProps);

    let slatePublished = false;
    let slateLines = 0;
    if (publishSlate && sport === 'mlb' && isDbConfigured()) {
      const stored: MlbStoredDailyLine[] = [];
      for (const p of snapshotProps) {
        if (typeof p.internalPlayerId !== 'number') continue;
        const direction: 'over' | 'under' | 'both' =
          p.isDemon ? 'over' : p.isGoblin ? 'under' : 'both';
        stored.push({
          playerId: p.internalPlayerId,
          statKey: p.statKey as MlbStoredDailyLine['statKey'],
          line: p.line,
          direction,
        });
      }
      const dedup = new Map<string, MlbStoredDailyLine>();
      for (const l of stored) {
        const k = `${l.playerId}::${l.statKey}::${l.line}`;
        const ex = dedup.get(k);
        if (!ex || l.direction === 'both') dedup.set(k, l);
      }
      const finalLines = [...dedup.values()];
      if (finalLines.length > 0) {
        await setMlbDailySlateInDb({ lines: finalLines, rawText: null, mode });
        slatePublished = true;
        slateLines = finalLines.length;
      }
    }

    res.json({
      ok: true,
      sport,
      propsFetched: props.length,
      snapshotsInserted: writeRes.inserted,
      resolution,
      slatePublished,
      slateLines,
    });
  } catch (err) {
    console.error('prizepicks/ingest failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/market/prizepicks/sync (Vercel Cron only)
//
// GET wrapper for the POST sync endpoint. Used by Vercel Cron, which
// only supports GET. Cron requests carry an Authorization Bearer
// header with CRON_SECRET. We validate that header rather than the
// admin secret — Vercel Cron is the only legitimate caller of this
// endpoint shape, so SLATE_ADMIN_SECRET stays scoped to admin POSTs.
//
// Sport defaults to MLB. Override via ?sport=mlb|nba|wnba|mma so the
// same endpoint can be scheduled for multiple sports if needed.
marketRouter.get('/prizepicks/sync', async (req, res) => {
  // Vercel Cron auth: Bearer token in Authorization header.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(503).json({ error: 'CRON_SECRET not configured — set in Vercel env vars to enable cron' });
    return;
  }
  const authHeader = req.header('authorization') ?? '';
  if (authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'cron auth required' });
    return;
  }

  const sport = (req.query.sport as MarketSport | undefined) ?? 'mlb';
  const publishSlate = req.query.publishSlate !== 'false';      // default true
  const mode = (req.query.mode as string | undefined) ?? 'balanced';

  try {
    const fetched = await fetchPrizepicksProjections({ sport, perPage: 500 });
    if (fetched.props.length === 0) {
      res.json({
        ok: true, sport, propsFetched: 0, snapshotsInserted: 0, slatePublished: false,
      });
      return;
    }

    let snapshotProps = fetched.props;
    let resolution = { resolvedPlayers: 0, resolvedTeams: 0, unresolvedPlayers: 0 };
    if (sport === 'mlb') {
      const enriched = await enrichToaSnapshots(snapshotProps, []);
      snapshotProps = enriched.props;
      resolution = {
        resolvedPlayers: enriched.resolvedPlayers,
        resolvedTeams: enriched.resolvedTeams,
        unresolvedPlayers: enriched.unresolvedPlayers,
      };
    }
    const writeRes = await writeMarketSnapshots(snapshotProps);

    let slatePublished = false;
    let slateLines = 0;
    if (publishSlate && sport === 'mlb' && isDbConfigured()) {
      const stored: MlbStoredDailyLine[] = [];
      for (const p of snapshotProps) {
        if (typeof p.internalPlayerId !== 'number') continue;
        const direction: 'over' | 'under' | 'both' =
          p.isDemon ? 'over' : p.isGoblin ? 'under' : 'both';
        stored.push({
          playerId: p.internalPlayerId,
          statKey: p.statKey as MlbStoredDailyLine['statKey'],
          line: p.line,
          direction,
        });
      }
      const dedup = new Map<string, MlbStoredDailyLine>();
      for (const l of stored) {
        const k = `${l.playerId}::${l.statKey}::${l.line}`;
        const ex = dedup.get(k);
        if (!ex || l.direction === 'both') dedup.set(k, l);
      }
      const finalLines = [...dedup.values()];
      if (finalLines.length > 0) {
        await setMlbDailySlateInDb({ lines: finalLines, rawText: null, mode });
        slatePublished = true;
        slateLines = finalLines.length;
      }
    }

    res.json({
      ok: true, sport, fetchedAt: fetched.fetchedAt,
      propsFetched: fetched.props.length,
      snapshotsInserted: writeRes.inserted,
      resolution, slatePublished, slateLines,
    });
  } catch (err) {
    console.error('cron prizepicks/sync failed', err);
    res.status(502).json({ error: (err as Error).message });
  }
});

marketRouter.get('/snapshots/recent', async (req, res) => {
  try {
    const hours = req.query.hours ? Math.max(1, Math.min(168, Number(req.query.hours))) : 24;
    const limit = req.query.limit ? Math.max(1, Math.min(2000, Number(req.query.limit))) : 500;
    const sport = (req.query.sport as MarketSport | undefined) ?? undefined;
    const bookmaker = (req.query.bookmaker as Bookmaker | undefined) ?? undefined;
    const source = (req.query.source as ProviderSource | undefined) ?? undefined;
    const rows = await listRecentSnapshots({ hours, sport, bookmaker, source, limit });
    res.json({
      count: rows.length,
      filters: { hours, sport: sport ?? null, bookmaker: bookmaker ?? null, source: source ?? null, limit },
      snapshots: rows.map((r) => ({
        id: r.id,
        capturedAt: r.captured_at.toISOString(),
        providerSource: r.provider_source,
        bookmaker: r.bookmaker,
        sport: r.sport,
        gameDate: r.game_date.toISOString().slice(0, 10),
        playerName: r.raw_player_name,
        internalPlayerId: r.internal_player_id,
        team: r.team,
        statKey: r.stat_key,
        line: Number(r.line_value),
        direction: r.direction,
        americanOdds: r.american_odds === null ? null : Number(r.american_odds),
        impliedProbability: r.implied_probability === null ? null : Number(r.implied_probability),
      })),
    });
  } catch (err) {
    console.error('market/snapshots/recent failed', err);
    res.status(500).json({ error: 'market snapshots query failed' });
  }
});
