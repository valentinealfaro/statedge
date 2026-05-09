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
