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
import { computeMlbClv, computeWnbaClv } from '../market/clv.js';
import { getBudgetStatus } from '../market/creditBudget.js';
import {
  fetchToaEventOdds,
  fetchToaEvents,
  theOddsApiProvider,
} from '../market/providers/theOddsApi.js';
import {
  getSnapshotsHealth,
  listRecentSnapshots,
  writeMarketSnapshots,
} from '../market/snapshots.js';
import type { Bookmaker, MarketSport, ProviderSource } from '../market/types.js';

export const marketRouter: Router = Router();

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

    // Step 3: parse + persist.
    const props = theOddsApiProvider.parse(oddsRes.data);
    const writeRes = await writeMarketSnapshots(props);

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
      // First 3 props for visual confirmation. Don't dump everything.
      sample: props.slice(0, 3),
      budgetAfter: await getBudgetStatus('the_odds_api', 'ODDS_API_MONTHLY_CREDITS'),
    });
  } catch (err) {
    console.error('odds-api/test failed', err);
    res.status(500).json({ error: (err as Error).message });
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
