// MLB slate builder — Phase 4. Takes enriched legs from the pipeline
// and produces combos (Best 2/3/4/5/6) per the requested risk mode.
//
// Mission discipline embedded:
//   - "Card size must be earned." If insufficient edge concentration,
//     the slot returns no combo with a clear "no clean N-leg edge"
//     reason rather than forcing a fake card.
//   - "Smaller cards over forced volume." Each mode has a strict
//     eligibility bar per slot — A-grade for 2-leg, A+ for 3-leg,
//     elite for 5/6.
//   - Insane mode is lottery-ticket framing per the saved memory:
//     5/6-leg only, accepts low hit rate, high edge required.
//   - Same-player block: a player can't appear twice in a single
//     card (so Aaron Judge HRs and Aaron Judge total bases can't
//     be stacked — those are correlated by definition).
//
// What's deliberately NOT in v1 (saved to roadmap):
//   - Full Wild Card fallback chain (Near Miss / Momentum / Matchup
//     Spike / etc) — too much complexity for first ship.
//   - Cross-player same-game correlation penalty.
//   - Line raising.
//
// All the hooks for those are reserved as future-extension points.

import type { ResolvedMlbLine } from './mlbSlatePipeline.js';

// User-facing modes — same as NBA. 'auto' resolves to one of the
// underlying modes based on slate quality.
export type MlbSlateMode = 'safe' | 'balanced' | 'aggressive' | 'insane' | 'auto';
export type MlbResolvedSlateMode = Exclude<MlbSlateMode, 'auto'>;

// Per-mode eligibility config. minLegProb is the per-leg probability
// floor; minLegEdge is the per-leg edge% floor; maxLegTrap is the
// per-leg trap-score ceiling; allowedSizes is which Best-N cards
// the mode emits.
const MODE_CONFIG: Record<MlbResolvedSlateMode, {
  label: string;
  minLegProb: number;
  minLegEdge: number;
  maxLegTrap: number;
  allowedSizes: ReadonlySet<number>;
  // Per-card-size additional requirements per the "card size must be
  // earned" principle. Larger cards demand higher edge concentration.
  perSize: Partial<Record<number, { minAvgEdge: number }>>;
}> = {
  safe: {
    label: 'Safe',
    minLegProb: 65,
    minLegEdge: 5,
    maxLegTrap: 40,
    allowedSizes: new Set([2, 3, 4]),
    perSize: {
      2: { minAvgEdge: 5 },
      3: { minAvgEdge: 7 },
      4: { minAvgEdge: 9 },
    },
  },
  balanced: {
    label: 'Balanced',
    minLegProb: 55,
    minLegEdge: 5,
    maxLegTrap: 50,
    allowedSizes: new Set([2, 3, 4, 5, 6]),
    perSize: {
      2: { minAvgEdge: 5 },
      3: { minAvgEdge: 7 },
      4: { minAvgEdge: 9 },
      5: { minAvgEdge: 12 },
      6: { minAvgEdge: 14 },
    },
  },
  aggressive: {
    label: 'Aggressive',
    minLegProb: 50,
    minLegEdge: 12,
    maxLegTrap: 60,
    allowedSizes: new Set([3, 4, 5, 6]),
    perSize: {
      3: { minAvgEdge: 12 },
      4: { minAvgEdge: 14 },
      5: { minAvgEdge: 16 },
      6: { minAvgEdge: 18 },
    },
  },
  insane: {
    // Lottery-ticket mode (per feedback_insane_lottery_framing memory).
    // Power Play 5/6-leg only — that's where the payouts live. Edge
    // floor stays modest because lottery users explicitly accept losing.
    label: 'Insane',
    minLegProb: 45,
    minLegEdge: 8,
    maxLegTrap: 70,
    allowedSizes: new Set([5, 6]),
    perSize: {
      5: { minAvgEdge: 12 },
      6: { minAvgEdge: 14 },
    },
  },
};

// ---------- Public types ----------

export type MlbComboLeg = {
  playerId: number;
  playerName: string;
  team: string | null;
  statKey: string;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  probability: number;
  projection: number;
  edgePercent: number;
  riskScore: number;
  trapScore: number;
  reasonCodes: string[];
  isPitcher: boolean;
  gamePk: number | null;
  bookableSide: 'over' | 'under' | 'both';
};

export type MlbCombo = {
  label: 'Best 2' | 'Best 3' | 'Best 4' | 'Best 5' | 'Best 6';
  subtitle: string;
  size: number;
  legs: MlbComboLeg[];
  rawCombinedHit: number;          // Π probabilities, no correlation penalty
  averageEdge: number;
  averageTrap: number;
  weakestLegName: string;
  weakestLegReason: string;
};

export type MlbSlateResult = {
  resolvedMode: MlbResolvedSlateMode;
  // One slot per allowed size in the chosen mode. If a slot
  // couldn't earn its eligibility bar, combo === null and reason
  // explains why (transparency principle).
  combos: Array<{
    size: number;
    label: MlbCombo['label'];
    combo: MlbCombo | null;
    reason: string;
  }>;
};

// ---------- Auto-mode resolver ----------

// Inspect slate quality and pick the most aggressive mode it supports.
// Mirrors the NBA spec — weak slate → Safe, dense edge → Insane.
function resolveAutoMode(eligible: ResolvedMlbLine[]): MlbResolvedSlateMode {
  if (eligible.length < 4) return 'safe';
  const eliteCount = eligible.filter((l) => l.projection.edgePercent >= 18).length;
  const strongCount = eligible.filter((l) => l.projection.edgePercent >= 12).length;
  const goodCount = eligible.filter((l) => l.projection.edgePercent >= 5).length;

  if (eliteCount >= 6) return 'insane';
  if (strongCount >= 6) return 'aggressive';
  if (goodCount >= 4) return 'balanced';
  return 'safe';
}

// ---------- Builder ----------

// Filter legs that meet the per-mode eligibility floor. Side
// restriction (Demon-only / Goblin-only) is also enforced — a Demon
// line with model UNDER lean is dropped (can't bet under on a Demon).
function eligibleLegs(
  lines: ResolvedMlbLine[],
  mode: MlbResolvedSlateMode,
): ResolvedMlbLine[] {
  const cfg = MODE_CONFIG[mode];
  return lines.filter((l) => {
    // Side restriction. PrizePicks Demon = over-only; Goblin = under-only.
    if (l.bookableSide === 'over' && l.modelDirection !== 'OVER') return false;
    if (l.bookableSide === 'under' && l.modelDirection !== 'UNDER') return false;
    if (l.projection.probability < cfg.minLegProb) return false;
    if (l.projection.edgePercent < cfg.minLegEdge) return false;
    if (l.projection.trapScore > cfg.maxLegTrap) return false;
    return true;
  });
}

// Score each leg for ranking. Mode-aware: Safe leans toward
// probability + low risk; Aggressive leans toward edge + projection
// separation; Insane leans toward edge + projection distance with
// minimal risk penalty.
function legScore(leg: ResolvedMlbLine, mode: MlbResolvedSlateMode): number {
  const p = leg.projection;
  switch (mode) {
    case 'safe':
      return p.probability * 0.50 + p.confidence * 0.30 - p.riskScore * 0.10 - p.trapScore * 0.10;
    case 'balanced':
      return p.evScore * 0.50 + p.probability * 0.20 + p.edgePercent * 0.20 - p.trapScore * 0.10;
    case 'aggressive':
      return p.edgePercent * 0.50 + p.projectionDistanceScore * 0.30 + p.confidence * 0.10 - p.trapScore * 0.10;
    case 'insane':
      // Per Insane memory: heavy on edge + projection separation;
      // tolerate risk because users opted in to losing.
      return p.edgePercent * 0.40 + p.projectionDistanceScore * 0.40 + p.evScore * 0.20 - p.trapScore * 0.05;
  }
}

// Pick top-N legs respecting same-player uniqueness. Player can only
// appear once per card — Aaron Judge HR + Aaron Judge total bases is
// definitionally correlated, blocked here.
function pickTopN(
  pool: ResolvedMlbLine[],
  n: number,
  mode: MlbResolvedSlateMode,
): ResolvedMlbLine[] {
  const ranked = [...pool].sort((a, b) => legScore(b, mode) - legScore(a, mode));
  const picked: ResolvedMlbLine[] = [];
  const usedPlayers = new Set<number>();
  for (const l of ranked) {
    if (usedPlayers.has(l.playerId)) continue;
    picked.push(l);
    usedPlayers.add(l.playerId);
    if (picked.length >= n) break;
  }
  return picked;
}

function combinedHit(legs: ResolvedMlbLine[]): number {
  let p = 1;
  for (const l of legs) p *= l.projection.probability / 100;
  return Math.round(p * 1000) / 10;     // 0-100, 1 decimal
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  let s = 0;
  for (const n of nums) s += n;
  return Math.round((s / nums.length) * 10) / 10;
}

// Subtitle copy per mode + size. Insane gets lottery-ticket framing
// per the saved memory.
function subtitleFor(
  mode: MlbResolvedSlateMode,
  size: number,
): string {
  if (mode === 'insane') {
    return size === 6
      ? 'Lottery · ~50× target with Demon stack'
      : 'Lottery · ~25× target with Demon stack';
  }
  if (mode === 'safe') return 'Safe Core · highest probability';
  if (mode === 'aggressive') {
    return size >= 5 ? 'Aggressive Edge · strongest market mispricings'
      : 'Aggressive Edge · projection gaps';
  }
  // balanced — mirrors NBA per-size identity
  if (size <= 2) return 'Safe Core · highest probability';
  if (size <= 3) return 'Safe Core · balanced anchor';
  if (size === 4) return 'Balanced EV · risk-adjusted edge';
  return 'Aggressive Edge · projection gaps';
}

function makeCombo(
  size: number,
  legs: ResolvedMlbLine[],
  mode: MlbResolvedSlateMode,
): MlbCombo {
  const label = (`Best ${size}`) as MlbCombo['label'];
  // Identify weakest leg (highest fragility — proxy: trap + risk).
  let worst = legs[0]!;
  for (const l of legs) {
    const score = (l.projection.trapScore ?? 0) + (l.projection.riskScore ?? 0);
    const wScore = (worst.projection.trapScore ?? 0) + (worst.projection.riskScore ?? 0);
    if (score > wScore) worst = l;
  }
  const weakestLegReason =
    worst.projection.reasonCodes.find((r) =>
      /thin|small[- ]sample|trap|volat|inherent/i.test(r),
    ) ?? `Highest combined trap + risk on this card.`;

  return {
    label,
    subtitle: subtitleFor(mode, size),
    size,
    legs: legs.map(toComboLeg),
    rawCombinedHit: combinedHit(legs),
    averageEdge: avg(legs.map((l) => l.projection.edgePercent)),
    averageTrap: avg(legs.map((l) => l.projection.trapScore)),
    weakestLegName: worst.playerName,
    weakestLegReason,
  };
}

function toComboLeg(l: ResolvedMlbLine): MlbComboLeg {
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
    edgePercent: l.projection.edgePercent,
    riskScore: l.projection.riskScore,
    trapScore: l.projection.trapScore,
    reasonCodes: l.projection.reasonCodes,
    isPitcher: l.isPitcher,
    gamePk: l.gamePk,
    bookableSide: l.bookableSide,
  };
}

// ---------- Public entry point ----------

export function buildMlbSlate(
  lines: ResolvedMlbLine[],
  mode: MlbSlateMode = 'balanced',
): MlbSlateResult {
  // Resolve auto → underlying mode based on slate quality.
  const resolvedMode: MlbResolvedSlateMode =
    mode === 'auto' ? resolveAutoMode(lines) : mode;
  const cfg = MODE_CONFIG[resolvedMode];

  const eligible = eligibleLegs(lines, resolvedMode);

  const slots: MlbSlateResult['combos'] = [];

  // Walk allowed sizes in ascending order so the result is stable.
  const sizes = [...cfg.allowedSizes].sort((a, b) => a - b);
  for (const size of sizes) {
    const label = (`Best ${size}`) as MlbCombo['label'];
    if (eligible.length < size) {
      slots.push({
        size,
        label,
        combo: null,
        reason: `Not enough eligible legs (have ${eligible.length}, need ${size}).`,
      });
      continue;
    }
    const picks = pickTopN(eligible, size, resolvedMode);
    if (picks.length < size) {
      // Same-player uniqueness shrunk the pool below target.
      slots.push({
        size,
        label,
        combo: null,
        reason: `Not enough distinct players to fill ${size} legs.`,
      });
      continue;
    }
    // Per-size edge concentration gate. Mission says "card size must
    // be earned" — small cards from soft slates aren't worth shipping.
    const sizeReq = cfg.perSize[size];
    const avgEdge = avg(picks.map((l) => l.projection.edgePercent));
    if (sizeReq && avgEdge < sizeReq.minAvgEdge) {
      slots.push({
        size,
        label,
        combo: null,
        reason: `No clean ${size}-leg edge detected tonight (avg edge ${avgEdge.toFixed(1)}% < required ${sizeReq.minAvgEdge}%).`,
      });
      continue;
    }
    slots.push({
      size,
      label,
      combo: makeCombo(size, picks, resolvedMode),
      reason: 'OK',
    });
  }

  return { resolvedMode, combos: slots };
}

// ---------- Re-exports for tests ----------

export { MODE_CONFIG, eligibleLegs, legScore, pickTopN, combinedHit };
