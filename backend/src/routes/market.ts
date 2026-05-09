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
import {
  getSnapshotsHealth,
  listRecentSnapshots,
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
