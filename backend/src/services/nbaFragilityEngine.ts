// NBA fragility engine — sister to mlbFragilityEngine.ts.
//
// Per the StatEdge MLB Intelligence Engine spec L5:
//   "Fragility measures how little must go wrong for the pick to fail.
//    SEPARATE from probability."
//
// MLB version was Phase 15. Bringing the same dimension to NBA so
// users see "75% prob 3PM 2.5" doesn't read identical to "75% prob
// PRA 32.5" — the failure modes are very different.
//
// NBA-specific component swap from MLB:
//   - "lineupUncertainty" → "minutesUncertainty" (NBA equivalent
//     risk is a player getting a DNP / blowout-bench cap / role drop).
//
// Pure module — no DB. Inputs come from data the projection engine
// already computes.

import type { Last10StatId } from './last10.js';

// ----- Stat-rarity table -----
//
// 0..100, where 100 = single-event stats (one swing decides it).
// Matched to the NBA stat universe rather than ported from MLB.
const STAT_RARITY: Partial<Record<Last10StatId, number>> = {
  // Volume / counting stats — many opportunities per game.
  points:              35,
  rebounds:            40,
  assists:             45,
  fg_made:             35,
  fg_attempted:        30,
  defensive_rebounds:  35,
  pra:                 30,
  pr:                  35,
  pa:                  35,
  ra:                  40,
  // Combined or moderately-rare stats.
  ft_made:             50,
  ft_attempted:        50,
  three_pt_made:       70,    // one swing decides
  // Personal-fouls is volatile (DPOY can pile up; foul trouble is fluky).
  personal_fouls:      55,
  turnovers:           55,
  // Genuinely rare events.
  offensive_rebounds:  70,
  steals:              75,
  blocks:              80,
  stocks:              70,    // stl + blk combined still rare
  // Boolean / rare composite.
  double_double:       80,
};

const W = {
  statRarity:           0.30,
  marginThinness:       0.25,
  sampleWeakness:       0.20,
  volatility:           0.15,
  minutesUncertainty:   0.10,
} as const;

export type NbaFragilityInputs = {
  statKey: Last10StatId;
  projection: number;
  line: number;
  stddev: number;
  // Last-10 sample fill (0..10). Lower = more fragile baseline.
  last10Size: number;
  // Player's projected minutes for tonight (from lineup tools / minutes
  // model). null when unknown — treated as moderate fragility.
  projectedMinutes: number | null;
};

export type NbaFragilityTier =
  | 'Solid Floor'
  | 'Moderate Fragility'
  | 'Fragile'
  | 'Very Fragile';

export type NbaFragilityResult = {
  fragility: number;
  tier: NbaFragilityTier;
  components: {
    statRarity: number;
    marginThinness: number;
    sampleWeakness: number;
    volatility: number;
    minutesUncertainty: number | null;
  };
};

// ----- Component scoring -----

function statRarityComponent(statKey: Last10StatId): number {
  return STAT_RARITY[statKey] ?? 50;
}

function marginThinnessComponent(projection: number, line: number): number {
  const denom = Math.max(0.5, Math.max(Math.abs(projection), Math.abs(line)));
  const gap = Math.abs(projection - line) / denom;
  const thinness = 100 * (1 - Math.min(1, gap / 0.5));
  return Math.max(0, Math.min(100, thinness));
}

function sampleWeaknessComponent(last10Size: number): number {
  return Math.max(0, Math.min(100, (1 - last10Size / 10) * 100));
}

function volatilityComponent(stddev: number, projection: number): number {
  const denom = Math.max(1, Math.abs(projection));
  const cv = stddev / denom;
  return Math.max(0, Math.min(100, cv * 100));
}

// Minutes uncertainty replaces MLB's lineupUncertainty:
//   ≥ 30 mins projected → 0 (guaranteed role)
//   25-30 → 25
//   20-25 → 50
//   < 20 → 80 (rotation player risk)
//   null → 60 (unknown role)
function minutesUncertaintyComponent(projectedMinutes: number | null): number {
  if (projectedMinutes === null) return 60;
  if (projectedMinutes >= 30) return 0;
  if (projectedMinutes >= 25) return 25;
  if (projectedMinutes >= 20) return 50;
  return 80;
}

// ----- Tier banding (matches MLB so the UI legend is consistent) -----

export function nbaFragilityTier(score: number): NbaFragilityTier {
  if (score <= 25) return 'Solid Floor';
  if (score <= 50) return 'Moderate Fragility';
  if (score <= 75) return 'Fragile';
  return 'Very Fragile';
}

// ----- Public entry -----

export function computeNbaFragility(inputs: NbaFragilityInputs): NbaFragilityResult {
  const statRarity         = statRarityComponent(inputs.statKey);
  const marginThinness     = marginThinnessComponent(inputs.projection, inputs.line);
  const sampleWeakness     = sampleWeaknessComponent(inputs.last10Size);
  const volatility         = volatilityComponent(inputs.stddev, inputs.projection);
  const minutesUncertainty = minutesUncertaintyComponent(inputs.projectedMinutes);

  const fragility =
    statRarity         * W.statRarity
    + marginThinness   * W.marginThinness
    + sampleWeakness   * W.sampleWeakness
    + volatility       * W.volatility
    + minutesUncertainty * W.minutesUncertainty;

  return {
    fragility: Math.round(fragility * 10) / 10,
    tier: nbaFragilityTier(fragility),
    components: {
      statRarity,
      marginThinness:     Math.round(marginThinness * 10) / 10,
      sampleWeakness:     Math.round(sampleWeakness * 10) / 10,
      volatility:         Math.round(volatility * 10) / 10,
      minutesUncertainty: Math.round(minutesUncertainty * 10) / 10,
    },
  };
}
