// MLB Wild Card builder — Phase 6.
//
// One extra card slot per slate, classified into one of five tiers
// based on what kind of edge fired (or didn't). Mirrors the NBA
// philosophy validated by the 2026-05-07 6-of-6 cash:
//   "Wild Card = controlled market-inefficiency portfolio,
//    NOT random high-risk lottery."
//
// Tier priority chain (first matching tier wins):
//
//   1. Standard         — passes both historical gates: L10 hit rate
//                         ≥ 50% in chosen direction + ≥1 hit vs the
//                         current opponent + projection materially
//                         above line + trap not extreme.
//   2. Near Miss        — borderline on the strict gate (hit rate
//                         40-50% OR 0 vs-opp games but otherwise OK).
//   3. Momentum         — L5 average ≥ 1.15× season + minutes/lineup
//                         supports more PA. The NBA-validated path.
//   4. Matchup Spike    — strong vs-opponent average + projection
//                         exceeds line by ≥ 0.5σ.
//   5. High Variance    — projection sits ≥1σ from line + trap < 60.
//                         The lottery-ish ceiling pick.
//
// Falls through to:
//   6. No Edge          — top-3 closest candidates by projection
//                         distance score, with explicit transparency
//                         copy ("No Wild Card Available Tonight").
//
// Mission alignment:
//   - Never blank: even no-edge slate gets the closest-candidate view
//   - Never trash: hard gates prevent forced bad picks
//   - Transparent: every leg carries a wildCardReason string

import type {
  ResolvedMlbLine,
  WildCardSignals,
} from './mlbSlatePipeline.js';
import {
  computeCorrelationRisk,
  type MlbComboCorrelationRisk,
  type MlbComboLeg,
} from './mlbSlateBuilder.js';

export type MlbWildCardKind =
  | 'standard'
  | 'near_miss'
  | 'momentum'
  | 'matchup_spike'
  | 'high_variance'
  | 'no_edge';

export type MlbWildCardCombo = {
  label: 'Wild Card';
  kind: MlbWildCardKind;
  subtitle: string;
  legs: Array<MlbComboLeg & { wildCardReason: string }>;
  rawCombinedHit: number;
  adjustedCombinedHit: number;
  correlationRisk: MlbComboCorrelationRisk;
  correlationPairs: number;
  averageEdge: number;
  averageTrap: number;
  // Phase 29: average wildCardScore across the picks. ≥60 = real
  // institutional edge. ≤40 = pool was thin even though tier
  // qualified. Lets users compare night-to-night Wild Card quality.
  averageWildCardScore?: number;
  closestCandidates?: Array<MlbComboLeg & { wildCardReason: string }>;
};

const TARGET_LEGS = 6;
const MIN_LEGS = 3;

// ---------- Tier predicates ----------

// Standard: passes the strict gates per spec.
function isStandardEligible(line: ResolvedMlbLine): boolean {
  const s = line.signals;
  const p = line.projection;
  // Historical hit rate gate. last10HitRate is the player's L10 hit
  // rate AT THIS LINE in the queried direction. ≥50% means they've
  // covered more than half their last 10 games at this line.
  if (s.last10HitRate === null) return false;
  if (s.last10HitRate < 50) return false;
  // Vs-opponent presence: at least one historical game vs the
  // current opponent gives us baseline matchup signal. We don't
  // require a "hit" because we don't have per-game vs-opp values
  // surfaced; opponentGames ≥ 1 is a softer but valid gate.
  if (s.opponentGames < 1) return false;
  // Projection materially above line — keeps thin-margin picks out.
  if (p.projectionDistanceScore < 50) return false;
  // Trap not extreme.
  if (p.trapScore > 60) return false;
  return true;
}

// Near Miss: barely missed the strict gate. Either L10 hit rate
// 40-50% or zero vs-opp games (but otherwise solid).
function isNearMissEligible(line: ResolvedMlbLine): boolean {
  const s = line.signals;
  const p = line.projection;
  if (p.trapScore > 65) return false;
  if (p.projectionDistanceScore < 40) return false;
  if (s.last10HitRate === null) return false;
  // Borderline historical gate
  if (s.last10HitRate >= 40 && s.last10HitRate < 50) return true;
  if (s.opponentGames === 0 && s.last10HitRate >= 50) return true;
  return false;
}

// Momentum: L5 trending fast above season. Inverse for UNDER picks
// (player cooling off → momentum is a downward-trend signal).
function isMomentumEligible(line: ResolvedMlbLine): boolean {
  const s = line.signals;
  const p = line.projection;
  if (p.trapScore > 60) return false;
  if (s.l5VsSeasonDelta === null || s.last5Average === null) return false;
  if (s.last10Average === 0) return false;
  // Direction-aware threshold. For OVER picks, L5 should be
  // meaningfully above L10 baseline; for UNDER, meaningfully below.
  const ratio = s.last5Average / Math.max(0.1, s.last10Average);
  if (line.modelDirection === 'OVER') {
    return ratio >= 1.15;        // 15%+ above L10 average
  }
  return ratio <= 0.85;           // 15%+ below for UNDER
}

// Matchup Spike: opponent average meaningfully different from baseline
// + projection above line. Direction-aware (good matchup for OVER =
// player has hit this opponent above their season; bad matchup for
// UNDER = same).
function isMatchupSpikeEligible(line: ResolvedMlbLine): boolean {
  const s = line.signals;
  const p = line.projection;
  if (p.trapScore > 60) return false;
  if (p.projectionDistanceScore < 30) return false;
  if (s.opponentVsSeasonDelta === null) return false;
  if (s.opponentGames < 2) return false;
  if (line.modelDirection === 'OVER') {
    return s.opponentVsSeasonDelta >= 0.5;
  }
  return s.opponentVsSeasonDelta <= -0.5;
}

// High Variance: huge projection separation but accept high risk.
// The "ceiling" archetype.
function isHighVarianceEligible(line: ResolvedMlbLine): boolean {
  const p = line.projection;
  if (p.trapScore > 70) return false;     // even high-variance has trap ceiling
  if (p.projectionDistanceScore < 75) return false;
  return true;
}

// ---------- Reason strings ----------

function reasonFor(kind: MlbWildCardKind, line: ResolvedMlbLine): string {
  const s = line.signals;
  switch (kind) {
    case 'standard': {
      const hits = s.last10HitCount ?? 0;
      return `Hit ${hits} of last 10 at this line · ${s.opponentGames} game(s) vs opponent.`;
    }
    case 'near_miss': {
      if (s.last10HitRate !== null && s.last10HitRate >= 40 && s.last10HitRate < 50) {
        return `Borderline ${s.last10HitRate.toFixed(0)}% L10 hit rate — strong but just shy of standard.`;
      }
      return `No vs-opp history yet, but ${s.last10HitRate?.toFixed(0) ?? '—'}% L10 hit rate carries the leg.`;
    }
    case 'momentum': {
      const l5 = s.last5Average?.toFixed(2) ?? '?';
      const l10 = s.last10Average.toFixed(2);
      const dir = line.modelDirection === 'OVER' ? 'rising' : 'cooling';
      return `L5 ${l5} vs L10 ${l10} — momentum ${dir} fast.`;
    }
    case 'matchup_spike': {
      const delta = s.opponentVsSeasonDelta?.toFixed(2) ?? '?';
      const sign = (s.opponentVsSeasonDelta ?? 0) >= 0 ? 'beats' : 'underperforms vs';
      return `Player ${sign} this opponent by ${Math.abs(Number(delta)).toFixed(2)} (${s.opponentGames} games).`;
    }
    case 'high_variance': {
      return `Projection sits ≥1σ from line — high ceiling, accept variance.`;
    }
    case 'no_edge': {
      return `Closest candidate by projection separation — no Wild Card-grade edge tonight.`;
    }
  }
}

const SUBTITLES: Record<MlbWildCardKind, string> = {
  standard: 'Higher Risk · meets historical Wild Card gates',
  near_miss: 'Near Miss · barely shy of standard gates',
  momentum: 'Momentum · recent form trending fast',
  matchup_spike: 'Matchup Spike · opponent vulnerability',
  high_variance: 'High Variance · ceiling-driven, accept risk',
  no_edge: 'No Wild Card Available Tonight',
};

// ---------- Helpers ----------

// Wild Card score per the 2026-05-08 MLB Slate Engine spec.
//
//   wildCardScore =
//     projectionGap * 0.25
//     + momentumExpansion * 0.25
//     + matchupLeverage * 0.15
//     + marketLagScore * 0.15
//     + upsidePotential * 0.10
//     - trapScore * 0.10
//
// Replaces the prior projection-distance-only sort. Each component
// is normalized 0..100; trap deducts. Result: legs are ranked by
// "true Wild Card edge quality," not just raw separation.
//
// Phase 30 will add real marketLagScore values; for now it returns
// 0 (passes through the formula as a neutral) until that layer ships.
function computeWildCardScore(line: ResolvedMlbLine): number {
  const p = line.projection;
  const s = line.signals;
  const projectionGap = p.projectionDistanceScore;        // 0..100
  const momentumExpansion = s.momentumExpansionScore;     // 0..100
  // Matchup leverage: opponent-vs-season delta scaled. ≥0.5 hits
  // average → 100, ≤-0.5 → 0, scaled linearly. Direction-aware:
  // OVER picks like +delta; UNDER picks like -delta.
  const dir = line.modelDirection;
  const opp = s.opponentVsSeasonDelta ?? 0;
  const oppDirAdj = dir === 'OVER' ? opp : -opp;
  const matchupLeverage = Math.max(0, Math.min(100, 50 + oppDirAdj * 100));
  // Market lag: how far ahead the engine's context layers are
  // pointing relative to the bookmaker's static line. Each context
  // multiplier's direction-aware deviation from 1.0 contributes.
  // Spec: opportunityExpansion + roleChange + contextAcceleration
  // + environmentShift. Available context proxies them:
  //   weather + park + gameScript = environmentShift
  //   lineup + bvp = opportunityExpansion + roleChange
  //   ensemble deviation = contextAcceleration
  const lagPctOf = (mult: number) => {
    const helps = dir === 'OVER' ? mult > 1.0 : mult < 1.0;
    if (!helps) return 0;
    return Math.abs(mult - 1.0) * 100;     // % shift in player's direction
  };
  const ctxLag =
    lagPctOf(p.contextAdjustments.weather)
    + lagPctOf(p.contextAdjustments.park)
    + lagPctOf(p.contextAdjustments.gameScript)
    + lagPctOf(p.contextAdjustments.lineup)
    + lagPctOf(p.contextAdjustments.bvp);
  // 5 layers × 10% favorable shift each = 50; cap at 100.
  const marketLagScore = Math.max(0, Math.min(100, ctxLag * 2));
  // Upside potential: derived from Monte Carlo P90 vs line. Scaled
  // 0-100. When MC isn't available (degenerate stddev), fall back
  // to projection separation as a coarse proxy.
  let upsidePotential = projectionGap;
  if (p.monteCarlo) {
    const ceiling = dir === 'OVER' ? p.monteCarlo.percentiles.p90 : p.monteCarlo.percentiles.p10;
    const room = dir === 'OVER' ? Math.max(0, ceiling - line.line) : Math.max(0, line.line - ceiling);
    const denom = Math.max(0.5, Math.abs(line.line));
    upsidePotential = Math.max(0, Math.min(100, (room / denom) * 100));
  }
  const trapScore = p.trapScore;
  const score =
    projectionGap * 0.25
    + momentumExpansion * 0.25
    + matchupLeverage * 0.15
    + marketLagScore * 0.15
    + upsidePotential * 0.10
    - trapScore * 0.10;
  return score;
}

// Recent-support gate per spec: a Wild Card pick can't be pure fantasy.
// Require AT LEAST ONE OF:
//   - 3+ hits at the line in L10 (real recent production)
//   - 2+ contextual accelerators (lineup / weather / matchup / park /
//     game-script all firing in the player's favor)
function passesRecentSupportGate(line: ResolvedMlbLine): boolean {
  const s = line.signals;
  const p = line.projection;
  const recentHits = s.last10HitCount ?? 0;
  if (recentHits >= 3) return true;
  let accelerators = 0;
  // Direction-aware adjustments (>1.02 favors OVER, <0.98 favors UNDER).
  const dir = line.modelDirection;
  const dirHelps = (mult: number) =>
    dir === 'OVER' ? mult > 1.02 : mult < 0.98;
  if (dirHelps(p.contextAdjustments.weather)) accelerators += 1;
  if (dirHelps(p.contextAdjustments.park)) accelerators += 1;
  if (dirHelps(p.contextAdjustments.gameScript)) accelerators += 1;
  if (dirHelps(p.contextAdjustments.lineup)) accelerators += 1;
  if (dirHelps(p.contextAdjustments.bvp)) accelerators += 1;
  // Strong matchup vs opponent (≥0.5 above season avg in player's
  // direction) counts as one accelerator.
  const opp = s.opponentVsSeasonDelta ?? 0;
  const oppDirAdj = dir === 'OVER' ? opp : -opp;
  if (oppDirAdj >= 0.5 && s.opponentGames >= 2) accelerators += 1;
  return accelerators >= 2;
}

// Tier-internal ranker. Sorts by the new wildCardScore formula.
function pickTopByWildCardScore(
  pool: ResolvedMlbLine[],
  n: number,
): ResolvedMlbLine[] {
  return [...pool]
    .sort((a, b) => computeWildCardScore(b) - computeWildCardScore(a))
    .slice(0, n);
}

// Used by the no-edge fallback (closest candidates) — pure projection
// separation, since by definition there's no momentum signal worth
// trusting at that point.
function pickTopByDistance(
  pool: ResolvedMlbLine[],
  n: number,
): ResolvedMlbLine[] {
  return [...pool]
    .sort((a, b) => b.projection.projectionDistanceScore - a.projection.projectionDistanceScore)
    .slice(0, n);
}

function combinedHit(legs: ResolvedMlbLine[]): number {
  let p = 1;
  for (const l of legs) p *= l.projection.probability / 100;
  return Math.round(p * 1000) / 10;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  let s = 0;
  for (const n of nums) s += n;
  return Math.round((s / nums.length) * 10) / 10;
}

function toComboLegWithReason(
  l: ResolvedMlbLine,
  reason: string,
): MlbComboLeg & { wildCardReason: string } {
  return {
    playerId: l.playerId,
    playerName: l.playerName,
    team: l.team.abbr,
    statKey: l.statKey,
    statLabel: l.statLabel,
    line: l.line,
    direction: l.modelDirection,
    probability: l.projection.probability,
    projection: l.projection.projection,
    rangeLow: l.projection.rangeLow,
    rangeHigh: l.projection.rangeHigh,
    edgePercent: l.projection.edgePercent,
    riskScore: l.projection.riskScore,
    trapScore: l.projection.trapScore,
    fragilityScore: l.projection.fragilityScore,
    fragilityTier: l.projection.fragilityTier,
    momentumExpansionScore: l.signals.momentumExpansionScore,
    reasonCodes: l.projection.reasonCodes,
    isPitcher: l.isPitcher,
    gamePk: l.gamePk,
    bookableSide: l.bookableSide,
    // Phase 101 — pass through market intel.
    marketImpliedProb: l.projection.marketImpliedProb,
    lineInflationScore: l.projection.lineInflationScore,
    publicBiasTags: l.projection.publicBiasTags,
    sharpnessScore: l.projection.sharpnessScore,
    edgeDurability: l.projection.edgeDurability,
    whyMarketWrong: l.projection.whyMarketWrong,
    wildCardReason: reason,
  };
}

function uniqueByPlayer<T extends { playerId: number }>(arr: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const x of arr) {
    if (seen.has(x.playerId)) continue;
    seen.add(x.playerId);
    out.push(x);
  }
  return out;
}

// ---------- Public entry point ----------

// Build one Wild Card combo from the resolved-line pool. Walks the
// tier chain in priority order; first tier with ≥MIN_LEGS qualifying
// picks wins. Falls through to no-edge with closest candidates.
export function buildMlbWildCard(
  pool: ResolvedMlbLine[],
  // Players already used by Best 2-6 cards. Wild Card avoids them
  // so it gives users genuinely different picks, not duplicates.
  usedPlayers: Set<number>,
): MlbWildCardCombo {
  const unused = pool.filter((l) => !usedPlayers.has(l.playerId));
  // Side-restriction enforcement (same as main builder).
  const eligible = unused.filter((l) => {
    if (l.bookableSide === 'over' && l.modelDirection !== 'OVER') return false;
    if (l.bookableSide === 'under' && l.modelDirection !== 'UNDER') return false;
    return true;
  });

  // Try each tier. Sort within each tier by projection distance score
  // (proxy for "strongest signal of this kind"). Same-player block:
  // unique by playerId so we never double-up.
  const tiers: Array<{
    kind: MlbWildCardKind;
    predicate: (l: ResolvedMlbLine) => boolean;
  }> = [
    { kind: 'standard',      predicate: isStandardEligible },
    { kind: 'near_miss',     predicate: isNearMissEligible },
    { kind: 'momentum',      predicate: isMomentumEligible },
    { kind: 'matchup_spike', predicate: isMatchupSpikeEligible },
    { kind: 'high_variance', predicate: isHighVarianceEligible },
  ];

  for (const tier of tiers) {
    const tierPool = uniqueByPlayer(
      eligible
        .filter(tier.predicate)
        .filter(passesRecentSupportGate),     // Phase 29 spec gate
    );
    if (tierPool.length < MIN_LEGS) continue;
    const picks = pickTopByWildCardScore(tierPool, TARGET_LEGS);
    const raw = combinedHit(picks);
    const corr = computeCorrelationRisk(picks);
    const adjusted = Math.round(raw * corr.multiplier * 10) / 10;
    // Average wildCardScore across the tier picks — surfaced so users
    // can see how strong the tier's edge is relative to other days.
    const avgWildScore = avg(picks.map((l) => computeWildCardScore(l)));
    return {
      label: 'Wild Card',
      kind: tier.kind,
      subtitle: SUBTITLES[tier.kind],
      legs: picks.map((l) => toComboLegWithReason(l, reasonFor(tier.kind, l))),
      rawCombinedHit: raw,
      adjustedCombinedHit: adjusted,
      correlationRisk: corr.tier,
      correlationPairs: corr.pairs,
      averageEdge: avg(picks.map((l) => l.projection.edgePercent)),
      averageTrap: avg(picks.map((l) => l.projection.trapScore)),
      averageWildCardScore: avgWildScore,
    };
  }

  // No-edge fallback. Surface the closest candidates by projection
  // distance score so the user can SEE how close we got. Never blank.
  const closest = uniqueByPlayer(pickTopByDistance(eligible, 3));
  return {
    label: 'Wild Card',
    kind: 'no_edge',
    subtitle: SUBTITLES.no_edge,
    legs: [],
    rawCombinedHit: 0,
    adjustedCombinedHit: 0,
    correlationRisk: 'None',
    correlationPairs: 0,
    averageEdge: 0,
    averageTrap: 0,
    closestCandidates: closest.map((l) => toComboLegWithReason(l, reasonFor('no_edge', l))),
  };
}
