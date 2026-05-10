// Slate combo builder — produces Best 2 / 3 / 4 / 5 / 6 + Wild Card
// from a resolved slate. Built top-down: Best 6 first via greedy
// slateScore selection with exposure + correlation caps, then Best
// 5/4/3/2 are derived as subsets so smaller cards are guaranteed
// inside the bigger one. Wild Card is built independently from a
// higher-risk-but-still-data-supported pool.
//
// Pure function — no DB, no async. Reads `ResolvedLine[]` (the slate
// resolver's output, already enriched with projection/probability/
// confidence/risk/edge) and returns a structured combos result the
// frontend renders directly.
//
// The projection engine itself is unchanged — this module only decides
// which picks to surface and how to group them.

import { LAST10_LABELS, type Last10StatId } from './last10.js';
import {
  computeMarketIntel,
  type EdgeDurability,
  type PublicBiasTag,
} from './marketIntel.js';
import type { PlayerArchetype } from './playerArchetype.js';
import { normalCdf } from './projectionEngine.js';
import type { ResolvedLine } from './slatePipeline.js';

// Internal-only — combines the wire-shape ComboCandidate with the
// projection context the fallback classifier needs (season averages,
// minutes/usage trend, opponent-defense multiplier, archetype).
// Never crosses the API boundary; the public Combo emits ComboCandidate
// only.
type EnrichedCandidate = ComboCandidate & {
  context: {
    seasonAvg: number;
    last5Avg: number | null;
    last5HitRate: number | null;       // 0-100; null when window missing
    minutesMultiplier: number;          // projected / season minutes
    usageMultiplier: number;            // projection's usage layer
    opponentDefenseMultiplier: number;  // <1.0 = tough opp, >1.0 = soft
    blendedStdDev: number;              // for "≥1σ above line" tests
    archetype: PlayerArchetype | null;
  };
};

// -----------------------------------------------------------------
// Eligibility thresholds (spec §"Candidate Eligibility").
// Picks below the eligible bar never appear on a Best 2-6 card.
// -----------------------------------------------------------------
const ELIGIBLE = {
  probability: 57,
  confidence: 55,
  risk: 70,
  edge: 45,
} as const;

// Wild Card uses a looser bar (spec §"Wild Card Logic"): higher
// risk, higher upside, but still data-supported. Wild Card eligibility
// also explicitly skips picks already used on Best 6 so the wild slate
// is genuinely a different angle, not the same names with extra noise.
const WILD = {
  probability: 52,
  confidence: 45,
  risk: 85,
  edge: 35,
} as const;

// Confidence labels surfaced on each leg card (spec §"Frontend Card
// Display"). Tied to the projection's `confidence.score` (0-100).
function confidenceLabel(score: number): string {
  if (score >= 72) return 'Elite';
  if (score >= 65) return 'Strong';
  if (score >= 55) return 'Medium';
  return 'Low';
}

// -----------------------------------------------------------------
// EV Engine — per the StatEdge EV / market-inefficiency spec.
//
// PrizePicks payout tables — sourced directly from the in-app FAQ
// ("How to Play" / "What are the standard payout multipliers?").
// Implied per-leg probability is the `n`-th root of (1 / payout):
// if all legs are equally probable and independent, this is the
// per-leg break-even rate at which a card's EV is zero. Anything
// above this is positive expected value.
//
// FLEX PLAY (partial wins allowed — what users see by default on
// the standard PrizePicks card). 6/6 pays 25×; smaller hits pay
// fractional refunds (5/6 = 2×, 4/6 = 0.4×, etc). We only model the
// all-correct rate here since that's the headline / EV ceiling.
//
// 2-leg payout = 3×    → implied per-leg ≈ 57.7%   break-even ≈ 33.3% combined
// 3-leg payout = 3×    → implied per-leg ≈ 69.3%   break-even ≈ 33.3% combined
// 4-leg payout = 6×    → implied per-leg ≈ 63.9%   break-even ≈ 16.7% combined
// 5-leg payout = 10×   → implied per-leg ≈ 63.1%   break-even ≈ 10.0% combined
// 6-leg payout = 25×   → implied per-leg ≈ 58.6%   break-even ≈ 4.0%  combined
// -----------------------------------------------------------------
// Verified against the May 2026 PrizePicks in-app FAQ screenshots
// (user-supplied 2026-05-10). The values represent the **n-of-n hit**
// payout — what a user pocketing every leg actually receives — NOT
// the "1st place leaderboard prize" PP shows alongside as a "minimum
// guarantee" (which only applies to ranked-contest entries, not the
// solo card a typical user is staking). Pre-iter-10, this table
// conflated the two and showed a 6-leg Power Play 6/6 payout of
// 37.5× when the real number is 14×; that's where the false
// "~50× target with Demon stack" headline came from.
//
// Smaller sizes (2-5) carry a `// VERIFY` flag because we have not
// confirmed those individual ladders against current PP screenshots;
// the prior values are kept to avoid breaking tests in this slice
// but should be re-validated when we get screenshots for them.
export const PRIZEPICKS_PAYOUTS: Record<number, number> = {
  2: 3,             // VERIFY — kept from prior table
  3: 5,             // VERIFY — bumped from 3 (typical PP 3-leg Flex 3/3 ≈ 5×)
  4: 10,            // VERIFY — bumped from 6 (typical PP 4-leg Flex 4/4 ≈ 10×)
  5: 20,            // VERIFY — bumped from 10 (typical PP 5-leg Flex 5/5 ≈ 20×)
  6: 9,             // VERIFIED — May 2026 screenshot: "6 correct pays 9X" on Flex
};

// POWER PLAY (all-or-nothing — higher payouts, no partial refund).
// 6-leg verified May 2026: "6 correct pays 14X". The 37.5× value
// pre-iter-10 was the contest 1st-place prize, NOT the n-of-n
// payout. Realistic 6-leg Insane ceiling with 6 Demons at 1.05× per
// leg: 14 × 1.05^6 ≈ 18.7× — not 50×, never 100×.
export const PRIZEPICKS_POWER_PLAY_PAYOUTS: Record<number, number> = {
  2: 3,             // VERIFY — kept from prior table
  3: 6,             // VERIFY — kept from prior table
  4: 10,            // VERIFY — kept from prior table
  5: 20,            // VERIFY — kept from prior table
  6: 14,            // VERIFIED — May 2026 screenshot: "6 correct pays 14X"
};

// Per-leg payout multiplier for PrizePicks Demon (over-only, harder
// line) and Goblin (under-only, easier line). Sourced from the FAQ
// scoring weights: "Each correct Demon pick is worth 1.05 points"
// and "Each correct Goblin pick is worth 0.95 points." This is the
// canonical PrizePicks weight; previous versions used 1.25 / 0.85
// based on misread industry estimates. Conservative numbers here
// prevent the UI from overstating the lottery ceiling.
const DEMON_LEG_MULTIPLIER = 1.05;
const GOBLIN_LEG_MULTIPLIER = 0.95;

// Estimate a card's PrizePicks payout, factoring in Demon/Goblin
// per-leg multipliers and the user's chosen play type. Insane uses
// Power Play (all-or-nothing); other modes show the Flex Play rate
// users see on the standard PrizePicks card. Returns undefined when
// the card size has no payout in the table (e.g. Wild Card with 0/1
// legs).
export function estimateCardPayout(
  legs: ComboCandidate[],
  playType: 'flex' | 'power',
): number | undefined {
  const cardSize = legs.length;
  const table =
    playType === 'power' ? PRIZEPICKS_POWER_PLAY_PAYOUTS : PRIZEPICKS_PAYOUTS;
  const base = table[cardSize];
  if (base === undefined) return undefined;
  let stack = 1;
  for (const leg of legs) {
    if (leg.isDemon) stack *= DEMON_LEG_MULTIPLIER;
    else if (leg.isGoblin) stack *= GOBLIN_LEG_MULTIPLIER;
  }
  return base * stack;
}

// Average per-leg implied across the card sizes — used as the
// baseline for ranking individual candidates BEFORE we know which
// card they'll land on. Cards compute their own implied at build
// time using the size-specific payout.
const BASELINE_IMPLIED_PROB = 55;

export function impliedPerLegProb(cardSize: number): number {
  const payout = PRIZEPICKS_PAYOUTS[cardSize];
  if (!payout) return BASELINE_IMPLIED_PROB;
  return Math.pow(1 / payout, 1 / cardSize) * 100;
}

// EV scoring formula per spec §"NEW EV SCORING FORMULA". Replaces
// pure-probability ranking with risk-adjusted expected-value
// ranking. Components:
//   - edgePercent (0.40)           — model prob − implied break-even
//   - confidence (0.20)            — projection confidence
//   - calibrationStrength (0.15)   — how trustworthy this bucket is
//   - projectionDistanceScore (0.15) — projection / σ separation
//   - risk (-0.10)                 — penalize fragile picks
function computeEvScore(c: {
  edgePercent: number;
  confidence: number;
  calibrationStrength: number;
  projectionDistanceScore: number;
  risk: number;
}): number {
  return (
    c.edgePercent * 0.40
    + c.confidence * 0.20
    + c.calibrationStrength * 0.15
    + c.projectionDistanceScore * 0.15
    - c.risk * 0.10
  );
}

// Projection separation as a 0-100 score. Tiers from spec
// §"Projection Distance Tiers" but normalized by stddev so the
// thresholds make sense across stat categories (Points runs 25-30,
// Steals runs 0-2). 0σ → 0; 1σ → 50; 2σ+ → 100.
function projectionDistanceScore(
  projection: number,
  line: number,
  direction: 'OVER' | 'UNDER',
  blendedStdDev: number,
): number {
  if (blendedStdDev <= 0) return 0;
  const distance =
    direction === 'OVER' ? projection - line : line - projection;
  if (distance <= 0) return 0;
  return Math.min(100, (distance / blendedStdDev) * 50);
}

// Pick category — spec §"NEW PICK CATEGORIES". Each candidate falls
// into one of four buckets. Order matters: most-specific first.
export type PickCategory = 'Safe Core' | 'Value' | 'Ceiling' | 'Contrarian';

function pickCategory(c: {
  probability: number;
  edgePercent: number;
  projectionDistanceScore: number;
  statVolatility: number;
}): PickCategory {
  // Ceiling: large projection separation + tolerable variance —
  // upside-driven, willing to accept lower probability.
  if (c.projectionDistanceScore >= 75) return 'Ceiling';
  // Contrarian: meaningful edge but the market is offering a low
  // probability (proxy for "public is fading the model").
  if (c.edgePercent >= 15 && c.probability < 65) return 'Contrarian';
  // Safe Core: high probability + low variance. The traditional
  // anchor pick.
  if (c.probability >= 72 && c.statVolatility < 0.30) return 'Safe Core';
  // Default: Value. Edge-positive but not extreme on either axis.
  return 'Value';
}

// Trap detection — spec §"TRAP SCORE ENGINE". Combines four
// signals; we don't have public-sentiment data so that component is
// proxied with stat volatility (a high-variance recent-spike player
// is the typical public-trap candidate anyway).
// Trap tier — 5 levels per the Trap Detection spec. Boundaries:
// 0-20 Clean / 21-40 Mild / 41-60 Moderate / 61-80 High / 81+ Extreme.
export type TrapTier =
  | 'Clean'
  | 'Mild Trap Risk'
  | 'Moderate Trap Risk'
  | 'High Trap Risk'
  | 'Extreme Trap Risk';

function trapTierFromScore(score: number): TrapTier {
  if (score >= 81) return 'Extreme Trap Risk';
  if (score >= 61) return 'High Trap Risk';
  if (score >= 41) return 'Moderate Trap Risk';
  if (score >= 21) return 'Mild Trap Risk';
  return 'Clean';
}

// Fragility tier — derived from fragilityScore. Spec §"Fragility Score":
// 0-25 Strong, 26-45 Acceptable, 46-65 Fragile, 66+ Do Not Use.
export type FragilityTier = 'Strong' | 'Acceptable' | 'Fragile' | 'Do Not Use';

function fragilityTierFromScore(score: number): FragilityTier {
  if (score >= 66) return 'Do Not Use';
  if (score >= 46) return 'Fragile';
  if (score >= 26) return 'Acceptable';
  return 'Strong';
}

// Per-stat baseline trap risk (spec §"Stat Type Risk"). Low-event
// stats (steals, blocks, 3PT, turnovers) get higher baseline risk
// because their distributions are noisy and small-sample-sensitive.
const STAT_TYPE_RISK: Record<Last10StatId, number> = {
  pra: 20,
  pr: 30,
  pa: 32,
  ra: 35,
  points: 35,
  rebounds: 35,
  defensive_rebounds: 35,
  assists: 40,
  fg_attempted: 40,
  fg_made: 45,
  ft_made: 45,
  ft_attempted: 45,
  offensive_rebounds: 50,
  three_pt_made: 55,
  turnovers: 55,
  double_double: 60,
  stocks: 70,
  steals: 70,
  blocks: 75,
  personal_fouls: 75,
};

// Map injury status string → injury risk score (0-100). Spec
// §"Injury / Reboot Risk" — Out is structurally blocked upstream
// (we never include OUT players as candidates), but we keep the
// 100 case for robustness.
function injuryRiskFromStatus(status: string | null | undefined): number {
  if (!status) return 5;       // Healthy
  switch (status) {
    case 'Out':           return 100;
    case 'Doubtful':      return 90;
    case 'Questionable':  return 70;
    case 'Day-To-Day':    return 50;
    case 'Probable':      return 30;
    default:              return 15;
  }
}

// Map archetype label → role risk. Players whose archetypes signal
// usage / minutes instability get higher role risk. Insufficient-data
// players get a moderate penalty (we just don't know).
function roleRiskFromArchetype(archetype: string | null | undefined): number {
  switch (archetype) {
    case 'Stable Producer':      return 10;
    case 'Moderately Volatile':  return 30;
    case 'High Variance':        return 50;
    case 'Boom/Bust':            return 70;
    case 'Minutes Sensitive':    return 80;
    case 'Insufficient Data':    return 60;
    default:                     return 35;     // unknown archetype
  }
}

// Per-card-size eligibility gates (spec §"Card Eligibility Rules"):
// the larger the card, the cleaner each leg must be.
const CARD_SIZE_GATES: Record<number, { maxTrap: number; minConfidence: number }> = {
  2: { maxTrap: 50, minConfidence: 60 },
  3: { maxTrap: 45, minConfidence: 62 },
  4: { maxTrap: 40, minConfidence: 65 },
  5: { maxTrap: 35, minConfidence: 68 },
  6: { maxTrap: 30, minConfidence: 70 },
};

// Slate strategy mode (spec §"USER RISK MODES"). Five modes:
//   safe        Conservative — high hit rate, low variance
//   balanced    Default — best risk-adjusted EV
//   aggressive  Edge-hunting — strong market mispricings
//   insane      Maximum upside — extreme projection separation
//   auto        Adaptive — measures slate quality, picks the right
//               underlying mode automatically. Resolves to one of
//               the four explicit modes before card construction.
export type SlateMode = 'safe' | 'balanced' | 'aggressive' | 'insane' | 'auto';
// Modes that actually drive card construction (auto resolves to one
// of these before any cards are built).
export type ResolvedSlateMode = Exclude<SlateMode, 'auto'>;

// Per-mode configuration. minEdge is the candidate-eligibility floor
// (legs below this are dropped); allowedSizes restricts which Best-N
// cards get built. Edge floors come from spec §"EDGE THRESHOLDS"
// per mode; card-size limits from spec §"CARD LIMITS".
const MODE_CONFIG: Record<ResolvedSlateMode, {
  minEdge: number;
  preferredEdge: number;
  allowedSizes: ReadonlySet<number>;
  label: string;
}> = {
  safe: {
    minEdge: 5,
    preferredEdge: 8,
    allowedSizes: new Set([2, 3, 4]),       // skip 5/6 per spec
    label: 'Safe',
  },
  balanced: {
    minEdge: 0,                              // no floor — ranks by EV
    preferredEdge: 12,
    allowedSizes: new Set([2, 3, 4, 5, 6]),  // all sizes
    label: 'Balanced',
  },
  aggressive: {
    minEdge: 12,
    preferredEdge: 18,
    allowedSizes: new Set([3, 4, 5, 6]),     // skip 2 (anchor)
    label: 'Aggressive',
  },
  insane: {
    // Lottery-ticket mode. Modest edge floor (8) — Demon-stacked
    // payouts compensate for marginal model edge, and Insane users
    // are explicitly buying upside, not safety. Power Play base
    // payouts plus 1.25× per Demon target ~100× on 6-leg cards.
    minEdge: 8,
    preferredEdge: 15,
    allowedSizes: new Set([5, 6]),           // 5/6-leg only — that's where the payout lives
    label: 'Insane',
  },
};

// Opportunity Boost — small ranking nudge for Aggressive + Wild Card
// when multiple existing acceleration signals agree. Spec'd 2026-05-08
// from the Wild Card philosophy shift: don't rebuild the engine, just
// nudge the ranker so momentum-aligned picks edge out flat picks of
// similar edge. Hidden from users — purely an internal sort tweak.
//
// Gate: extreme trap kills the boost (no rewarding public-trap lines).
// Counted signals (need ≥3 of 4 for any boost; max +10):
//   1. L5 average meaningfully above (OVER) / below (UNDER) season
//   2. L10 average confirms the trend
//   3. Minutes trending up (minutesMultiplier ≥ 1.02)
//   4. Projection separation strong (projectionDistanceScore ≥ 50)
//
// Designed to nudge, not override: max +10 vs 0-100 range scores can't
// flip a weak pick into a strong one, but it can promote a momentum
// pick over a flat pick at similar edge.
function opportunityBoost(c: ComboCandidate): number {
  // Need EnrichedCandidate-level context for L5 vs season + minutes
  // multiplier. ComboCandidate alone (from snapshots) returns 0 — the
  // boost only fires during live build where context is present.
  const ctx = (c as { context?: { seasonAvg: number; last5Avg: number | null; minutesMultiplier: number } }).context;
  if (!ctx) return 0;
  // Gate: extreme trap kills the boost.
  if (c.trapScore >= 60) return 0;
  if (ctx.seasonAvg <= 0) return 0;

  const overDir = c.direction === 'OVER';
  let signals = 0;

  // 1. L5 hot in chosen direction.
  if (ctx.last5Avg !== null) {
    if (overDir && ctx.last5Avg >= ctx.seasonAvg * 1.10) signals += 1;
    else if (!overDir && ctx.last5Avg <= ctx.seasonAvg * 0.90) signals += 1;
  }
  // 2. L10 confirms direction.
  if (overDir && c.l10Avg >= ctx.seasonAvg * 1.05) signals += 1;
  else if (!overDir && c.l10Avg <= ctx.seasonAvg * 0.95) signals += 1;
  // 3. Minutes trending up (helps either direction — more minutes = more
  // chances at the over, but also more chances for the under to fail
  // with garbage time. Net effect favors momentum picks generally).
  if (ctx.minutesMultiplier >= 1.02) signals += 1;
  // 4. Projection separation strong (projection ≥ 1σ from line).
  if (c.projectionDistanceScore >= 50) signals += 1;

  if (signals >= 4) return 10;
  if (signals >= 3) return 5;
  return 0;
}

// Iter 10 (no-obvious-picks rule): penalty applied uniformly across
// every mode's ranking. We never want to surface a leg whose only
// "edge" is repeating what PrizePicks' goblin/demon emoji already
// told the user. See feedback_no_obvious_picks.md for the user
// directive that drives this. Magnitude (-45) is chosen so that
// even a 95th-percentile candidate gets bumped below mid-pack
// candidates that ARE non-obvious — strong enough to actually
// reorder the slate, not just tweak edges.
function obviousnessPenalty(c: ComboCandidate): number {
  const goblinOver = c.isGoblin && c.direction === 'OVER';
  const demonUnder = c.isDemon && c.direction === 'UNDER';
  return (goblinOver || demonUnder) ? -45 : 0;
}

function modeScore(mode: ResolvedSlateMode, c: ComboCandidate): number {
  const penalty = obviousnessPenalty(c);
  if (mode === 'safe') return c.slateScore + penalty;
  if (mode === 'aggressive') {
    // Aggressive: rank by MarketDisagreementScore — "how mispriced
    // is this leg" is the headline concept. Plus a small Opportunity
    // Boost when momentum signals align (L5 hot + minutes up + proj
    // separation, with trap-not-extreme gate).
    return (
      c.marketDisagreementScore * 0.60
      + c.edgePercent * 0.20
      - c.risk * 0.10
      + c.edgeScore * 0.10
      + opportunityBoost(c)
      + penalty
    );
  }
  if (mode === 'insane') {
    // Insane: lottery-ticket mode. Hunts Demon (over-only, payout-
    // boosted) lines aggressively because every Demon stacked on the
    // card multiplies the final payout (1.05× per Demon per the PP
    // FAQ). Realistic 6-leg ceiling on Power Play with 6 Demons:
    // 14 × 1.05^6 ≈ 18.7× — NOT 50× (pre-iter-10 used the contest
    // 1st-place 37.5× number which is not the standard payout).
    // Risk penalty stays low — Insane users explicitly accept losing.
    //
    // Iter 10 directive (no-obvious picks rule): we no longer reward a
    // Demon just for being a Demon. We boost when the model says the
    // over actually clears the demon line (real edge), and we PUNISH
    // the trivial cases where we'd just be re-telling the user what
    // PrizePicks already told them via the goblin/demon emoji:
    //
    //   Goblin-over  : PP shaved the line down so the over is "easy" →
    //                  rubber-stamping that has no value to the user.
    //   Demon-under  : PP pumped the line so the over is "hard" → so
    //                  the under is "easy" by symmetry; same problem.
    //
    // Real edge looks like: Demon-over the model still clears (PP
    // pumped it but our projection clears anyway), Goblin-under that
    // looks like a trap (PP shaved it because they expect a public
    // over, but our model says under).
    const demonBoost = (c.isDemon && c.direction === 'OVER') ? 25
      : (c.isGoblin && c.direction === 'UNDER') ? 10
      : 0;
    return (
      c.projectionDistanceScore * 0.40
      + c.edgePercent * 0.30
      + c.edgeScore * 0.10
      - c.risk * 0.05
      + demonBoost
      + penalty
    );
  }
  return c.evScore + penalty;     // balanced (default)
}

// Resolve auto mode based on slate quality. Looks at the eligible
// candidate pool and picks the most aggressive mode the slate can
// actually support. A weak slate stays Safe; a slate dense with
// high-edge picks gets unlocked into Aggressive or Insane. Spec
// §"AUTO MODE BEHAVIOR".
function resolveAutoMode(eligible: EnrichedCandidate[]): ResolvedSlateMode {
  if (eligible.length < 6) return 'safe';        // not enough to build
  const eliteCount = eligible.filter((c) => c.edgePercent >= 25).length;
  const strongCount = eligible.filter((c) => c.edgePercent >= 18).length;
  const goodCount = eligible.filter((c) => c.edgePercent >= 12).length;
  // Average edge across the top-10 candidates by edgePercent —
  // signals overall slate softness.
  const top10AvgEdge =
    [...eligible]
      .sort((a, b) => b.edgePercent - a.edgePercent)
      .slice(0, 10)
      .reduce((s, c) => s + c.edgePercent, 0) / Math.min(10, eligible.length);

  if (eliteCount >= 6 && top10AvgEdge >= 22) return 'insane';
  if (strongCount >= 6 && top10AvgEdge >= 16) return 'aggressive';
  if (goodCount >= 6) return 'balanced';
  return 'safe';
}

// Per-card identity in Balanced mode: small cards lean safer, big
// cards lean aggressive. Spec §"6-MAN PHILOSOPHY" — the 6-leg card
// SHOULD be the most aggressive by design, not balanced. Safe /
// Aggressive / Insane user modes apply globally (no per-size tilt)
// so the user can override the inherent identity.
function effectiveMode(userMode: ResolvedSlateMode, cardSize: number): ResolvedSlateMode {
  if (userMode !== 'balanced') return userMode;
  if (cardSize >= 6) return 'aggressive';
  if (cardSize <= 2) return 'safe';
  return 'balanced';
}

// MarketDisagreementScore (spec §"NEW MARKET DISAGREEMENT SCORE").
// Quantifies how aggressively the model disagrees with the market
// at this line. Used as the primary ranker for aggressive/6-man
// cards: hunting mispricings, not safety.
function computeMarketDisagreement(c: {
  projectionDistanceScore: number;
  edgePercent: number;
  confidence: number;
}): number {
  // calibrationStrength held at 50 until we have ≥100 graded picks.
  return (
    c.projectionDistanceScore * 0.40
    + c.edgePercent * 0.35
    + c.confidence * 0.15
    + 50 * 0.10
  );
}

// Trap-detection engine (spec §"Trap Score Formula"). Eight signals
// combined into a single 0-100 score that says "how fragile is this
// pick?" — separate from "is this a +EV pick?". A pick can be +EV
// and high-trap (large edge but thin margin / unstable role); the
// trap score is what protects multi-leg cards from one-short losses.
//
// V1 limitations:
//   - gameScriptRisk: no pace/spread data yet → constant baseline 30
//   - correlationRisk at the leg level: not knowable without card
//     context → constant baseline 30. Card-level correlation block
//     still happens during card construction.
//   - minutesRisk: no per-game minutes time series exposed yet →
//     proxy with statVolatility × 80 (correlated in practice).
function computeTrapScore(c: {
  direction: 'OVER' | 'UNDER';
  line: number;
  projection: number;
  blendedStdDev: number;
  statKey: Last10StatId;
  statVolatility: number;
  archetype: string | null;
  injuryStatus: string | null;
}): number {
  // 1. Line margin risk — distance / σ. The most important signal:
  //    a projection 0.2σ over the line is fragile no matter how
  //    confident the model is in the projection.
  let lineMarginRisk = 50;
  if (c.blendedStdDev > 0) {
    const distance =
      c.direction === 'OVER' ? c.projection - c.line : c.line - c.projection;
    const sigmas = distance / c.blendedStdDev;
    if (sigmas >= 1.0) lineMarginRisk = 10;
    else if (sigmas >= 0.5) lineMarginRisk = 30;
    else if (sigmas >= 0.25) lineMarginRisk = 60;
    else if (sigmas >= 0) lineMarginRisk = 80;
    else lineMarginRisk = 95;        // projection is on the wrong side
  }

  // 2. Minutes risk — proxy with statVolatility (we don't have a
  //    minutes time series exposed on candidates yet).
  const minutesRisk = Math.min(100, c.statVolatility * 200);

  // 3. Role risk — derived from the archetype classifier.
  const roleRisk = roleRiskFromArchetype(c.archetype);

  // 4. Volatility risk — coefficient of variation on the stat itself.
  const volatilityRisk = Math.min(100, c.statVolatility * 200);

  // 5. Stat-type risk — baseline per stat category.
  const statTypeRisk = STAT_TYPE_RISK[c.statKey] ?? 40;

  // 6. Injury / reboot risk — derived from the ESPN status string.
  const injuryRisk = injuryRiskFromStatus(c.injuryStatus);

  // 7. Game script risk — placeholder until we plumb pace/spread.
  const gameScriptRisk = 30;

  // 8. Correlation risk — placeholder at the leg level. The card
  //    builder enforces same-player base-component blocks during
  //    construction, so this is informational here.
  const correlationRisk = 30;

  return Math.round(
    lineMarginRisk * 0.20
    + minutesRisk * 0.20
    + roleRisk * 0.15
    + volatilityRisk * 0.15
    + statTypeRisk * 0.10
    + injuryRisk * 0.10
    + gameScriptRisk * 0.05
    + correlationRisk * 0.05,
  );
}

// Per-leg fragility (spec §"Fragility Score"). Combines trap with
// the projection's risk score and injury risk. Used to surface the
// weakest leg on each card and decide if a card should be flagged.
//
// Spec formula references a `correlationRisk` term we don't have at
// leg level; we omit it (treat as 0). The remaining weights still
// sum reasonably.
function computeFragilityScore(c: {
  trapScore: number;
  riskScore: number;
  injuryRisk: number;
}): number {
  return Math.round(
    c.trapScore * 0.45
    + c.riskScore * 0.25
    + c.injuryRisk * 0.15,
  );
}

// Largest card size a leg can land on (spec §"Card Eligibility").
// Computed from the leg's trap score + confidence: stricter gates
// for bigger cards. Returns 0 if the leg fails the loosest gate
// (Best 2) — but this rarely fires because passesEligibility blocks
// poor candidates upstream.
function maxCardSizeFor(trapScore: number, confidence: number): number {
  for (const size of [6, 5, 4, 3, 2]) {
    const gate = CARD_SIZE_GATES[size]!;
    if (trapScore <= gate.maxTrap && confidence >= gate.minConfidence) {
      return size;
    }
  }
  return 0;
}

// -----------------------------------------------------------------
// Correlation derivation. Two stats are "correlated" (and so blocked
// from co-occurring on the same card for a given player) when they
// share a base box-score component — a bad scoring night drags
// Points, Pts+Rebs, Pts+Asts, PRA, FG Made, and 3PT Made together,
// so they shouldn't all sit on the same ticket.
//
// Earlier we maintained a hand-rolled lookup table, which missed
// cross-pairs like Pts+Rebs ↔ Pts+Asts (both share Points). Driving
// the relation off a base-component set fixes that systematically:
// any two stats whose component sets intersect are flagged.
//
// Cross-player correlation (game script, opposing stars) is still
// out of scope here — handled at the combined-hit penalty layer
// instead, since it's a softer signal than same-player base overlap.
// -----------------------------------------------------------------
const BASE_COMPONENTS: Record<Last10StatId, ReadonlySet<string>> = {
  points: new Set(['points']),
  rebounds: new Set(['rebounds']),
  // Offensive/defensive rebounds are subsets of total rebounds —
  // share the rebounds base so PRA / PR / RA pairs block them.
  offensive_rebounds: new Set(['rebounds']),
  defensive_rebounds: new Set(['rebounds']),
  assists: new Set(['assists']),
  // PRA-family stats share their constituent bases.
  pra: new Set(['points', 'rebounds', 'assists']),
  pr: new Set(['points', 'rebounds']),
  pa: new Set(['points', 'assists']),
  ra: new Set(['rebounds', 'assists']),
  // Shooting stats: 3PT Made and FG Made both contribute to Points.
  // FG attempts share volume with FG makes (same shot opportunity).
  three_pt_made: new Set(['points', 'fg_volume']),
  fg_made: new Set(['points', 'fg_volume']),
  fg_attempted: new Set(['fg_volume']),
  ft_made: new Set(['points', 'ft_volume']),
  ft_attempted: new Set(['ft_volume']),
  // Defensive counters.
  steals: new Set(['steals']),
  blocks: new Set(['blocks']),
  stocks: new Set(['steals', 'blocks']),
  // Stats with no shared base — never block.
  turnovers: new Set(['turnovers']),
  personal_fouls: new Set(['personal_fouls']),
  // Double-double depends on at least two of these crossing 10 — same
  // player's high-output night that drives a DD also drives the
  // individual stat lines.
  double_double: new Set(['points', 'rebounds', 'assists', 'steals', 'blocks']),
};

function statsCorrelated(a: Last10StatId, b: Last10StatId): boolean {
  if (a === b) return true;
  const ca = BASE_COMPONENTS[a];
  const cb = BASE_COMPONENTS[b];
  if (!ca || !cb) return false;
  for (const v of ca) if (cb.has(v)) return true;
  return false;
}

// -----------------------------------------------------------------
// Line raising (Slate Builder spec §"Line Raising Feature").
//
// When the model has elite conviction at the offered line, we test
// whether a higher line still meets keep thresholds. If yes, we
// surface the raised version. The user gets a "raised line" candidate
// at lower probability but materially higher payout.
//
// CAVEAT: PrizePicks doesn't actually offer alternate lines for most
// props. The raised line here is an *analytical* output — it tells
// the user "if a sportsbook offered Points 18.5 instead of 14.5,
// the model would still favor it ~75%". The frontend surfaces this
// as informational, not bookable.
//
// We re-derive probability at the new line via the normal CDF using
// the projection's mean (`projection.final`) and `blendedStdDev` —
// no need to re-run the full projection engine. Confidence and risk
// are kept as-is; properly recomputing them at a raised line is a
// follow-up (the spec's "Confidence remains" / "Risk remains" checks
// behave like soft sanity gates anyway).
// -----------------------------------------------------------------

// Per-stat absolute cap on how far a line can be raised (spec
// §"Do Not Over-Raise Lines"). Keep these strictly aligned with the
// spec — pushing past them surfaces "raised lines" the model has
// effectively no historical anchor for.
const LINE_RAISE_CAPS: Partial<Record<Last10StatId, number>> = {
  points: 4.0,
  rebounds: 2.0,
  assists: 2.0,
  three_pt_made: 1.0,
  steals: 0.5,
  blocks: 0.5,
  pra: 5.0,
  pr: 3.0,
  pa: 3.0,
  ra: 3.0,
  stocks: 0.5,
};

// Trigger thresholds — the candidate's ORIGINAL state must clear all
// of these for line-raising to even be considered. Conservative on
// purpose: raised lines are an analytical bonus, not a primary path.
const LINE_RAISE_TRIGGER = {
  probability: 70,
  confidence: 70,
  risk: 55,
  // Projection edge in stddev units — distance from line / σ.
  edgeSigmas: 1.25,
} as const;

// Keep thresholds — at each candidate raised line, we check the new
// probability still clears these. We don't re-derive confidence/risk
// at the raised line in V1; per-line risk recomputation is on the
// follow-up list. The probability check is the binding constraint.
const LINE_RAISE_KEEP = {
  probability: 60,
} as const;

function maybeRaiseLine(
  c: ComboCandidate,
  projectionMean: number,
  blendedStdDev: number,
): ComboCandidate {
  const cap = LINE_RAISE_CAPS[c.statKey];
  if (cap === undefined) return c;          // stat not eligible for raising
  if (blendedStdDev <= 0) return c;

  // Trigger check on the original candidate.
  if (c.probability < LINE_RAISE_TRIGGER.probability) return c;
  if (c.confidence < LINE_RAISE_TRIGGER.confidence) return c;
  if (c.risk > LINE_RAISE_TRIGGER.risk) return c;

  // Edge in stddev units. For OVER picks the model's mean must be
  // ≥1.25σ above the line; for UNDER, ≥1.25σ below.
  const edgeSigmas =
    c.direction === 'OVER'
      ? (projectionMean - c.line) / blendedStdDev
      : (c.line - projectionMean) / blendedStdDev;
  if (edgeSigmas < LINE_RAISE_TRIGGER.edgeSigmas) return c;

  // Walk the line up (or down for UNDER) in 0.5 steps, capped by
  // LINE_RAISE_CAPS. Stop at the highest step where the keep check
  // passes. If none pass, stay at original.
  const STEP = 0.5;
  const sign = c.direction === 'OVER' ? 1 : -1;
  let bestLine = c.line;
  let bestProb = c.probability;
  for (let delta = STEP; delta <= cap + 1e-9; delta += STEP) {
    const trialLine = c.line + sign * delta;
    const z = (trialLine - projectionMean) / blendedStdDev;
    const overP = (1 - normalCdf(z)) * 100;
    const trialProb = c.direction === 'OVER' ? overP : 100 - overP;
    if (trialProb < LINE_RAISE_KEEP.probability) break;
    bestLine = trialLine;
    bestProb = trialProb;
  }

  if (bestLine === c.line) return c;        // no raise survived

  // Raised candidate. Note we keep slateScore in sync with the new
  // probability so card-builder ranking reflects the trade-off
  // (lower prob, raised line). The Wild Card +4 boost (un-stubbed
  // below) compensates for the prob drop on longshot picks.
  const raisedScore =
    Math.round(bestProb) * 0.35 + c.confidence * 0.25 + c.edgeScore * 0.25 - c.risk * 0.15;
  return {
    ...c,
    originalLine: c.line,
    originalProbability: c.probability,
    line: bestLine,
    probability: Math.round(bestProb),
    slateScore: raisedScore,
    lineRaised: true,
    lineRaiseReason: `Raised from ${c.line} → ${bestLine} · projection still favors ${c.direction}.`,
  };
}

// -----------------------------------------------------------------
// Candidate type. One per (player, stat, direction) — i.e. one
// directional pick per resolved line. We commit to a single direction
// up front based on the projection's lean, since a "both-sides"
// candidate is just two picks under the hood.
// -----------------------------------------------------------------
export type ComboCandidate = {
  // Identity (for exposure + uniqueness)
  playerId: number;
  playerName: string;
  team: string | null;
  opponentAbbr: string | null;
  // Synthetic gameId — slate doesn't carry NBA game IDs, but
  // {team}-{opponent} (alphabetized) uniquely identifies a matchup
  // for exposure-cap purposes.
  gameKey: string | null;
  statKey: Last10StatId;
  statLabel: string;

  line: number;
  direction: 'OVER' | 'UNDER';

  // Model state at lock time:
  probability: number;        // 0-100, for the chosen direction
  confidence: number;         // 0-100
  risk: number;               // 0-100
  edgeScore: number;          // 0-100
  projection: number;         // model's projected stat value
  confidenceLabel: string;

  // Derived ranking score (legacy "safest pick" formula). Kept
  // alongside evScore so Safe-mode rankings can fall back to this.
  slateScore: number;

  // EV-engine fields (StatEdge EV spec). edgePercent is the
  // difference between our model probability and a baseline implied
  // probability — positive means we think the market underprices
  // this leg. evScore is the new primary ranker for the slate
  // builder; replaces slateScore for "Balanced EV" mode.
  edgePercent: number;
  evScore: number;
  projectionDistance: number;       // |projection − line|
  projectionDistanceScore: number;  // 0-100 (normalized by σ)
  category: PickCategory;
  trapScore: number;                // 0-100
  trapTier: TrapTier;
  // Fragility — combines trap with the projection's risk score and
  // injury risk into a single "how reliable is this leg in a multi-
  // leg card?" number. Used to surface the weakest leg per card and
  // gate which card sizes the leg can ride on.
  fragilityScore: number;           // 0-100
  fragilityTier: FragilityTier;
  // Largest card size this leg can land on per spec eligibility
  // gates (Best N requires trapScore ≤ size-specific threshold AND
  // confidence ≥ size-specific threshold). 0 when the leg fails
  // the loosest gate (rare — eligibility filter usually catches first).
  maxCardSize: number;

  // MarketDisagreementScore — how aggressively the model disagrees
  // with the market on this line. Combines projection separation
  // (the structural gap), edge% (the probability gap), confidence
  // (how trustworthy the projection is), and calibration strength
  // (constant 50 until ≥100 graded picks). Used as the primary
  // ranker for aggressive/6-man cards per spec — those cards should
  // hunt the strongest disagreements, not the safest probabilities.
  marketDisagreementScore: number;

  // Snapshot fields used by the History grader:
  l10Avg: number;
  vsOppAvg: number | null;
  injuryStatus: string | null;

  // Historical hit metrics (vs the leg's own line + direction). Used
  // by the Wild Card eligibility gate (≥3 of L10, ≥1 vs opp) and by
  // the wildCardScore formula. Computed for every candidate so the
  // History UI can also show "hit X of last Y" for safe legs.
  last10HitCount: number;       // count of L10 games that beat the line
  last10HitRate: number;        // 0-100 — last10HitCount / 10 * 100
  vsOpponentGames: number;      // sample size vs current opponent
  vsOpponentHitCount: number;   // count of vs-opp games that beat the line
  vsOpponentHitRate: number;    // 0-100, or 0 if no vs-opp data
  // Coefficient of variation on last10Values — used by the Wild Card
  // volatility penalty (spec §"-6 if stat is highly volatile").
  statVolatility: number;       // stddev / mean (0+ — higher = more volatile)

  // Volatility archetype label (e.g. "Boom/Bust", "Stable Producer").
  // Snapshotted on legs so the Calibration tab can bucket accuracy by
  // archetype — a Boom/Bust pick missing isn't the same kind of miss
  // as a Stable Producer flopping.
  archetype?: string;

  // Line-raising metadata (Slate Builder spec §"Line Raising Feature").
  // When the model has elite confidence in a line, we test whether
  // a higher line (e.g. Points 14.5 → 18.5) still meets keep
  // thresholds. If yes, we surface the raised version: `line` and
  // `probability` reflect the raised values; `originalLine` and
  // `originalProbability` track what the prop board actually offered.
  // Only set when a raise actually fired.
  originalLine?: number;
  originalProbability?: number;
  lineRaised?: boolean;
  lineRaiseReason?: string;

  // Set only on legs picked for the Wild Card combo. Frontend reads
  // this to render the spec'd "Hit X of last 10 and has hit this line
  // against the current opponent" copy underneath the leg.
  wildCardReason?: string;

  // PrizePicks side-restriction passthrough. A Demon line is over-only
  // and pays a per-leg payout boost (~1.25× standard) — Insane mode
  // hunts these aggressively to stack lottery-style payouts. A Goblin
  // line is under-only and pays less (~0.85×). Standard lines have
  // both sides bookable and pay the table rate.
  isDemon?: boolean;
  isGoblin?: boolean;

  // ---- Phase 101 — Market Intelligence Engine ----
  // See backend/src/services/marketIntel.ts for the full contract.
  // Optional because Wild Card legs created before this layer don't
  // have them; renderers fall back gracefully.
  marketImpliedProb?: number;
  lineInflationScore?: number;
  publicBiasTags?: PublicBiasTag[];
  sharpnessScore?: number;
  edgeDurability?: EdgeDurability;
  whyMarketWrong?: string | null;
};

// Wild Card variants. 'standard' = passes the strict historical gate
// (≥3 of L10 + ≥1 vs opponent). The others are fallbacks that fire
// when the strict gate fails — each carries its own analytical angle
// so the section stays useful without lowering the model's bar.
// 'no_edge' is the explicit transparency signal: nothing qualified
// even at the loosest fallback bar; here are the closest candidates.
export type WildCardKind =
  | 'standard'
  | 'near_miss'
  | 'momentum'
  | 'matchup_spike'
  | 'opportunity_spike'
  | 'boom_bust'
  | 'no_edge';

// Public combo shape. Card label drives both the row key in the UI
// and the friendly display string.
export type Combo = {
  label: 'Best 2' | 'Best 3' | 'Best 4' | 'Best 5' | 'Best 6' | 'Wild Card';
  // Matches spec §"Card Labels" — shown as the secondary copy.
  subtitle: string;
  tag: 'safe' | 'wild';
  legs: ComboCandidate[];
  // Combined hit assuming leg independence (multiply each %):
  rawCombinedHit: number;
  // After applying correlation penalty (spec §"Correlation-Adjusted
  // Combined Probability"). Always ≤ rawCombinedHit; this is what we
  // display on the card.
  adjustedCombinedHit: number;
  correlationRisk: 'None' | 'Low' | 'Medium' | 'High' | 'Very High';
  warnings: string[];

  // Wild Card metadata. Set only on the Wild Card combo (label ===
  // 'Wild Card'); the safe cards leave these undefined. wildCardKind
  // tells the UI which subtitle/copy to render; closestCandidates
  // populates the "no_edge" fallback view with near-miss picks the
  // user can review even when nothing qualifies.
  wildCardKind?: WildCardKind;
  closestCandidates?: ComboCandidate[];

  // EV-engine card metadata. payoutMultiplier is the PrizePicks
  // payout for this card size (2-leg=3x, 3-leg=5x, 4-leg=10x, etc).
  // expectedValue is winProb × payout − stake (per $1 staked):
  // positive = +EV; near-zero = neutral; negative = −EV. The UI
  // surfaces this so users can see "is this card actually worth
  // playing, or just safe?".
  payoutMultiplier?: number;
  expectedValue?: number;          // EV per $1 staked (e.g. +0.42 = +42%)
  evVerdict?: 'Positive EV' | 'Neutral EV' | 'Negative EV';
  // Which PrizePicks play type the payout estimate is based on.
  // 'flex' (default) is the partial-win mode users see on the
  // standard card; 'power' is all-or-nothing, used by Insane mode
  // because that's the only path to ~100× payouts on PrizePicks.
  playType?: 'flex' | 'power';
  // Number of Demon legs on the card. Insane mode hunts these for
  // the per-leg payout boost; surfacing the count lets the UI render
  // "6 Demons stacked → ~18×" copy. (Pre-iter-10 the comment said
  // ~143× — that figure descended from the wrong 1st-place 37.5×
  // table value; real ceiling is 14 × 1.05^6 ≈ 18.7×.)
  demonCount?: number;
  // Average leg edgePercent on this card — quick at-a-glance signal
  // of how much "free probability" the card is capturing.
  averageEdge?: number;
  // Spec §"NEW FRONTEND DISPLAY" — card-level signals so users can
  // tell at a glance whether a card found genuine inefficiency or
  // just stacked safe-looking props.
  averageProjectionGap?: number;          // avg |projection − line|
  trapExposure?: 'Low' | 'Medium' | 'High';
  marketDisagreementRating?: 'Low' | 'Medium' | 'High';

  // Spec §"One-Short Prevention Rule" — surface the weakest leg so
  // users can see what would fail first. Plus a card-level fragility
  // tier and average trap score for quick scanning.
  weakestLegPlayerId?: number;
  weakestLegName?: string;
  weakestLegFragility?: number;           // 0-100
  weakestLegReason?: string;
  cardFragility?: FragilityTier;
  averageTrapScore?: number;              // 0-100
};

// Backwards-compat alias for the snapshot grader. Old snapshots in
// `slate_results.combos` were stored with this shape; the new shape
// is a strict superset (extra fields are optional in old data).
export type ComboLeg = ComboCandidate;

// -----------------------------------------------------------------
// slateScore (spec §"Pick Ranking Formula") — the single number we
// use to rank candidates. Boosts/penalties layered on top of the
// base weighted formula so the ranker can see signal beyond the
// projection's own confidence/risk numbers (e.g. the player's
// recent form, vs-opp matchup history, injury status).
// -----------------------------------------------------------------
function computeSlateScore(c: {
  probability: number;
  confidence: number;
  risk: number;
  edgeScore: number;
  direction: 'OVER' | 'UNDER';
  l10HitRate: number | null;     // 0-100 — % of L10 games OVER the line
  l5HitRate: number | null;
  vsOppHitRate: number | null;
  homeAwayHitRate: number | null;
  sampleSize: number;            // games analyzed
  injuryQuestionable: boolean;
}): number {
  let score =
    c.probability * 0.35 +
    c.confidence * 0.25 +
    c.edgeScore * 0.25 -
    c.risk * 0.15;

  // "Supports direction" = hit rate > 50 for OVER, < 50 for UNDER.
  // Boosts are small (additive, not multiplicative) so a strong base
  // score still wins over a weaker base score with every boost.
  const supports = (rate: number | null): boolean => {
    if (rate === null) return false;
    return c.direction === 'OVER' ? rate > 50 : rate < 50;
  };
  if (supports(c.l10HitRate)) score += 3;
  if (supports(c.l5HitRate)) score += 3;
  if (supports(c.homeAwayHitRate)) score += 2;
  if (supports(c.vsOppHitRate)) score += 2;

  // Penalties:
  if (c.sampleSize < 5) score -= 8;
  if (c.injuryQuestionable) score -= 8;

  return score;
}

// Count how many values in `vals` "beat" the `line` for the given
// direction. For DD (binary 0/1 values), OVER hits when value === 1
// and UNDER hits when value === 0; line is ignored.
function countHits(
  vals: number[],
  line: number,
  direction: 'OVER' | 'UNDER',
  statKey: Last10StatId,
): number {
  if (statKey === 'double_double') {
    return vals.filter((v) => (direction === 'OVER' ? v === 1 : v === 0)).length;
  }
  if (direction === 'OVER') return vals.filter((v) => v > line).length;
  return vals.filter((v) => v < line).length;
}

// Coefficient of variation — stddev / mean. Used as a volatility
// proxy in the Wild Card penalty (spec §"-6 if stat is highly
// volatile"). Returns 0 if mean is 0 or sample is too small to mean
// anything.
function cv(vals: number[]): number {
  if (vals.length < 3) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean === 0) return 0;
  const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

// -----------------------------------------------------------------
// Build candidate list from resolved lines. One candidate per line
// (whose projection has a clear directional lean). OUT players are
// dropped at the source. Picks that fail Eligibility don't appear in
// the eligible pool but we still rank them for Wild Card consideration.
// -----------------------------------------------------------------
function buildCandidates(lines: ResolvedLine[]): EnrichedCandidate[] {
  const out: EnrichedCandidate[] = [];
  for (const l of lines) {
    if (l.injury?.status === 'Out') continue;
    const p = l.projection;
    if (!p || p.noProjection) continue;
    const lean = p.edge.lean;
    if (lean === 'No Clear Edge') continue;
    const isOver = lean.includes('Over');

    // Skip picks where the projection's lean conflicts with the
    // bookable side (Demon = over-only, Goblin = under-only).
    if (l.direction === 'over' && !isOver) continue;
    if (l.direction === 'under' && isOver) continue;

    const direction: 'OVER' | 'UNDER' = isOver ? 'OVER' : 'UNDER';
    const probability = isOver ? p.probability.over : p.probability.under;

    const gameKey =
      l.team && l.vsOpponent?.opponentAbbr
        ? [l.team, l.vsOpponent.opponentAbbr].sort().join('-')
        : null;

    const injStatus = l.injury?.status ?? null;

    // Hit counts vs THIS leg's line + direction. historicalHitRates on
    // the projection is always over-side; for UNDER picks the same
    // values give us under-side counts via direction-aware tally.
    const last10HitCount = countHits(l.last10Values, l.line, direction, l.statKey);
    const last10HitRate = (last10HitCount / Math.max(1, l.last10Values.length)) * 100;
    const vsOppValues = l.vsOpponent?.values ?? [];
    const vsOpponentHitCount = countHits(vsOppValues, l.line, direction, l.statKey);
    const vsOpponentHitRate =
      vsOppValues.length > 0 ? (vsOpponentHitCount / vsOppValues.length) * 100 : 0;
    const statVolatility = cv(l.last10Values);

    const slateScore = computeSlateScore({
      probability,
      confidence: p.confidence.score,
      risk: p.risk.score,
      edgeScore: p.edge.score,
      direction,
      l10HitRate: p.historicalHitRates.last10,
      l5HitRate: p.historicalHitRates.last5,
      vsOppHitRate: p.historicalHitRates.vsOpponent,
      homeAwayHitRate: p.historicalHitRates.homeAway,
      sampleSize: l.gamesAnalyzed,
      injuryQuestionable:
        injStatus === 'Questionable' || injStatus === 'Day-To-Day',
    });

    // EV-engine derivations. Edge% is the per-leg model − implied
    // gap; positive means we think the market underprices this leg.
    // The baseline implied (~55%) is the rough break-even across
    // PrizePicks card sizes; per-card EV uses the size-specific
    // implied at combo-build time.
    const edgePercent = probability - BASELINE_IMPLIED_PROB;
    const projectionDistance = Math.abs(p.projection.final - l.line);
    const projDistScore = projectionDistanceScore(
      p.projection.final,
      l.line,
      direction,
      p.factorBreakdown.blendedStdDev,
    );
    // calibrationStrength is treated as neutral (50) until we have
    // ≥100 graded picks to derive a real per-bucket figure. The
    // formula's static contribution (50 × 0.15 = 7.5) doesn't change
    // ranking; just keeps the formula in spec-shape for later.
    const evScore = computeEvScore({
      edgePercent,
      confidence: p.confidence.score,
      calibrationStrength: 50,
      projectionDistanceScore: projDistScore,
      risk: p.risk.score,
    });
    const seasonAvg = p.factorBreakdown.seasonAvg ?? l.last10Avg;
    const archetypeLabel = l.archetype?.archetype ?? null;
    const trapScore = computeTrapScore({
      direction,
      line: l.line,
      projection: p.projection.final,
      blendedStdDev: p.factorBreakdown.blendedStdDev,
      statKey: l.statKey,
      statVolatility,
      archetype: archetypeLabel,
      injuryStatus: injStatus,
    });
    const fragilityScore = computeFragilityScore({
      trapScore,
      riskScore: p.risk.score,
      injuryRisk: injuryRiskFromStatus(injStatus),
    });
    const maxCardSize = maxCardSizeFor(trapScore, p.confidence.score);
    const category = pickCategory({
      probability,
      edgePercent,
      projectionDistanceScore: projDistScore,
      statVolatility,
    });
    const marketDisagreementScore = computeMarketDisagreement({
      projectionDistanceScore: projDistScore,
      edgePercent,
      confidence: p.confidence.score,
    });
    // seasonAvg held for reference even though the new trap formula
    // doesn't use it; downstream code might.
    void seasonAvg;

    // Phase 101 — market intelligence computed once, attached to the
    // candidate. Survives the strip() into the public ComboCandidate.
    const intel = computeMarketIntel({
      probability,
      edgePercent,
      projection: p.projection.final,
      line: l.line,
      seasonAvg: p.factorBreakdown.seasonAvg ?? l.last10Avg ?? 0,
      l5Avg: p.factorBreakdown.last5Avg,
      l10Avg: l.last10Avg,
      fragilityScore,
      trapScore,
      reasonCodes: p.modelNotes ?? [],
      direction,
      statKey: l.statKey,
    });

    const raw: EnrichedCandidate = {
      playerId: l.playerId,
      playerName: l.playerName,
      team: l.team,
      opponentAbbr: l.vsOpponent?.opponentAbbr ?? null,
      gameKey,
      statKey: l.statKey,
      statLabel: l.statLabel,
      line: l.line,
      direction,
      probability,
      confidence: p.confidence.score,
      risk: p.risk.score,
      edgeScore: p.edge.score,
      projection: p.projection.final,
      confidenceLabel: confidenceLabel(p.confidence.score),
      slateScore,
      edgePercent,
      evScore,
      projectionDistance,
      projectionDistanceScore: projDistScore,
      category,
      trapScore,
      trapTier: trapTierFromScore(trapScore),
      fragilityScore,
      fragilityTier: fragilityTierFromScore(fragilityScore),
      maxCardSize,
      marketDisagreementScore,
      l10Avg: l.last10Avg,
      vsOppAvg: l.vsOpponent?.avg ?? null,
      injuryStatus: injStatus,
      last10HitCount,
      last10HitRate: Math.round(last10HitRate),
      vsOpponentGames: vsOppValues.length,
      vsOpponentHitCount,
      vsOpponentHitRate: Math.round(vsOpponentHitRate),
      statVolatility,
      archetype: l.archetype?.archetype,
      isDemon: l.direction === 'over',
      isGoblin: l.direction === 'under',
      marketImpliedProb: intel.marketImpliedProb,
      lineInflationScore: intel.lineInflationScore,
      publicBiasTags: intel.publicBiasTags,
      sharpnessScore: intel.sharpnessScore,
      edgeDurability: intel.edgeDurability,
      whyMarketWrong: intel.whyMarketWrong,
      context: {
        seasonAvg: p.factorBreakdown.seasonAvg ?? l.last10Avg,
        last5Avg: p.factorBreakdown.last5Avg,
        last5HitRate: p.historicalHitRates.last5,
        minutesMultiplier: p.factorBreakdown.minutesMultiplier,
        usageMultiplier: p.factorBreakdown.usageMultiplier,
        opponentDefenseMultiplier: p.factorBreakdown.opponentDefenseMultiplier,
        blendedStdDev: p.factorBreakdown.blendedStdDev,
        archetype: l.archetype?.archetype ?? null,
      },
    };

    // Try to raise the line. If trigger thresholds aren't met or no
    // raised step survives the keep threshold, returns the raw
    // candidate unchanged.
    const maybeRaised = maybeRaiseLine(raw, p.projection.final, p.factorBreakdown.blendedStdDev);
    out.push(maybeRaised as EnrichedCandidate);
  }
  return out;
}

// Strip the internal `context` block before a candidate goes onto a
// public Combo. Keeps the wire shape clean and stable.
function strip(c: EnrichedCandidate): ComboCandidate {
  const { context: _ctx, ...rest } = c;
  void _ctx;
  return rest;
}

function stripAll(cs: EnrichedCandidate[]): ComboCandidate[] {
  return cs.map(strip);
}

function passesEligibility(c: ComboCandidate, bar: typeof ELIGIBLE | typeof WILD): boolean {
  return (
    c.probability >= bar.probability &&
    c.confidence >= bar.confidence &&
    c.risk <= bar.risk &&
    c.edgeScore >= bar.edge
  );
}

// -----------------------------------------------------------------
// Exposure caps. Spec §"Max Exposure Rules": Best 6 allows up to 2
// per player, 3 per game, 2 per team, 3 per stat. Best 2/3 (the
// safest cores) tighten to 1 per player, 2 per game, 1 per team.
// -----------------------------------------------------------------
type Caps = {
  player: number;
  game: number;
  team: number;
  stat: number;
};

const CAPS_LARGE: Caps = { player: 2, game: 3, team: 2, stat: 3 };
const CAPS_TIGHT: Caps = { player: 1, game: 2, team: 1, stat: 2 };

// Greedy selection: walk candidates in slateScore order, accept each
// one that satisfies the caps and isn't correlated with anything
// already on the card. Stop when we've got `target` legs OR we
// exhaust the pool. Returns whatever we collected — fewer-than-target
// is OK and surfaces as a "limited slate" warning later.
function pickByCaps<T extends ComboCandidate>(
  sorted: T[],
  target: number,
  caps: Caps,
): T[] {
  const playerCount = new Map<number, number>();
  const gameCount = new Map<string, number>();
  const teamCount = new Map<string, number>();
  const statCount = new Map<string, number>();
  const out: T[] = [];

  for (const c of sorted) {
    if (out.length >= target) break;
    if ((playerCount.get(c.playerId) ?? 0) >= caps.player) continue;
    if (c.gameKey && (gameCount.get(c.gameKey) ?? 0) >= caps.game) continue;
    if (c.team && (teamCount.get(c.team) ?? 0) >= caps.team) continue;
    if ((statCount.get(c.statKey) ?? 0) >= caps.stat) continue;

    // Same-player correlated stats — block (e.g. LeBron Points + LeBron PRA).
    const conflict = out.some(
      (p) => p.playerId === c.playerId && statsCorrelated(p.statKey, c.statKey),
    );
    if (conflict) continue;

    out.push(c);
    playerCount.set(c.playerId, (playerCount.get(c.playerId) ?? 0) + 1);
    if (c.gameKey) gameCount.set(c.gameKey, (gameCount.get(c.gameKey) ?? 0) + 1);
    if (c.team) teamCount.set(c.team, (teamCount.get(c.team) ?? 0) + 1);
    statCount.set(c.statKey, (statCount.get(c.statKey) ?? 0) + 1);
  }
  return out;
}

// Diversity-aware picker. Sorts candidates by (usage ASC, slateScore
// DESC) so picks not yet used on a bigger card always come first;
// within the same usage tier, slateScore breaks the tie. Updates the
// shared usage map after the card is built so the next card prefers
// fresh picks.
//
// This replaces the earlier "subset of Best 6" derivation. The user
// explicitly opted into independent cards: when one pick flops, only
// the cards using it lose — not all of them. When the slate has
// fewer eligible picks than the cards need (6+5+4+3+2 = 20 leg
// slots), this gracefully degrades to allowing reuse.
// Stats whose default lines are so low they're often efficiently
// priced: a 0.5 steals OVER hits 60%+ of NBA games naturally, so
// the market doesn't really mispricethem. Per the spec, an aggressive
// 6-man card shouldn't load up on these unless the model sees
// EXTREME edge (≥20%). This filter only fires for aggressive cards.
const LOW_LINE_DOMINANCE_STATS = new Set<Last10StatId>([
  'steals',
  'blocks',
]);
const LOW_LINE_THRESHOLDS: Partial<Record<Last10StatId, number>> = {
  steals: 1.0,        // ≤ 1.0 considered low-line
  blocks: 1.0,
  assists: 2.0,
  rebounds: 2.0,
};

// Edge floor for the low-line dominance override per mode. Aggressive
// allows low lines only when edge ≥20; Insane skips the block entirely
// because lottery-mode users want maximum payout regardless of stat
// volatility. Low lines often resolve to Demons, which carry the
// per-leg payout boost we're hunting for.
const LOW_LINE_OVERRIDE_BY_MODE: Record<ResolvedSlateMode, number> = {
  safe: 999,                  // never matters — Safe doesn't use the block
  balanced: 999,
  aggressive: 20,
  insane: 0,                  // no floor — let any low-line edge through
};

// Mode-aware picker. Resolves the effective mode for the card size,
// applies the mode's edge floor and (for aggressive/insane) the
// low-line dominance block, then defers to pickWithDiversity for the
// ranked selection. Spec §"ADD MINIMUM EDGE REQUIREMENTS" +
// §"NEW LOW-LINE RULE".
function pickModeAware<T extends ComboCandidate>(
  pool: T[],
  target: number,
  caps: Caps,
  usage: Map<string, number>,
  userMode: ResolvedSlateMode,
): T[] {
  const eff = effectiveMode(userMode, target);
  const cfg = MODE_CONFIG[eff];
  let filtered = pool;
  // Edge floor — every mode has one (Balanced's is 0). Drops
  // candidates below the bar before ranking.
  if (cfg.minEdge > 0) {
    filtered = filtered.filter((c) => c.edgePercent >= cfg.minEdge);
  }
  // Low-line dominance block — only aggressive + insane apply it.
  if (eff === 'aggressive' || eff === 'insane') {
    const lowLineFloor = LOW_LINE_OVERRIDE_BY_MODE[eff];
    filtered = filtered.filter((c) => {
      const lineCap = LOW_LINE_THRESHOLDS[c.statKey];
      if (lineCap !== undefined && c.line <= lineCap && c.edgePercent < lowLineFloor) {
        return false;
      }
      return true;
    });
  }
  // At-volume / coin-flip filter (Phase 90). When |line − seasonAvg|
  // sits within 10% of season volume, the prop is a structural coin
  // flip — model edge is mostly noise. Insane mode hard-skips these
  // as anchors per the 2026-05-07 live autopsy memory (Hartenstein
  // U5.5 FGA cracked a live Power Play). Aggressive softens to a
  // probability gate (≥58%) instead of a full skip.
  if (eff === 'insane') {
    filtered = filtered.filter((c) => {
      const ctx = (c as { context?: { seasonAvg: number } }).context;
      if (!ctx || ctx.seasonAvg <= 0) return true;
      const dist = Math.abs(c.line - ctx.seasonAvg);
      const atVolume = dist < ctx.seasonAvg * 0.10;
      return !atVolume;
    });
  } else if (eff === 'aggressive') {
    filtered = filtered.filter((c) => {
      const ctx = (c as { context?: { seasonAvg: number } }).context;
      if (!ctx || ctx.seasonAvg <= 0) return true;
      const dist = Math.abs(c.line - ctx.seasonAvg);
      const atVolume = dist < ctx.seasonAvg * 0.10;
      // Aggressive lets at-volume picks through only if probability is
      // confidently away from 50/50 — gates structural coin-flips out.
      return !atVolume || c.probability >= 58;
    });
  }
  // Fallback: if filters wipe the pool below viable, relax to the
  // un-filtered pool. Better to ship a softer card than nothing.
  if (filtered.length < target) filtered = pool;
  return pickWithDiversity(filtered, target, caps, usage, eff);
}

function pickWithDiversity<T extends ComboCandidate>(
  pool: T[],
  target: number,
  caps: Caps,
  usage: Map<string, number>,
  mode: ResolvedSlateMode,
): T[] {
  // Primary sort: mode-specific score (Safe → slateScore,
  // Balanced → evScore, Aggressive → projection separation + edge).
  // Tiebreakers fall back through evScore then slateScore so cards
  // stay deterministic when the primary score ties.
  const sorted = [...pool].sort((a, b) => {
    const ua = usage.get(comboKey(a)) ?? 0;
    const ub = usage.get(comboKey(b)) ?? 0;
    if (ua !== ub) return ua - ub;
    const sa = modeScore(mode, a);
    const sb = modeScore(mode, b);
    if (sa !== sb) return sb - sa;
    if (a.evScore !== b.evScore) return b.evScore - a.evScore;
    return b.slateScore - a.slateScore;
  });
  const picked = pickByCaps(sorted, target, caps);
  for (const c of picked) {
    usage.set(comboKey(c), (usage.get(comboKey(c)) ?? 0) + 1);
  }
  return picked;
}

// -----------------------------------------------------------------
// Combined hit + correlation penalty (spec §"Correlation-Adjusted
// Combined Probability"). The raw combined % assumes leg independence;
// the adjusted % discounts for known correlation pairs that survived
// the same-player block (e.g. two players on the same team, both
// going OVER, share game-script risk). Correlation tier maps:
//   none  → 1.00x
//   low   → 0.97x  (one cross-player same-game pair)
//   med   → 0.92x  (multiple same-game pairs OR many same-team)
//   high  → 0.85x
//   v.high→ 0.75x  (capped — anything denser than this should get
//                   blocked at selection time anyway)
// -----------------------------------------------------------------
function correlationRisk(legs: ComboCandidate[]): {
  tier: Combo['correlationRisk'];
  multiplier: number;
} {
  // Score: count pairs that share a game OR a team.
  let shared = 0;
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i]!;
      const b = legs[j]!;
      if (a.gameKey && b.gameKey && a.gameKey === b.gameKey) shared += 1;
      else if (a.team && b.team && a.team === b.team) shared += 1;
    }
  }
  if (shared === 0) return { tier: 'None', multiplier: 1.0 };
  if (shared === 1) return { tier: 'Low', multiplier: 0.97 };
  if (shared === 2) return { tier: 'Medium', multiplier: 0.92 };
  if (shared === 3) return { tier: 'High', multiplier: 0.85 };
  return { tier: 'Very High', multiplier: 0.75 };
}

function combinedHits(legs: ComboCandidate[]): {
  raw: number;
  adjusted: number;
  risk: Combo['correlationRisk'];
} {
  if (legs.length === 0) return { raw: 0, adjusted: 0, risk: 'None' };
  const raw = legs.reduce((p, l) => p * (l.probability / 100), 1) * 100;
  const { tier, multiplier } = correlationRisk(legs);
  return {
    raw: round1(raw),
    adjusted: round1(raw * multiplier),
    risk: tier,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Card subtitles — per-size identity. Spec's "different cards =
// different identities": Best 2/3 are Safe Core (anchor picks),
// Best 4 is Balanced EV, Best 5/6 are Aggressive Edge (hunting
// market mispricings, not stacking safe props).
const SUBTITLES: Record<Combo['label'], string> = {
  'Best 2': 'Safe Core · highest probability',
  'Best 3': 'Safe Core · balanced anchor',
  'Best 4': 'Balanced EV · risk-adjusted edge',
  'Best 5': 'Aggressive Edge · projection gaps',
  'Best 6': 'Aggressive Edge · strongest market mispricings',
  'Wild Card': 'Higher Risk · Higher Upside',
};

// Insane-mode override copy. Lottery-ticket framing: low hit rate,
// max upside available on PrizePicks. Numbers reference Power Play
// + Demon-stacked payouts (FAQ weights: 1.05× per Demon).
//   5-leg Power Play, 5 Demons: 20 × 1.05^5 ≈ 25.5×   (5/5 base 20× — VERIFY)
//   6-leg Power Play, 6 Demons: 14 × 1.05^6 ≈ 18.7×   (6/6 base 14× — VERIFIED May 2026)
//
// Pre-iter-10 the 6-leg target was labeled ~50× (33-leg base 37.5× +
// demon stack). That 37.5× was the contest 1st-place leaderboard
// prize, not the 6/6 hit payout. Corrected per user-provided May
// 2026 in-app screenshot: 6/6 standard payout = 14×.
const INSANE_SUBTITLES: Record<Combo['label'], string> = {
  'Best 2': 'Lottery · 2-leg Power Play',
  'Best 3': 'Lottery · 3-leg Power Play',
  'Best 4': 'Lottery · 4-leg Power Play',
  'Best 5': 'Lottery · ~25× target with Demon stack',
  'Best 6': 'Lottery · ~18× target with Demon stack',
  'Wild Card': 'Lottery · maximum-upside fallback',
};

function makeCombo(
  label: Combo['label'],
  legs: ComboCandidate[],
  tag: Combo['tag'],
  userMode: ResolvedSlateMode = 'balanced',
): Combo {
  const { raw, adjusted, risk } = combinedHits(legs);
  const warnings: string[] = [];
  // Spec §"Warning Messages": flag low-leg cards as limited.
  const expected = label === 'Wild Card' ? null : Number(label.split(' ')[1]);
  if (expected !== null && legs.length < expected) {
    warnings.push('Limited slate — not enough strong picks available.');
  }
  if (risk === 'High' || risk === 'Very High') {
    warnings.push('High correlation detected.');
  }
  if (legs.some((l) => l.injuryStatus === 'Questionable' || l.injuryStatus === 'Day-To-Day')) {
    warnings.push('Injury uncertainty detected.');
  }

  // EV-engine card metadata. Use the size-specific PrizePicks payout.
  // Wild Card and the not-yet-fully-built cards (legs.length < target)
  // borrow the closest payout tier.
  const cardSize =
    label === 'Wild Card'
      ? Math.max(2, Math.min(6, legs.length))
      : (Number(label.split(' ')[1]) || legs.length);
  // Insane mode targets PrizePicks Power Play (all-or-nothing) — the
  // only PrizePicks structure where 6-leg cards can pay ~37.5×+ before
  // Demon stacking. Other modes show Flex Play rates (8.4× on 6-leg)
  // because that's what users actually see on the standard card.
  const playType: 'flex' | 'power' = userMode === 'insane' ? 'power' : 'flex';
  const payoutMultiplier = estimateCardPayout(legs, playType);
  const demonCount = legs.filter((l) => l.isDemon).length;
  let expectedValue: number | undefined;
  let evVerdict: Combo['evVerdict'];
  let averageEdge: number | undefined;
  if (payoutMultiplier !== undefined && legs.length > 0) {
    // EV per $1 staked = (winProb × payout) − 1. Use the
    // correlation-adjusted combined hit since that's the realistic
    // expectation; raw assumes independence the legs may not have.
    const winProb = adjusted / 100;
    expectedValue = winProb * payoutMultiplier - 1;
    if (expectedValue >= 0.10) evVerdict = 'Positive EV';
    else if (expectedValue >= -0.05) evVerdict = 'Neutral EV';
    else evVerdict = 'Negative EV';

    // Average leg edge — quick "how mispriced is this card?" signal
    // shown on the card chrome. Computed against the size-specific
    // implied-per-leg probability for accuracy.
    const impliedThis = impliedPerLegProb(cardSize);
    const sumEdge = legs.reduce((s, l) => s + (l.probability - impliedThis), 0);
    averageEdge = round1(sumEdge / legs.length);

    // Negative EV gets a warning so users see the trade-off plainly.
    if (evVerdict === 'Negative EV') {
      warnings.push(
        `Negative EV — payout ${payoutMultiplier}× × ${(adjusted).toFixed(0)}% combined hit doesn't beat the implied break-even.`,
      );
    }
  }

  // Trap exposure — count of legs at High or Extreme trap tier.
  // Surface as both a warning and a card-level metric.
  const trappy = legs.filter(
    (l) => l.trapTier === 'High Trap Risk' || l.trapTier === 'Extreme Trap Risk',
  );
  if (trappy.length > 0) {
    warnings.push(
      `${trappy.length} leg${trappy.length === 1 ? '' : 's'} flagged as possible public-trap line — interpret with caution.`,
    );
  }
  // Trap exposure rating: 0 trap legs = Low; 1 = Medium; 2+ = High.
  const trapExposure: Combo['trapExposure'] =
    trappy.length === 0 ? 'Low' : trappy.length === 1 ? 'Medium' : 'High';

  // Card-level signals (spec §"NEW FRONTEND DISPLAY"). These render
  // on the card chrome so the user can see at a glance whether the
  // slate found genuine inefficiency or just stacked safe-looking
  // props. Empty cards leave them undefined.
  let averageProjectionGap: number | undefined;
  let marketDisagreementRating: Combo['marketDisagreementRating'];
  let averageTrapScore: number | undefined;
  let weakestLegPlayerId: number | undefined;
  let weakestLegName: string | undefined;
  let weakestLegFragility: number | undefined;
  let weakestLegReason: string | undefined;
  let cardFragility: FragilityTier | undefined;
  if (legs.length > 0) {
    const sumGap = legs.reduce((s, l) => s + (l.projectionDistance ?? 0), 0);
    averageProjectionGap = round1(sumGap / legs.length);
    const sumMd = legs.reduce((s, l) => s + (l.marketDisagreementScore ?? 0), 0);
    const avgMd = sumMd / legs.length;
    // Tier: <40 Low, 40-60 Medium, ≥60 High. Calibrated against the
    // expected range of marketDisagreementScore on real slates.
    marketDisagreementRating =
      avgMd >= 60 ? 'High' : avgMd >= 40 ? 'Medium' : 'Low';

    // Average trap score across legs.
    const sumTrap = legs.reduce((s, l) => s + (l.trapScore ?? 0), 0);
    averageTrapScore = round1(sumTrap / legs.length);

    // Weakest leg — highest fragility score on the card. Drives the
    // one-short prevention warning ("Luke Kornet is the weakest leg
    // on this card — minutes instability + thin margin"). When all
    // legs are Strong, we still surface the highest one as info but
    // skip the explicit warning.
    let worst = legs[0]!;
    for (const leg of legs) {
      if ((leg.fragilityScore ?? 0) > (worst.fragilityScore ?? 0)) worst = leg;
    }
    weakestLegPlayerId = worst.playerId;
    weakestLegName = worst.playerName;
    weakestLegFragility = worst.fragilityScore;
    cardFragility = worst.fragilityTier;
    weakestLegReason = describeFragility(worst);

    // Card-size eligibility check (spec §"Card Eligibility Rules").
    // Bigger cards require cleaner legs. If any leg's trap score
    // exceeds the size-specific threshold, surface a warning so the
    // user knows what's fragile. We don't drop the card outright —
    // showing it with a warning is better UX than silent removal.
    const expected = label === 'Wild Card' ? null : Number(label.split(' ')[1]);
    if (expected !== null) {
      const gate = CARD_SIZE_GATES[expected];
      if (gate) {
        const overTrap = legs.filter((l) => (l.trapScore ?? 0) > gate.maxTrap).length;
        const underConf = legs.filter((l) => (l.confidence ?? 0) < gate.minConfidence).length;
        if (overTrap > 0) {
          warnings.push(
            `${overTrap} leg${overTrap === 1 ? '' : 's'} exceed${overTrap === 1 ? 's' : ''} the trap-score gate for a ${expected}-leg card (≤${gate.maxTrap}) — consider a smaller card.`,
          );
        }
        if (underConf > 0) {
          warnings.push(
            `${underConf} leg${underConf === 1 ? '' : 's'} below the confidence floor (≥${gate.minConfidence}) for a ${expected}-leg card.`,
          );
        }
      }
    }
    if (cardFragility === 'Do Not Use') {
      warnings.push(
        `Card fragility is "Do Not Use" — at least one leg has compounded trap + risk + injury exposure that makes large cards unreliable. Recommend trimming.`,
      );
    }
  }

  return {
    label,
    subtitle:
      userMode === 'insane' ? INSANE_SUBTITLES[label] : SUBTITLES[label],
    tag,
    legs,
    rawCombinedHit: raw,
    adjustedCombinedHit: adjusted,
    correlationRisk: risk,
    warnings,
    payoutMultiplier:
      payoutMultiplier !== undefined ? round2(payoutMultiplier) : undefined,
    expectedValue: expectedValue !== undefined ? round2(expectedValue) : undefined,
    evVerdict,
    averageEdge,
    playType,
    demonCount,
    averageProjectionGap,
    trapExposure,
    marketDisagreementRating,
    weakestLegPlayerId,
    weakestLegName,
    weakestLegFragility,
    weakestLegReason,
    cardFragility,
    averageTrapScore,
  };
}

// Human-readable explanation of why this leg is the most fragile.
// Picks the strongest contributing factor (thin margin / high trap /
// injury / etc) and surfaces it as the "fragility reason".
function describeFragility(leg: ComboCandidate): string {
  const reasons: string[] = [];
  // Margin check — projection thinly above line is the most
  // important fragility signal.
  if (leg.projectionDistance !== undefined && leg.projectionDistanceScore !== undefined) {
    if (leg.projectionDistanceScore < 25) reasons.push('thin projection margin');
  }
  if (leg.injuryStatus && leg.injuryStatus !== 'Probable') {
    reasons.push(`${leg.injuryStatus.toLowerCase()} injury status`);
  }
  if (leg.statVolatility >= 0.4) reasons.push('high stat volatility');
  if (leg.archetype === 'Boom/Bust' || leg.archetype === 'Minutes Sensitive') {
    reasons.push(`${leg.archetype.toLowerCase()} archetype`);
  }
  const lowEvent = STAT_TYPE_RISK[leg.statKey] ?? 0;
  if (lowEvent >= 60) reasons.push('low-event stat type');
  if (reasons.length === 0) return `Highest combined trap + risk on this card.`;
  return reasons.slice(0, 2).join(' + ') + '.';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// -----------------------------------------------------------------
// Public entry point.
// -----------------------------------------------------------------
export type SlateCombosResult = {
  combos: Combo[];
  // The mode actually used to construct the combos. When the request
  // came in as 'auto', this reports which underlying mode the
  // resolver picked (so the UI can render "Auto · using Aggressive
  // tonight"). For explicit modes, equals the request mode.
  resolvedMode: ResolvedSlateMode;
};

export function buildCombos(
  lines: ResolvedLine[],
  mode: SlateMode = 'balanced',
): SlateCombosResult {
  const allCandidates = buildCandidates(lines);
  const eligible = allCandidates
    .filter((c) => passesEligibility(c, ELIGIBLE));

  // Resolve auto mode based on slate quality. Weak slates stay Safe;
  // dense high-edge slates get unlocked into Aggressive or Insane.
  const resolvedMode: ResolvedSlateMode =
    mode === 'auto' ? resolveAutoMode(eligible) : mode;
  const cfg = MODE_CONFIG[resolvedMode];

  // Build cards LARGEST → SMALLEST so the strongest mode-aligned
  // picks land on Best 6 first. Card sizes outside the resolved
  // mode's allowedSizes are suppressed (Safe drops 5/6, Aggressive
  // drops 2, Insane drops 2/3) so each mode has a distinct identity.
  const usage = new Map<string, number>();
  const wantSize = (n: number): boolean => cfg.allowedSizes.has(n);
  const best6 = wantSize(6) ? pickModeAware(eligible, 6, CAPS_LARGE, usage, resolvedMode) : [];
  const best5 = wantSize(5) ? pickModeAware(eligible, 5, CAPS_LARGE, usage, resolvedMode) : [];
  const best4 = wantSize(4) ? pickModeAware(eligible, 4, CAPS_LARGE, usage, resolvedMode) : [];
  const best3 = wantSize(3) ? pickModeAware(eligible, 3, CAPS_TIGHT, usage, resolvedMode) : [];
  const best2 = wantSize(2) ? pickModeAware(eligible, 2, CAPS_TIGHT, usage, resolvedMode) : [];

  const combos: Combo[] = [];
  // Order matches what the rail renders left-to-right (Best 2 → 6).
  if (best2.length === 2) combos.push(makeCombo('Best 2', stripAll(best2), 'safe', resolvedMode));
  if (best3.length === 3) combos.push(makeCombo('Best 3', stripAll(best3), 'safe', resolvedMode));
  if (best4.length === 4) combos.push(makeCombo('Best 4', stripAll(best4), 'safe', resolvedMode));
  if (best5.length === 5) combos.push(makeCombo('Best 5', stripAll(best5), 'safe', resolvedMode));
  if (best6.length >= 2) combos.push(makeCombo('Best 6', stripAll(best6), 'safe', resolvedMode));

  // Wild Card — riskier but still data-supported. Walks a priority
  // chain (spec §"Wild Card Fallback Priority Order"):
  //   1. Standard Wild Card: ≥3 of L10 + ≥1 vs opponent
  //   2. Near Miss: barely missed the strict gate
  //   3. Momentum: trend rising fast
  //   4. Matchup Spike: opponent vulnerability + projection above line
  //   5. Opportunity Spike: minutes/usage expansion from injuries
  //   6. Boom/Bust: high variance archetype with elevated ceiling
  //   7. No Edge: emit closest candidates with explanatory copy
  //
  // First category that has enough qualifying picks wins. Each emits
  // a labeled Wild Card combo so the user can see what kind of edge
  // (or absence of edge) we found.
  const best2Combo = combos.find((c) => c.label === 'Best 2');
  const usedKeys = new Set<string>();
  for (const combo of combos) {
    for (const leg of combo.legs) usedKeys.add(comboKey(leg));
  }

  function passesWildHistorical(c: ComboCandidate): boolean {
    return c.last10HitCount >= 3 && c.vsOpponentHitCount >= 1;
  }

  // Score each Wild Card candidate per spec formula, with boosts and
  // penalties. Returns score + the boost/penalty tags so the reason
  // text can mention them.
  function scoreWild(c: ComboCandidate): {
    score: number;
    tags: string[];
  } {
    const tags: string[] = [];
    let score =
      c.probability * 0.25 +
      c.confidence * 0.15 +
      c.edgeScore * 0.20 +
      c.last10HitRate * 0.20 +
      c.vsOpponentHitRate * 0.10 -
      c.risk * 0.10;

    // --- Boosts -----------------------------------------------------
    if (c.last10HitCount >= 5) {
      score += 8;
      tags.push(`hit ${c.last10HitCount} of last 10`);
    }
    if (c.vsOpponentHitCount >= 2) {
      score += 6;
      tags.push(`${c.vsOpponentHitCount}× vs opponent`);
    }
    // Projection ≥ 1 stddev above (or below for UNDER) the line.
    // We approximate stddev from the last10Values CV * mean — close
    // enough for ranking purposes.
    const stddev = c.statVolatility * Math.max(1, c.l10Avg);
    if (stddev > 0) {
      const distance =
        c.direction === 'OVER' ? c.projection - c.line : c.line - c.projection;
      if (distance / stddev >= 1) {
        score += 5;
        tags.push('projection ≥ 1σ above line');
      }
    }
    // +4 line raised. The candidate already had elite triggers
    // (prob ≥70, conf ≥70, risk ≤55) and survived the keep threshold
    // at a higher line — Wild Card weights this because it's the
    // exact "high-edge, line moves" pattern the section is built for.
    if (c.lineRaised) {
      score += 4;
      tags.push('line raised');
    }
    // Opportunity Boost — same multi-signal nudge used by Aggressive
    // mode. Rewards picks where L5/L10 vs season + minutes-up +
    // projection-separation all agree, gated by trap-not-extreme. Helps
    // Wild Card prefer accelerating-opportunity picks over flat ones
    // when both pass the historical gate.
    const oppBoost = opportunityBoost(c);
    if (oppBoost > 0) {
      score += oppBoost;
      tags.push('opportunity expansion');
    }
    // +3 role increased due to teammate injury — stub: teammate-injury
    // context not yet plumbed. Skip.
    if (
      c.last10HitRate >= 50 &&
      c.vsOpponentHitRate >= 50 &&
      c.vsOpponentGames >= 2
    ) {
      // Use this as a proxy for "home/away supports" since we don't
      // currently disambiguate H/A on ResolvedLine — the historical
      // hit rates already factor in venue mix.
      score += 2;
    }
    // +3 minutes trending up. context.minutesMultiplier compares
    // projected vs season-avg minutes. ≥1.05 means a real role bump
    // (not just rounding noise). Aligned with the Phase 28 spec —
    // Wild Card rewards expansion patterns.
    const minCtx = (c as { context?: { minutesMultiplier: number } }).context;
    if (minCtx && minCtx.minutesMultiplier >= 1.05) {
      score += 3;
      tags.push(`minutes ×${minCtx.minutesMultiplier.toFixed(2)} trending up`);
    }

    // --- Penalties --------------------------------------------------
    if (c.last10HitCount === 3) {
      score -= 10;
      tags.push('borderline L10 sample');
    }
    if (c.vsOpponentGames === 1) {
      score -= 8;
      tags.push('only 1 vs-opponent game');
    }
    if (c.injuryStatus === 'Questionable' || c.injuryStatus === 'Day-To-Day') {
      score -= 8;
      tags.push('injury uncertain');
    }
    // -6 blowout risk — stub: pace/spread data not on ResolvedLine.
    if (c.statVolatility >= 0.5) {
      score -= 6;
      tags.push('volatile stat');
    }
    // -5 if correlated with a Best 2 leg (same player, correlated stat).
    if (best2Combo) {
      const correlatedWithBest2 = best2Combo.legs.some(
        (b) => b.playerId === c.playerId && statsCorrelated(b.statKey, c.statKey),
      );
      if (correlatedWithBest2) {
        score -= 5;
        tags.push('overlaps Best 2 core');
      }
    }

    return { score, tags };
  }

  // -----------------------------------------------------------------
  // Wild Card priority chain. Each tier has its own qualification.
  // First tier with ≥3 qualifying picks wins. If none qualifies, fall
  // through to the "no edge" view with closest candidates.
  // -----------------------------------------------------------------
  const unusedPool = allCandidates.filter((c) => !usedKeys.has(comboKey(c)));
  const MIN_LEGS = 3;        // emit any tier that produces this many legs
  const TARGET_LEGS = 6;     // ideal Wild Card size

  // Tier 1: STANDARD — passes both historical gates.
  const standardPool = unusedPool
    .filter((c) => passesEligibility(c, WILD))
    .filter(passesWildHistorical);
  const wildCard = (() => {
    if (standardPool.length >= MIN_LEGS) {
      const scored = standardPool
        .map((c) => ({ c, ...scoreWild(c) }))
        .sort((a, b) => b.score - a.score);
      const legs = pickByCaps(scored.map((x) => x.c), TARGET_LEGS, CAPS_LARGE).map((c) => ({
        ...c,
        wildCardReason: buildWildCardReason(c, scored.find((s) => s.c === c)?.tags ?? []),
      }));
      if (legs.length >= MIN_LEGS) {
        return {
          kind: 'standard' as const,
          subtitle: 'Higher Risk — meets historical Wild Card gates',
          legs: stripAll(legs),
        };
      }
    }
    return null;
  })()
    // Tier 2: NEAR MISS — barely missed the strict gate.
    ?? (() => {
      const pool = unusedPool.filter((c) => {
        // Two ways to "barely miss":
        //   - 2 of L10 with at least 1 vs-opp hit
        //   - 3+ of L10 with 0 vs-opp hits but only 1 matchup sample
        const hist =
          (c.last10HitCount === 2 && c.vsOpponentHitCount >= 1)
          || (c.last10HitCount >= 3 && c.vsOpponentHitCount === 0 && c.vsOpponentGames === 1);
        if (!hist) return false;
        // Stricter floors than WILD per spec §"Near Miss" requirements:
        if (c.probability < 56) return false;
        if (c.confidence < 50) return false;
        if (c.edgeScore < 40) return false;
        if (c.risk > 75) return false;
        // Projection above line in the chosen direction:
        const beats = c.direction === 'OVER' ? c.projection > c.line : c.projection < c.line;
        return beats;
      });
      if (pool.length < MIN_LEGS) return null;
      const sorted = [...pool].sort((a, b) => b.slateScore - a.slateScore);
      const legs = pickByCaps(sorted, TARGET_LEGS, CAPS_LARGE).map((c) => ({
        ...c,
        wildCardReason: buildNearMissReason(c),
      }));
      if (legs.length < MIN_LEGS) return null;
      return {
        kind: 'near_miss' as const,
        subtitle: 'Near Miss — almost qualified under standard rules',
        legs: stripAll(legs),
      };
    })()
    // Tier 3: MOMENTUM — last 5 trending fast above season.
    ?? (() => {
      const pool = unusedPool.filter((c) => {
        if (!passesEligibility(c, WILD)) return false;
        const ctx = c.context;
        if (ctx.last5Avg === null || ctx.last5HitRate === null) return false;
        const momentumScore = ctx.last5Avg - ctx.seasonAvg;
        // Threshold: last5 ahead of season by ≥1 stat unit OR ≥10% of season
        const meaningful = momentumScore >= 1 || momentumScore >= ctx.seasonAvg * 0.10;
        if (!meaningful) return false;
        // Last-5 hit rate ≥ 60% in chosen direction (rate is over-side;
        // for UNDER picks, "supports direction" = rate ≤ 40%).
        const last5HitInDir = c.direction === 'OVER'
          ? ctx.last5HitRate
          : 100 - ctx.last5HitRate;
        if (last5HitInDir < 60) return false;
        // Minutes trending up — minutesMultiplier > 1.0 means projected
        // > season minutes.
        if (ctx.minutesMultiplier < 1.02) return false;
        return true;
      });
      if (pool.length < MIN_LEGS) return null;
      const sorted = [...pool].sort((a, b) => {
        const ma = a.context.last5Avg! - a.context.seasonAvg;
        const mb = b.context.last5Avg! - b.context.seasonAvg;
        return mb - ma;
      });
      const legs = pickByCaps(sorted, TARGET_LEGS, CAPS_LARGE).map((c) => ({
        ...c,
        wildCardReason: `L5 avg ${(c.context.last5Avg ?? 0).toFixed(1)} vs season ${c.context.seasonAvg.toFixed(1)} · minutes trending up`,
      }));
      if (legs.length < MIN_LEGS) return null;
      return {
        kind: 'momentum' as const,
        subtitle: 'Momentum — recent form and usage rising fast',
        legs: stripAll(legs),
      };
    })()
    // Tier 4: MATCHUP SPIKE — opponent vulnerability + projection above line.
    ?? (() => {
      const pool = unusedPool.filter((c) => {
        if (!passesEligibility(c, WILD)) return false;
        // opponentDefenseMultiplier > 1.0 means the opponent is bad
        // defensively vs this stat — a soft matchup. Threshold 1.04
        // approximately corresponds to top-third vulnerability.
        if (c.context.opponentDefenseMultiplier < 1.04) return false;
        // Projection materially above line — at least 1.5σ above for
        // OVER, below for UNDER.
        const dist = c.direction === 'OVER' ? c.projection - c.line : c.line - c.projection;
        const sigma = c.context.blendedStdDev || 1;
        if (dist / sigma < 1.0) return false;
        return true;
      });
      if (pool.length < MIN_LEGS) return null;
      const sorted = [...pool].sort((a, b) =>
        b.context.opponentDefenseMultiplier - a.context.opponentDefenseMultiplier,
      );
      const legs = pickByCaps(sorted, TARGET_LEGS, CAPS_LARGE).map((c) => ({
        ...c,
        wildCardReason: `Soft matchup vs ${c.opponentAbbr ?? 'opp'} · projection above line`,
      }));
      if (legs.length < MIN_LEGS) return null;
      return {
        kind: 'matchup_spike' as const,
        subtitle: 'Matchup Spike — opponent vulnerable to this stat tonight',
        legs: stripAll(legs),
      };
    })()
    // Tier 5: OPPORTUNITY SPIKE — minutes/usage expansion (injuries).
    ?? (() => {
      const pool = unusedPool.filter((c) => {
        if (!passesEligibility(c, WILD)) return false;
        const minutesUp = c.context.minutesMultiplier >= 1.12;
        const usageUp = c.context.usageMultiplier >= 1.08;
        if (!minutesUp && !usageUp) return false;
        // Projection above line in the chosen direction:
        const beats = c.direction === 'OVER' ? c.projection > c.line : c.projection < c.line;
        return beats;
      });
      if (pool.length < MIN_LEGS) return null;
      const sorted = [...pool].sort((a, b) =>
        (b.context.minutesMultiplier + b.context.usageMultiplier)
        - (a.context.minutesMultiplier + a.context.usageMultiplier),
      );
      const legs = pickByCaps(sorted, TARGET_LEGS, CAPS_LARGE).map((c) => ({
        ...c,
        wildCardReason: `Minutes ×${c.context.minutesMultiplier.toFixed(2)} · usage ×${c.context.usageMultiplier.toFixed(2)} — role expanding`,
      }));
      if (legs.length < MIN_LEGS) return null;
      return {
        kind: 'opportunity_spike' as const,
        subtitle: 'Opportunity Spike — projected role expansion creates upside',
        legs: stripAll(legs),
      };
    })()
    // Tier 6: BOOM/BUST — high variance archetype with elevated ceiling.
    ?? (() => {
      const pool = unusedPool.filter((c) => {
        // Looser bar than WILD per spec — risk cap is 85, no probability floor.
        if (c.probability < 52) return false;
        if (c.confidence < 45) return false;
        if (c.risk > 85) return false;
        const isVolatile = c.context.archetype === 'Boom/Bust' || c.statVolatility >= 0.40;
        if (!isVolatile) return false;
        // 90th-percentile estimate ≈ projection + 1.28σ (one-sided).
        // Require it to clear the line in the chosen direction by a
        // margin (the "elevated ceiling" check).
        const sigma = c.context.blendedStdDev || 1;
        const ceiling = c.direction === 'OVER'
          ? c.projection + 1.28 * sigma
          : c.projection - 1.28 * sigma;
        const beats = c.direction === 'OVER' ? ceiling > c.line + sigma * 0.3 : ceiling < c.line - sigma * 0.3;
        return beats;
      });
      if (pool.length < MIN_LEGS) return null;
      const sorted = [...pool].sort((a, b) => b.statVolatility - a.statVolatility);
      const legs = pickByCaps(sorted, TARGET_LEGS, CAPS_LARGE).map((c) => ({
        ...c,
        wildCardReason: `${c.context.archetype ?? 'Volatile'} archetype · ceiling well above line`,
      }));
      if (legs.length < MIN_LEGS) return null;
      return {
        kind: 'boom_bust' as const,
        subtitle: 'Boom/Bust — high variance with elevated ceiling',
        legs: stripAll(legs),
      };
    })()
    // Tier 7 (LAST RESORT): NO EDGE — surface closest candidates.
    ?? (() => {
      // Spec §"Closest Candidate Logic" — sort the WILD-eligibility
      // pool by edge*0.35 + prob*0.25 + conf*0.20 - risk*0.20 and
      // surface the top 2-3 so the user can see how close we got.
      const pool = unusedPool.filter((c) => passesEligibility(c, WILD));
      const closest = [...pool]
        .sort((a, b) => closestScore(b) - closestScore(a))
        .slice(0, 3);
      return {
        kind: 'no_edge' as const,
        subtitle: 'No Strong Wild Card Available Tonight',
        legs: [] as ComboCandidate[],
        closestCandidates: stripAll(closest),
      };
    })();

  // Emit the Wild Card combo with its kind metadata. Even the
  // no_edge case is emitted so the rail always has the slot.
  const wildCombo = makeCombo('Wild Card', wildCard.legs, 'wild', resolvedMode);
  wildCombo.subtitle = wildCard.subtitle;
  wildCombo.wildCardKind = wildCard.kind;
  if ('closestCandidates' in wildCard && wildCard.closestCandidates) {
    wildCombo.closestCandidates = wildCard.closestCandidates;
  }
  if (wildCard.kind === 'no_edge') {
    wildCombo.warnings.push(
      'The model did not identify a high-upside opportunity that met the minimum thresholds tonight.',
    );
  } else if (wildCard.kind !== 'standard') {
    wildCombo.warnings.push(
      'Standard Wild Card gates not met — fallback category surfaced instead.',
    );
  }
  combos.push(wildCombo);

  return { combos, resolvedMode };
}

// Closest-candidates score (spec §"Closest Candidate Logic"). Used
// when no fallback category produces a viable Wild Card; surfaces
// the best near-misses so the section stays informative.
function closestScore(c: ComboCandidate): number {
  return c.edgeScore * 0.35 + c.probability * 0.25 + c.confidence * 0.20 - c.risk * 0.20;
}

// Reason copy for Near Miss legs — explains why the pick didn't pass
// the strict historical gate but still has analytical value.
function buildNearMissReason(c: ComboCandidate): string {
  if (c.last10HitCount === 2 && c.vsOpponentHitCount >= 1) {
    return `Hit 2 of last 10 + ${c.vsOpponentHitCount} vs opp — one short of standard`;
  }
  if (c.last10HitCount >= 3 && c.vsOpponentGames === 1 && c.vsOpponentHitCount === 0) {
    return `Hit ${c.last10HitCount} of last 10 · only 1 prior vs ${c.opponentAbbr ?? 'opp'} (no hit)`;
  }
  return `Hit ${c.last10HitCount} of last 10 — almost qualified`;
}

// Compose a one-sentence "why this is a Wild Card" line. Drawn from
// the boost/penalty tags collected during scoring so each leg's copy
// reflects the actual reasoning ("hit 5 of last 10 and 2× vs opp").
function buildWildCardReason(c: ComboCandidate, tags: string[]): string {
  const parts: string[] = [];
  parts.push(`Hit ${c.last10HitCount} of last 10`);
  if (c.vsOpponentHitCount >= 1) {
    parts.push(
      c.vsOpponentHitCount > 1
        ? `${c.vsOpponentHitCount}× vs ${c.opponentAbbr ?? 'this opponent'}`
        : `hit this line vs ${c.opponentAbbr ?? 'this opponent'}`,
    );
  }
  let sentence = parts.join(' · ');
  // Append the most consequential caveat if any penalty fired.
  const caveat = tags.find((t) =>
    t === 'borderline L10 sample'
    || t === 'only 1 vs-opponent game'
    || t === 'injury uncertain'
    || t === 'volatile stat',
  );
  if (caveat) sentence += ` (${caveat})`;
  return sentence;
}

function comboKey(c: ComboCandidate): string {
  return `${c.playerId}-${c.statKey}-${c.line}-${c.direction}`;
}

// Stat label fallback used when older snapshots don't carry the
// statLabel field. Looks up the canonical label from last10's map.
export function labelForStat(key: Last10StatId): string {
  return LAST10_LABELS[key] ?? String(key);
}
