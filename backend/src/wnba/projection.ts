// WNBA projection helper — Phase 77 v1. Uses ESPN gamelog data to
// project each WNBA prop (player + stat + line + direction) into the
// same shape MLB/NBA slate engines consume:
//   { projection, probability, edgePercent, fragility, momentum, ... }
//
// Lighter than NBA's full L1-L10 projection engine (which reads from
// a persisted player_game_logs DB) — this version computes everything
// on the fly from ESPN gamelogs we cache for 5min. The original plan
// was to port the institutional engine in Phase 77b once the WNBA
// player-stats sync workflow existed; per the 2026-05-09 sport-
// priorities decision (MMA replaced WNBA as the third focus sport)
// this engine stays at v1 and the deeper port isn't being scoped.

import {
  computeMarketIntel,
  type EdgeDurability,
  type PublicBiasTag,
} from '../services/marketIntel.js';
import { fetchWnbaPlayerGameLog, type WnbaGameLogEntry } from './espn.js';

// Stat-key → game-log accessor. Keep in sync with the slate parser's
// allowed stat vocabulary on the frontend.
const STAT_PICKERS: Record<string, (g: WnbaGameLogEntry) => number> = {
  points:         (g) => g.points,
  rebounds:       (g) => g.rebounds,
  assists:        (g) => g.assists,
  three_pt_made:  (g) => g.threePtMade,
  steals:         (g) => g.steals,
  blocks:         (g) => g.blocks,
  turnovers:      (g) => g.turnovers,
  fg_made:        (g) => g.fgMade,
  fg_attempted:   (g) => g.fgAttempted,
  ft_made:        (g) => g.ftMade,
  ft_attempted:   (g) => g.ftAttempted,
  personal_fouls: (g) => g.fouls,
  pra:            (g) => g.points + g.rebounds + g.assists,
  pr:             (g) => g.points + g.rebounds,
  pa:             (g) => g.points + g.assists,
  ra:             (g) => g.rebounds + g.assists,
  stocks:         (g) => g.steals + g.blocks,
};

const STAT_LABELS: Record<string, string> = {
  points:         'Points',
  rebounds:       'Rebounds',
  assists:        'Assists',
  three_pt_made:  '3PT Made',
  steals:         'Steals',
  blocks:         'Blocks',
  turnovers:      'Turnovers',
  fg_made:        'FG Made',
  fg_attempted:   'FG Attempted',
  ft_made:        'FT Made',
  ft_attempted:   'FT Attempted',
  personal_fouls: 'Personal Fouls',
  pra:            'P+R+A',
  pr:             'P+R',
  pa:             'P+A',
  ra:             'R+A',
  stocks:         'STL+BLK',
};

export type ProjectedWnbaLine = {
  athleteId: string;
  playerName: string;
  team: string | null;
  statKey: string;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  // Headline outputs
  projection: number;        // weighted L5/L10/season blend
  probability: number;       // 0-100, our model's hit prob for `direction`
  edgePercent: number;       // probability − implied (assumed 50% baseline)
  // Component intelligence
  l5Avg: number;
  l10Avg: number;
  seasonAvg: number;
  l10HitRate: number;        // hit rate of strict > line in L10
  l10HitCount: number;
  trapScore: number;         // 0-100; high = recent spike vs season
  fragilityScore: number;    // 0-100; high = thin sample or volatile
  momentumScore: number;     // 0-100; high = L5 well above season
  reasonCodes: string[];
  // Phase 101 — Market Intelligence Engine. See marketIntel.ts.
  marketImpliedProb: number;
  lineInflationScore: number;
  publicBiasTags: PublicBiasTag[];
  sharpnessScore: number;
  edgeDurability: EdgeDurability;
  whyMarketWrong: string | null;
};

const DEFAULT_IMPLIED_PROB = 50;     // assume even market for now

export function listWnbaStatKeys(): Array<{ key: string; label: string }> {
  return Object.keys(STAT_PICKERS).map((key) => ({ key, label: STAT_LABELS[key] ?? key }));
}

export function isValidWnbaStatKey(key: string): boolean {
  return key in STAT_PICKERS;
}

export async function projectWnbaLine(
  athleteId: string,
  playerName: string,
  team: string | null,
  statKey: string,
  line: number,
  direction: 'OVER' | 'UNDER',
): Promise<ProjectedWnbaLine | null> {
  const picker = STAT_PICKERS[statKey];
  if (!picker) return null;
  const games = await fetchWnbaPlayerGameLog(athleteId).catch(() => [] as WnbaGameLogEntry[]);
  if (games.length === 0) {
    return {
      athleteId, playerName, team, statKey,
      statLabel: STAT_LABELS[statKey] ?? statKey,
      line, direction,
      projection: 0, probability: 0, edgePercent: -DEFAULT_IMPLIED_PROB,
      l5Avg: 0, l10Avg: 0, seasonAvg: 0,
      l10HitRate: 0, l10HitCount: 0,
      trapScore: 0, fragilityScore: 80, momentumScore: 50,
      reasonCodes: ['No gamelog data — player may be inactive or pre-season.'],
      // Phase 101 — neutral defaults for empty projection.
      marketImpliedProb: 50,
      lineInflationScore: 0,
      publicBiasTags: [],
      sharpnessScore: 0,
      edgeDurability: 'fragile',
      whyMarketWrong: null,
    };
  }

  const last10 = games.slice(0, 10).map(picker);
  const last5 = games.slice(0, 5).map(picker);
  const season = games.map(picker);

  const avg = (vs: number[]): number => vs.length === 0 ? 0 : vs.reduce((s, v) => s + v, 0) / vs.length;
  const variance = (vs: number[]): number => {
    if (vs.length < 2) return 0;
    const m = avg(vs);
    return avg(vs.map((v) => (v - m) ** 2));
  };

  const l5Avg = avg(last5);
  const l10Avg = avg(last10);
  const seasonAvg = avg(season);

  // Projection: weighted blend favoring recent form. 60% L5, 25% L10, 15% season.
  const projection = 0.60 * l5Avg + 0.25 * l10Avg + 0.15 * seasonAvg;

  // Hit probability from L10 frequency, Bayesian-smoothed against a
  // 0.5 prior (3 pseudo-games of 50% so a 0/3 sample doesn't claim 0%).
  const overCount = last10.filter((v) => v > line).length;
  const overRate = (overCount + 1.5) / (last10.length + 3);
  const probOver = Math.max(2, Math.min(98, Math.round(overRate * 1000) / 10));
  const probability = direction === 'OVER' ? probOver : Math.round((100 - probOver) * 10) / 10;

  // Edge vs implied (market not yet integrated — assume 50%).
  const edgePercent = Math.round((probability - DEFAULT_IMPLIED_PROB) * 10) / 10;

  // Fragility = volatility + sample-thinness penalty.
  const v = variance(last10);
  const cv = seasonAvg > 0 ? Math.sqrt(v) / seasonAvg : 1;
  const sampleThin = Math.max(0, 50 - last10.length * 5);   // 50 at n=0, 0 at n≥10
  const fragilityScore = Math.max(0, Math.min(100, Math.round(cv * 60 + sampleThin)));

  // Trap = recent spike vs season. If L5 is 30%+ above season avg AND
  // we're projecting OVER, that's a public-trap red flag.
  const lift = seasonAvg > 0 ? (l5Avg - seasonAvg) / seasonAvg : 0;
  const trapBase = lift > 0.30 && direction === 'OVER' ? Math.round(lift * 100) : 0;
  const trapScore = Math.max(0, Math.min(100, trapBase));

  // Momentum = L5 lift vs season, mapped 0-100. +30% lift → 100, -30% → 0.
  const momentumScore = Math.max(0, Math.min(100, Math.round(50 + lift * 100)));

  const reasonCodes: string[] = [];
  if (last10.length < 5) reasonCodes.push(`Thin sample: ${last10.length} games — low confidence.`);
  if (cv > 0.5) reasonCodes.push(`High volatility (CV ${cv.toFixed(2)}) — fragile projection.`);
  if (trapScore >= 30) reasonCodes.push(`Recent spike: L5 avg ${l5Avg.toFixed(1)} vs season ${seasonAvg.toFixed(1)} — possible public trap.`);
  if (momentumScore >= 70) reasonCodes.push(`Momentum: L5 averaging ${(lift * 100).toFixed(0)}% above season.`);

  // Phase 101 — Market Intelligence Engine.
  const intel = computeMarketIntel({
    probability,
    edgePercent,
    projection,
    line,
    seasonAvg,
    l5Avg,
    l10Avg,
    fragilityScore,
    trapScore,
    reasonCodes,
    direction,
    statKey,
  });

  return {
    athleteId, playerName, team, statKey,
    statLabel: STAT_LABELS[statKey] ?? statKey,
    line, direction,
    projection: Math.round(projection * 10) / 10,
    probability,
    edgePercent,
    l5Avg: Math.round(l5Avg * 10) / 10,
    l10Avg: Math.round(l10Avg * 10) / 10,
    seasonAvg: Math.round(seasonAvg * 10) / 10,
    l10HitRate: last10.length > 0 ? Math.round((overCount / last10.length) * 1000) / 10 : 0,
    l10HitCount: overCount,
    trapScore,
    fragilityScore,
    momentumScore,
    reasonCodes,
    marketImpliedProb: intel.marketImpliedProb,
    lineInflationScore: intel.lineInflationScore,
    publicBiasTags: intel.publicBiasTags,
    sharpnessScore: intel.sharpnessScore,
    edgeDurability: intel.edgeDurability,
    whyMarketWrong: intel.whyMarketWrong,
  };
}
