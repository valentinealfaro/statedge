// Cross-sport calibration aggregator — Phase 114.
//
// CLV measures whether we beat the market (process accuracy).
// Calibration measures whether our probabilities are honest:
// when we say 70%, do players actually hit 71%? It's the second
// pillar of the truth metric. This route aggregates per-sport
// calibration reports into a single cross-sport view that powers
// the /calibration audit page.
//
// Per-sport detail is preserved so the UI can drill down by sport.

import { Router } from 'express';
import { getPool, isDbConfigured } from '../db.js';
import { computeMlbCalibration } from '../services/mlbCalibration.js';
import { computeWnbaCalibration } from '../wnba/projectionHistory.js';

export const calibrationRouter: Router = Router();

export type CrossSportProbabilityBucket = {
  label: string;
  predictedAverage: number;
  observedHitRate: number;
  graded: number;
  hits: number;
  // Per-sport contribution so the audit UI can see which sport is
  // pulling each bucket.
  bySport: Array<{
    sport: string;
    predictedAverage: number;
    observedHitRate: number;
    graded: number;
    hits: number;
  }>;
};

export type CrossSportCalibration = {
  windowDays: number;
  totalGraded: number;
  totalHits: number;
  totalMisses: number;
  overallHitRate: number;
  averagePredicted: number;
  calibrationGap: number;       // observed - predicted; signed
  byProbability: CrossSportProbabilityBucket[];
  bySport: Array<{
    sport: string;
    totalGraded: number;
    overallHitRate: number;
    averagePredicted: number;
    calibrationGap: number;
  }>;
};

calibrationRouter.get('/summary', async (req, res) => {
  try {
    const windowDays = req.query.windowDays
      ? Math.max(1, Math.min(365, Number(req.query.windowDays)))
      : 30;

    const [mlb, wnba] = await Promise.all([
      computeMlbCalibration({ windowDays }),
      computeWnbaCalibration({ windowDays }),
    ]);

    // Sum totals
    const totalGraded = mlb.totalGraded + wnba.totalGraded;
    const totalHits = mlb.totalHits + wnba.totalHits;
    const totalMisses = mlb.totalMisses + wnba.totalMisses;
    const overallHitRate = totalGraded === 0 ? 0
      : Math.round((totalHits / totalGraded) * 1000) / 10;
    // Weighted-average predicted across sports (weight by graded count
    // so the cross-sport number reflects sample mix, not arithmetic mean).
    const averagePredicted = totalGraded === 0 ? 0
      : (mlb.averagePredicted * mlb.totalGraded + wnba.averagePredicted * wnba.totalGraded) / totalGraded;
    const calibrationGap = Math.round((overallHitRate - averagePredicted) * 10) / 10;

    // Merge probability buckets by label. Each bucket has the same
    // labels in MLB and WNBA so the union covers everything.
    const labels = new Set<string>([
      ...mlb.byProbability.map((b) => b.label),
      ...wnba.byProbability.map((b) => b.label),
    ]);
    const byProbability: CrossSportProbabilityBucket[] = [];
    // Order labels low→high. Same scheme MLB uses: <50%, 50-55%, ...
    const ordered = ['<50%', '50-55%', '55-60%', '60-65%', '65-70%', '70-75%', '75-80%', '80-85%', '85%+'];
    for (const label of ordered) {
      if (!labels.has(label)) continue;
      const mlbB = mlb.byProbability.find((b) => b.label === label);
      const wnbaB = wnba.byProbability.find((b) => b.label === label);
      const bySport: CrossSportProbabilityBucket['bySport'] = [];
      let combinedGraded = 0;
      let combinedHits = 0;
      let weightedPredicted = 0;
      if (mlbB && mlbB.graded > 0) {
        bySport.push({
          sport: 'mlb',
          predictedAverage: mlbB.predictedAverage,
          observedHitRate: mlbB.observedHitRate,
          graded: mlbB.graded,
          hits: mlbB.hits,
        });
        combinedGraded += mlbB.graded;
        combinedHits   += mlbB.hits;
        weightedPredicted += mlbB.predictedAverage * mlbB.graded;
      }
      if (wnbaB && wnbaB.graded > 0) {
        bySport.push({
          sport: 'wnba',
          predictedAverage: wnbaB.predictedAverage,
          observedHitRate: wnbaB.observedHitRate,
          graded: wnbaB.graded,
          hits: wnbaB.hits,
        });
        combinedGraded += wnbaB.graded;
        combinedHits   += wnbaB.hits;
        weightedPredicted += wnbaB.predictedAverage * wnbaB.graded;
      }
      if (combinedGraded === 0) continue;
      byProbability.push({
        label,
        predictedAverage: weightedPredicted / combinedGraded,
        observedHitRate: (combinedHits / combinedGraded) * 100,
        graded: combinedGraded,
        hits: combinedHits,
        bySport,
      });
    }

    res.json({
      windowDays,
      totalGraded,
      totalHits,
      totalMisses,
      overallHitRate,
      averagePredicted: Math.round(averagePredicted * 10) / 10,
      calibrationGap,
      byProbability,
      bySport: [
        {
          sport: 'mlb',
          totalGraded: mlb.totalGraded,
          overallHitRate: mlb.overallHitRate,
          averagePredicted: mlb.averagePredicted,
          calibrationGap: mlb.calibrationGap,
        },
        {
          sport: 'wnba',
          totalGraded: wnba.totalGraded,
          overallHitRate: wnba.overallHitRate,
          averagePredicted: wnba.averagePredicted,
          calibrationGap: wnba.calibrationGap,
        },
      ].filter((s) => s.totalGraded > 0),
    } satisfies CrossSportCalibration);
  } catch (err) {
    console.error('calibration/summary failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/calibration/recent?limit=25&windowDays=30
//
// Cross-sport recent graded projections for the calibration audit
// page. Different from /api/market/clv/recent-props (which surfaces
// "did we beat the close" — process accuracy). This shows "did we
// get the probability right" — model accuracy. Each row carries the
// predicted probability and the binary hit/miss verdict. Pushes
// (hit_or_miss IS NULL) are excluded — they're not hits or misses.
calibrationRouter.get('/recent', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      res.json({ rows: [], count: 0 });
      return;
    }
    const limit = req.query.limit
      ? Math.max(1, Math.min(100, Number(req.query.limit)))
      : 25;
    const windowDays = req.query.windowDays
      ? Math.max(1, Math.min(365, Number(req.query.windowDays)))
      : 30;

    const pool = getPool();
    // UNION ALL across the two sports' projection_history tables.
    // Each side projects to the common shape; we sort + cap in JS
    // for simplicity (limit at most 100 each before merge keeps the
    // query light).
    const [mlbRows, wnbaRows] = await Promise.all([
      pool.query<{
        game_date: Date;
        player_id: number;
        player_name: string | null;
        team: string | null;
        stat_key: string;
        direction: string;
        line_value: string;
        probability: string;
        result_value: string | null;
        hit_or_miss: boolean;
        graded_at: Date | null;
      }>(`
        SELECT h.game_date, h.player_id, p.full_name AS player_name, NULL::text AS team,
               h.selected_stat AS stat_key, h.direction, h.line_value::text,
               h.probability::text,
               h.result_value::text, h.hit_or_miss, h.graded_at
          FROM mlb_projection_history h
     LEFT JOIN mlb_players p ON p.player_id = h.player_id
         WHERE h.hit_or_miss IS NOT NULL
           AND h.game_date >= (CURRENT_DATE - $1::int)
         ORDER BY h.game_date DESC, h.id DESC
         LIMIT 100
      `, [windowDays]).catch(() => ({ rows: [] })),
      pool.query<{
        game_date: Date;
        athlete_id: string;
        player_name: string;
        team: string | null;
        stat_key: string;
        direction: string;
        line_value: string;
        probability: string;
        result_value: string | null;
        hit_or_miss: boolean;
        graded_at: Date | null;
      }>(`
        SELECT game_date, athlete_id, player_name, team,
               stat_key, direction, line_value::text,
               probability::text, result_value::text, hit_or_miss, graded_at
          FROM wnba_projection_history
         WHERE hit_or_miss IS NOT NULL
           AND game_date >= (CURRENT_DATE - $1::int)
         ORDER BY game_date DESC, id DESC
         LIMIT 100
      `, [windowDays]).catch(() => ({ rows: [] })),
    ]);

    const merged = [
      ...mlbRows.rows.map((r) => ({
        sport: 'mlb' as const,
        gameDate: r.game_date.toISOString().slice(0, 10),
        playerId: String(r.player_id),
        playerName: r.player_name ?? `Player ${r.player_id}`,
        team: r.team,
        statKey: r.stat_key,
        direction: r.direction === 'UNDER' ? 'UNDER' : 'OVER',
        lineValue: Number(r.line_value),
        probability: Number(r.probability),
        resultValue: r.result_value !== null ? Number(r.result_value) : null,
        hitOrMiss: r.hit_or_miss,
        gradedAt: r.graded_at ? r.graded_at.toISOString() : null,
      })),
      ...wnbaRows.rows.map((r) => ({
        sport: 'wnba' as const,
        gameDate: r.game_date.toISOString().slice(0, 10),
        playerId: r.athlete_id,
        playerName: r.player_name,
        team: r.team,
        statKey: r.stat_key,
        direction: r.direction === 'UNDER' ? 'UNDER' : 'OVER',
        lineValue: Number(r.line_value),
        probability: Number(r.probability),
        resultValue: r.result_value !== null ? Number(r.result_value) : null,
        hitOrMiss: r.hit_or_miss,
        gradedAt: r.graded_at ? r.graded_at.toISOString() : null,
      })),
    ];
    merged.sort((a, b) => {
      // gradedAt DESC (most-recently-graded first), then gameDate as tiebreaker
      const ag = a.gradedAt ?? a.gameDate;
      const bg = b.gradedAt ?? b.gameDate;
      return bg.localeCompare(ag);
    });
    const top = merged.slice(0, limit);

    res.json({ rows: top, count: top.length, windowDays });
  } catch (err) {
    console.error('calibration/recent failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});
