// Layer 5 — Fragility Intelligence (separate from trap, separate from
// probability).
//
// Per the StatEdge MLB Intelligence Engine spec:
//
//   "Fragility measures: how little must go wrong for the pick to fail.
//    Examples: home run props, fragile RBI props, walk-dependent props,
//    small-margin projections.
//    Fragility is SEPARATE from probability."
//
// A 75% probability HR prop and a 75% probability hits-1.5 prop look
// identical on the probability dial, but their failure modes are
// wildly different — one bad swing vs one bad week. Fragility makes
// that visible.
//
// Pure module — no DB, no MLB API. Inputs come from data the engine
// already has when it computes a projection.

import type { MlbStatKey } from '../mlb/stats.js';
import { STAT_TYPE_RISK } from './mlbProjectionEngine.js';

// ----- Component weights (sum to 1.0) -----
//
// The formula blends five orthogonal signals:
//
//   statRarity         0.30  Rare events (HR, SB, triples) are inherently
//                            fragile — one bad swing decides the outcome.
//   marginThinness     0.25  |projection - line| / max(projection, line).
//                            A projection of 1.7 vs line 1.5 is fragile;
//                            a projection of 3.5 vs line 1.5 is not.
//   sampleWeakness     0.20  Inverse of Bayesian sampleStrength. Players
//                            below stabilization threshold are fragile
//                            because the projection itself is uncertain.
//   volatility         0.15  L10 stddev / |projection|. High coefficient
//                            of variation = fragile.
//   lineupUncertainty  0.10  Unconfirmed lineup or non-typical batting
//                            spot adds fragility for hitters; null for
//                            pitchers.
const W = {
  statRarity:        0.30,
  marginThinness:    0.25,
  sampleWeakness:    0.20,
  volatility:        0.15,
  lineupUncertainty: 0.10,
} as const;

export type FragilityInputs = {
  statKey: MlbStatKey;
  playerType: 'hitter' | 'pitcher';
  projection: number;
  line: number;
  stddev: number;                  // L10 stddev (engine already has this)
  // Bayesian sampleStrength from the L1 baseline engine. 1.0 = full
  // sample (above stabilization threshold), 0 = no data. null when the
  // engine took the legacy fallback path.
  sampleStrength: number | null;
  // Whether the player's spot in tonight's lineup was confirmed (i.e.
  // we have a real lineupSpot from the MLB API, not a guess). null
  // for pitchers.
  lineupConfirmed: boolean | null;
};

export type FragilityResult = {
  fragility: number;               // 0..100
  tier: FragilityTier;
  components: {
    statRarity: number;
    marginThinness: number;
    sampleWeakness: number;
    volatility: number;
    lineupUncertainty: number | null;     // null for pitchers
  };
};

export type FragilityTier =
  | 'Solid Floor'
  | 'Moderate Fragility'
  | 'Fragile'
  | 'Very Fragile';

// ----- Component scoring (each returns 0..100) -----

// Maps STAT_TYPE_RISK directly. Already a 0..100 scale where rare
// events score high (HR=85, SB=90, triples=90). Counting stats with
// many at-bats (hits=45, pitcher_outs=35) score low.
function statRarityComponent(statKey: MlbStatKey): number {
  return STAT_TYPE_RISK[statKey];
}

// Margin thinness: 100 = projection sits right on the line; 0 =
// projection is 50%+ separated. Uses max(projection, line) as the
// denominator so a tiny line (0.5) doesn't blow up small absolute
// gaps.
function marginThinnessComponent(projection: number, line: number): number {
  const denom = Math.max(0.5, Math.max(Math.abs(projection), Math.abs(line)));
  const gap = Math.abs(projection - line) / denom;
  // 0% gap → 100 thinness; 50% gap → 0 thinness; clamp.
  const thinness = 100 * (1 - Math.min(1, gap / 0.5));
  return Math.max(0, Math.min(100, thinness));
}

// Sample weakness: inverse of Bayesian sampleStrength. Players below
// stabilization threshold score high. null sampleStrength → 50
// (neutral; we don't punish or reward when we don't know).
function sampleWeaknessComponent(sampleStrength: number | null): number {
  if (sampleStrength === null) return 50;
  return Math.max(0, Math.min(100, (1 - sampleStrength) * 100));
}

// Volatility: L10 stddev / projection (coefficient of variation).
// CV ≥ 1.0 (stddev as large as the projection itself) → 100. Tiny
// projections (rare events near zero) get a floor on the denom so
// they don't artificially inflate volatility.
function volatilityComponent(stddev: number, projection: number): number {
  const denom = Math.max(0.5, Math.abs(projection));
  const cv = stddev / denom;
  return Math.max(0, Math.min(100, cv * 100));
}

// Lineup uncertainty: confirmed → 0 (no fragility added);
// unconfirmed/unknown → 60 (meaningful but not catastrophic).
// null for pitchers; the caller drops this component entirely.
function lineupUncertaintyComponent(
  lineupConfirmed: boolean | null,
  playerType: 'hitter' | 'pitcher',
): number | null {
  if (playerType === 'pitcher') return null;
  if (lineupConfirmed === true) return 0;
  return 60;
}

// ----- Tier mapping -----

export function fragilityTier(score: number): FragilityTier {
  if (score <= 25) return 'Solid Floor';
  if (score <= 50) return 'Moderate Fragility';
  if (score <= 75) return 'Fragile';
  return 'Very Fragile';
}

// ----- Public entry -----

export function computeFragility(inputs: FragilityInputs): FragilityResult {
  const statRarity     = statRarityComponent(inputs.statKey);
  const marginThinness = marginThinnessComponent(inputs.projection, inputs.line);
  const sampleWeakness = sampleWeaknessComponent(inputs.sampleStrength);
  const volatility     = volatilityComponent(inputs.stddev, inputs.projection);
  const lineupUncertainty = lineupUncertaintyComponent(
    inputs.lineupConfirmed, inputs.playerType,
  );

  // Renormalize when a component is null (currently only lineup for
  // pitchers).
  const parts: Array<{ value: number; weight: number }> = [
    { value: statRarity,     weight: W.statRarity },
    { value: marginThinness, weight: W.marginThinness },
    { value: sampleWeakness, weight: W.sampleWeakness },
    { value: volatility,     weight: W.volatility },
  ];
  if (lineupUncertainty !== null) {
    parts.push({ value: lineupUncertainty, weight: W.lineupUncertainty });
  }
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const fragility =
    totalWeight === 0
      ? 50
      : parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;

  return {
    fragility: Math.round(fragility * 10) / 10,
    tier: fragilityTier(fragility),
    components: {
      statRarity,
      marginThinness: Math.round(marginThinness * 10) / 10,
      sampleWeakness: Math.round(sampleWeakness * 10) / 10,
      volatility:     Math.round(volatility * 10) / 10,
      lineupUncertainty: lineupUncertainty !== null
        ? Math.round(lineupUncertainty * 10) / 10
        : null,
    },
  };
}
