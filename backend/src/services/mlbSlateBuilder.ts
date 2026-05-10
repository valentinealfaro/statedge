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
import { buildMlbWildCard, type MlbWildCardCombo } from './mlbWildCardBuilder.js';

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
  // earned" principle. Larger cards demand higher edge concentration
  // AND lower per-leg fragility (per L8 spec: rotate fragile picks
  // out of larger cards). Each leg in a 6-stack compounds failure;
  // tighter caps keep the multiplied probability honest.
  perSize: Partial<Record<number, { minAvgEdge: number; maxLegFragility?: number }>>;
}> = {
  safe: {
    label: 'Safe',
    minLegProb: 65,
    minLegEdge: 5,
    maxLegTrap: 40,
    allowedSizes: new Set([2, 3, 4]),
    perSize: {
      2: { minAvgEdge: 5,  maxLegFragility: 75 },
      3: { minAvgEdge: 7,  maxLegFragility: 65 },
      4: { minAvgEdge: 9,  maxLegFragility: 55 },
    },
  },
  balanced: {
    label: 'Balanced',
    minLegProb: 55,
    minLegEdge: 5,
    maxLegTrap: 50,
    allowedSizes: new Set([2, 3, 4, 5, 6]),
    // Phase 31: bumped Best 5/6 minAvgEdge per spec — "Best 6 should
    // NOT feel weak. Increase edge requirement, projection separation,
    // market lag leverage."
    perSize: {
      2: { minAvgEdge: 5,  maxLegFragility: 80 },
      3: { minAvgEdge: 7,  maxLegFragility: 70 },
      4: { minAvgEdge: 9,  maxLegFragility: 60 },
      5: { minAvgEdge: 14, maxLegFragility: 55 },     // +2 (was 12)
      6: { minAvgEdge: 17, maxLegFragility: 50 },     // +3 (was 14)
    },
  },
  aggressive: {
    label: 'Aggressive',
    minLegProb: 50,
    minLegEdge: 12,
    maxLegTrap: 60,
    allowedSizes: new Set([3, 4, 5, 6]),
    perSize: {
      3: { minAvgEdge: 12, maxLegFragility: 80 },
      4: { minAvgEdge: 14, maxLegFragility: 70 },
      5: { minAvgEdge: 18, maxLegFragility: 60 },     // +2 (was 16)
      6: { minAvgEdge: 22, maxLegFragility: 55 },     // +4 (was 18)
    },
  },
  insane: {
    // Lottery-ticket mode (per feedback_insane_lottery_framing memory).
    // Power Play 5/6-leg only — that's where the payouts live. Edge
    // floor stays modest because lottery users explicitly accept losing.
    // Fragility cap relaxed — lottery users opt in to fragile picks
    // for the ceiling. Phase 31: edge bar raised on Best 6 because
    // spec demands "controlled high-volatility exposure" not random.
    label: 'Insane',
    minLegProb: 45,
    minLegEdge: 8,
    maxLegTrap: 70,
    allowedSizes: new Set([5, 6]),
    perSize: {
      5: { minAvgEdge: 14, maxLegFragility: 85 },     // +2 (was 12)
      6: { minAvgEdge: 16, maxLegFragility: 80 },     // +2 (was 14)
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
  // ±1σ projection band (NBA convention). Lets the cross-sport
  // ProjectionBand visualization render the confidence interval next
  // to the line on /best-bets and slate cards.
  rangeLow: number;
  rangeHigh: number;
  edgePercent: number;
  riskScore: number;
  trapScore: number;
  // L5 — surfaced so slate UI can show fragility next to trap.
  // 0..100 + tier label.
  fragilityScore: number;
  fragilityTier: 'Solid Floor' | 'Moderate Fragility' | 'Fragile' | 'Very Fragile';
  // L2 composite (50 = neutral, ≥65 = real momentum). Surfaced so slate
  // UI can highlight the high-momentum picks the Aggressive + Wild Card
  // tiebreakers leaned on.
  momentumExpansionScore: number;
  reasonCodes: string[];
  isPitcher: boolean;
  gamePk: number | null;
  bookableSide: 'over' | 'under' | 'both';

  // Phase 101 — Market Intelligence fields. See marketIntel.ts. Every
  // slate leg now carries explicit market-implied probability, public-
  // bias tags, line-inflation, sharpness, durability, and the
  // 'why market is wrong' narrative.
  marketImpliedProb: number;
  lineInflationScore: number;
  publicBiasTags: string[];        // PublicBiasTag[] — string for JSON
  sharpnessScore: number;
  edgeDurability: 'stable' | 'mixed' | 'fragile';
  whyMarketWrong: string | null;
};

export type MlbComboCorrelationRisk =
  | 'None'
  | 'Low'
  | 'Medium'
  | 'High'
  | 'Very High';

export type MlbCombo = {
  label: 'Best 2' | 'Best 3' | 'Best 4' | 'Best 5' | 'Best 6';
  subtitle: string;
  size: number;
  legs: MlbComboLeg[];
  rawCombinedHit: number;          // Π probabilities, no correlation penalty
  // Adjusted for correlation: legs that share a game (same gameKey)
  // or same team are penalized because they share game-script /
  // weather / pitcher-vs-lineup risk. Mission-aligned honesty —
  // independent-leg math overstates combined hit on stacked games.
  adjustedCombinedHit: number;
  correlationRisk: MlbComboCorrelationRisk;
  correlationPairs: number;        // count of same-game/team leg pairs
  averageEdge: number;
  averageTrap: number;
  weakestLegName: string;
  weakestLegReason: string;
  // Construction notes — plain-language explanation of WHAT the
  // engine built. Surfaces the new institutional rules so users
  // see the diversification work.
  constructionNotes: {
    uniquePlayers: number;
    uniqueStats: number;
    uniqueGames: number;
    uniqueTeams: number;
    sameTeamMaxStack: number;
    samePlayerMaxStack: number;
    summary: string;            // human-readable one-liner
  };
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
  // Wild Card slot. Always populated (the builder falls through to a
  // 'no_edge' tier with closest candidates when no real Wild Card
  // qualifies — never blank, never trash).
  wildCard: MlbWildCardCombo;
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
// separation + momentum; Insane leans toward edge + momentum + projection
// separation with minimal risk penalty.
//
// Aggressive + Insane lead with momentumExpansionScore per the
// 2026-05-08 Wild Card philosophy memo: "Wild Card = controlled
// market-inefficiency portfolio." Players whose recent production +
// season-vs-L10 trend + projection separation cluster up are the
// signal we want — not just edge%. Edge is preserved as the second
// pillar so we never pick a momentum-up name with no actual edge.
function legScore(leg: ResolvedMlbLine, mode: MlbResolvedSlateMode): number {
  const p = leg.projection;
  const m = leg.signals.momentumExpansionScore;
  switch (mode) {
    case 'safe':
      return p.probability * 0.50 + p.confidence * 0.30 - p.riskScore * 0.10 - p.trapScore * 0.10;
    case 'balanced':
      return p.evScore * 0.50 + p.probability * 0.20 + p.edgePercent * 0.20 - p.trapScore * 0.10;
    case 'aggressive':
      return m * 0.35 + p.edgePercent * 0.30 + p.projectionDistanceScore * 0.20 + p.confidence * 0.05 - p.trapScore * 0.10;
    case 'insane': {
      // Insane PREFERS rare-event stats (HR / SB / triples) per spec.
      // The base score is the same edge/separation/momentum mix; the
      // preferred-stat bonus tips the ranking toward upside asymmetry.
      const base =
        m * 0.30 + p.edgePercent * 0.30 + p.projectionDistanceScore * 0.30
        + p.evScore * 0.10 - p.trapScore * 0.05;
      const statBonus = INSANE_PREFERRED_STATS[leg.statKey] ?? 0;
      return base + statBonus;
    }
  }
}

// Per-card same-player cap. Per the 2026-05-08 MLB Slate Engine
// spec example: "Aaron Judge Hits + Total Bases + Runs" is GOOD
// (different volatility curves, all from offensive opportunity),
// but adding HR/RBI on top creates "catastrophic dependency on
// single offensive outcome." So the real rule is: cap same-player
// legs at 3 on small cards (where users want concentrated edge),
// 2 on size-5+ ("6-leg should behave like a diversified portfolio,
// NOT a fan-made same-game stack" per spec).
function maxLegsPerPlayer(cardSize: number): number {
  if (cardSize >= 5) return 2;
  return 3;
}

// HR/triples are MAGNET stats — one swing of the bat triggers
// every offensive prop for that player simultaneously (HR adds 4
// TB + 1 R + ≥1 RBI). Pairing HR with TB/Runs/RBI/Hits on the
// same player same card creates the catastrophic dependency the
// spec calls out as BAD. Block it explicitly.
const HR_MAGNET_STATS = new Set<string>(['home_runs', 'triples']);
const HR_DEPENDENT_STATS = new Set<string>([
  'rbis', 'runs', 'total_bases', 'hits', 'hits_runs_rbis', 'hitter_fantasy_score',
]);

// Returns true if adding this leg to the existing player's leg set
// would create the spec's "catastrophic dependency on single
// offensive outcome" anti-pattern.
function createsHrDependency(
  newStat: string,
  existingStats: Set<string>,
): boolean {
  if (HR_MAGNET_STATS.has(newStat)) {
    // Adding a HR/triples leg — block if any HR-dependent stat already.
    for (const s of existingStats) if (HR_DEPENDENT_STATS.has(s)) return true;
  }
  if (HR_DEPENDENT_STATS.has(newStat)) {
    // Adding hits/TB/runs/RBI — block if HR/triples already there.
    for (const s of existingStats) if (HR_MAGNET_STATS.has(s)) return true;
  }
  return false;
}

// Per-mode stat blocklist. Per spec L8/Slate-Engine: Safe mode must
// avoid HR / SB / RBI props — they're inherently fragile and break
// the survivability promise.
const SAFE_BLOCKED_STATS = new Set<string>([
  'home_runs', 'stolen_bases', 'rbis', 'triples', 'home_runs_allowed',
]);

// Insane mode actively PREFERS rare / high-leverage / asymmetric
// payoff stats. Spec: "Goal — maximum upside asymmetry. Examples:
// HR props, stolen bases, low-line expansion, extreme weather
// leverage, pitch-type mismatch." Per-stat bonus added to legScore
// in insane mode.
const INSANE_PREFERRED_STATS: Partial<Record<string, number>> = {
  home_runs: 15,
  stolen_bases: 15,
  triples: 12,
  doubles: 8,
  home_runs_allowed: 10,
};

// Per-game offensive-over cap. Tightened per the Exposure Control
// & Portfolio Protection Engine spec: every card ≥3 legs caps
// same-game exposure at 2. Best 2 has only 2 legs anyway, so
// effectively the rule is "no card may have >2 legs from the same
// game." This kills the bullpen-collapse / weather-out / pitcher-
// dominates failure modes that used to wipe Best 5+6 together.
function maxLegsPerGame(cardSize: number): number {
  if (cardSize >= 3) return 2;
  return 4;     // Best 2 unrestricted (only 2 legs total)
}

// ---------- Stat family taxonomy ----------
//
// Slates that load up on strikeouts-only or HRs-only fail in correlated
// ways: one weather event, one ace-pitcher dominant night, etc. The
// portfolio engine penalizes over-concentration in any one family
// across the whole slate. Family ids are used by both intra-card caps
// AND slate-wide exposure tracking.
const STAT_FAMILY_MAP: Record<string, string> = {
  // Production — single offensive opportunity rolls all of these
  hits:                'production',
  total_bases:         'production',
  runs:                'production',
  rbis:                'production',
  hits_runs_rbis:      'production',
  hitter_fantasy_score:'production',
  // Power — rare-event, asymmetric upside
  home_runs:           'power',
  triples:             'power',
  doubles:             'power',
  // Discipline — plate skills, lower correlation w/ team scoring
  walks:               'discipline',
  hit_by_pitch:        'discipline',
  strikeouts:          'discipline',     // hitter K
  // Speed
  stolen_bases:        'speed',
  // Pitcher — separate families because they move with different forces
  pitcher_strikeouts:  'pitcher_dominance',
  outs_recorded:       'pitcher_volume',
  pitching_outs:       'pitcher_volume',
  pitcher_fantasy_score: 'pitcher_volume',
  hits_allowed:        'pitcher_damage',
  earned_runs_allowed: 'pitcher_damage',
  walks_allowed:       'pitcher_damage',
  home_runs_allowed:   'pitcher_damage',
};

function statFamilyOf(statKey: string): string {
  return STAT_FAMILY_MAP[statKey] ?? 'other';
}

// Per-card same-family cap. Spec calls out 6 strikeouts on Best 6 as
// the BAD anti-pattern. We hard-cap large cards (5/6) at 3 same-family
// legs so the worst monoculture is impossible. Smaller cards (2-4)
// are intentionally NOT family-capped — focused 2-3-4-leg cards on
// one stat type are valid plays (e.g. an ace-pitcher Ks-stack on an
// elite K matchup) and the slate-wide family penalty already pushes
// LATER cards to rotate.
function maxLegsPerFamilyInCard(cardSize: number): number {
  if (cardSize >= 5) return 3;
  return cardSize;     // no in-card cap on Best 2/3/4
}

// ---------- Slate-wide exposure tracker (Phase 58) ----------
//
// Counts each player / game / team / stat-family across cards already
// committed in this slate build. Subsequent card builds apply a soft
// penalty proportional to prior exposure so the slate as a whole
// looks like a DIVERSIFIED PORTFOLIO instead of a copy-paste of the
// best individual props onto every card.

type SlateExposure = {
  player: Map<number, number>;
  game: Map<string, number>;
  team: Map<string, number>;
  family: Map<string, number>;
};

function newSlateExposure(): SlateExposure {
  return {
    player: new Map(),
    game: new Map(),
    team: new Map(),
    family: new Map(),
  };
}

function addLegToExposure(exp: SlateExposure, leg: ResolvedMlbLine): void {
  exp.player.set(leg.playerId, (exp.player.get(leg.playerId) ?? 0) + 1);
  if (leg.gameKey) exp.game.set(leg.gameKey, (exp.game.get(leg.gameKey) ?? 0) + 1);
  if (leg.team.abbr) exp.team.set(leg.team.abbr, (exp.team.get(leg.team.abbr) ?? 0) + 1);
  const fam = statFamilyOf(leg.statKey);
  exp.family.set(fam, (exp.family.get(fam) ?? 0) + 1);
}

// "Core institutional exposure" — the only legs allowed to repeat on
// 4+ cards. Per spec: highest confidence + lowest fragility + clean
// edge + no trap-tier flags. Strict on purpose; this should be the
// minority of any slate.
function isInstitutionalGrade(leg: ResolvedMlbLine): boolean {
  const p = leg.projection;
  return p.probability >= 70
    && p.edgePercent  >= 12
    && p.confidence   >= 70
    && p.fragilityScore <= 40
    && p.trapScore    <= 35;
}

// Hard slate-wide exposure cap. Tightened in response to a real
// failure mode: same player on multiple cards meant one missed line
// took down every ticket simultaneously. New caps: standard picks
// max 2 cards, institutional max 3. The Phase 58 spec ceiling
// (4 / 5) was too permissive in practice — concentration risk from
// reused players outweighs the small EV gain from picking the same
// strong leg twice.
function maxCardAppearances(leg: ResolvedMlbLine): number {
  return isInstitutionalGrade(leg) ? 3 : 2;
}

// Soft penalty applied to legScore when picking subsequent cards.
// Tightened: 2nd appearance is now meaningfully expensive so the
// optimizer prefers a fresh player even when the duplicate has
// slightly higher raw edge. Diversification beats marginal edge
// because correlated misses compound — losing 4 cards to one missed
// line is much worse than losing 1.
function exposurePenalty(leg: ResolvedMlbLine, exp: SlateExposure): number {
  let penalty = 0;
  // Player exposure — the dominant signal. New schedule starts the
  // penalty immediately on the 2nd appearance. The hard cap blocks
  // entries past index 2/3, but the schedule still keeps the
  // optimizer leaning toward different players.
  const playerPrior = exp.player.get(leg.playerId) ?? 0;
  const isInst = isInstitutionalGrade(leg);
  const playerSchedule = isInst
    ? [0,  6, 24,   60, 1000, 1000]
    : [0, 12, 40, 1000, 1000, 1000];
  penalty += playerSchedule[Math.min(playerPrior, 5)] ?? 1000;

  // Game exposure — same-game across cards = environmental fragility
  // (weather, bullpen, pitcher dominance hit every leg simultaneously).
  if (leg.gameKey) {
    const gPrior = exp.game.get(leg.gameKey) ?? 0;
    if (gPrior >= 2) penalty += (gPrior - 1) * 4;
  }
  // Team exposure — softer than game but still real.
  if (leg.team.abbr) {
    const tPrior = exp.team.get(leg.team.abbr) ?? 0;
    if (tPrior >= 2) penalty += (tPrior - 1) * 2.5;
  }
  // Stat-family monoculture — start penalizing once a family hits 3
  // appearances across the slate. Stops Ks-on-every-card.
  const fam = statFamilyOf(leg.statKey);
  const fPrior = exp.family.get(fam) ?? 0;
  if (fPrior >= 3) penalty += (fPrior - 2) * 1.5;
  return penalty;
}

function diversifiedScore(
  leg: ResolvedMlbLine,
  mode: MlbResolvedSlateMode,
  exp: SlateExposure,
): number {
  return legScore(leg, mode) - exposurePenalty(leg, exp);
}

// Per-team-side cap. Spec: "same-team hitter overs" is dangerous
// because a team scoring zero kills multiple legs. Allow 2 same-
// team OVER hitters max per card. (UNDER picks for the OPPOSING
// pitcher are different — they ARE positively correlated with the
// hitter UNDERs but the spec wants those grouped, not blocked.)
function teamSideKey(line: ResolvedMlbLine): string | null {
  if (!line.team.abbr) return null;
  // Hitters key by team + direction; pitchers don't trigger this
  // (one starting pitcher per team, not a stack risk).
  if (line.isPitcher) return null;
  return `${line.team.abbr}::${line.modelDirection}`;
}
function maxLegsPerTeamSide(cardSize: number): number {
  if (cardSize >= 5) return 2;
  return 3;
}

// Pick top-N legs with same-player + stat-family + correlation
// rules + slate-wide exposure penalty (Phase 58 portfolio engine).
//
// `slateExposure` is OPTIONAL. When provided, it:
//   1. Re-ranks the pool so legs already heavily used on prior cards
//      sink in priority (soft penalty).
//   2. Applies the slate-wide hard cap — a player who's already on
//      4 cards (5 if institutional) is blocked entirely from this
//      card so the spec's "no player on all 6 cards" rule holds.
//   3. Caps stat-family concentration WITHIN this card so we don't
//      ship a Best-6 of all strikeouts.
// When `slateExposure` is null we fall back to plain legScore — used
// by tests and any future caller that wants to pick a single card
// without slate-context. Production builds always pass exposure.
function pickTopN(
  pool: ResolvedMlbLine[],
  n: number,
  mode: MlbResolvedSlateMode,
  slateExposure: SlateExposure | null = null,
): ResolvedMlbLine[] {
  // Apply per-mode stat blocklists BEFORE ranking.
  const filtered = mode === 'safe'
    ? pool.filter((l) => !SAFE_BLOCKED_STATS.has(l.statKey))
    : pool;
  const ranked = [...filtered].sort((a, b) =>
    slateExposure
      ? diversifiedScore(b, mode, slateExposure) - diversifiedScore(a, mode, slateExposure)
      : legScore(b, mode) - legScore(a, mode),
  );
  const picked: ResolvedMlbLine[] = [];
  const playerLegCount = new Map<number, number>();
  const playerStatsUsed = new Map<number, Set<string>>();
  const gameLegCount = new Map<string, number>();
  const teamSideLegCount = new Map<string, number>();
  const familyLegCount = new Map<string, number>();
  const cap = maxLegsPerPlayer(n);
  const gameCap = maxLegsPerGame(n);
  const teamSideCap = maxLegsPerTeamSide(n);
  const famCap = maxLegsPerFamilyInCard(n);
  for (const l of ranked) {
    // Slate-wide HARD cap: respects Phase 58 spec "NO player on all 6
    // cards." Institutional-grade picks may go to 5 of 6 slots; the
    // rest top out at 4. Bypassed when no exposure tracker provided.
    if (slateExposure) {
      const slatePrior = slateExposure.player.get(l.playerId) ?? 0;
      if (slatePrior >= maxCardAppearances(l)) continue;
    }
    const seen = playerLegCount.get(l.playerId) ?? 0;
    if (seen >= cap) continue;
    const usedStats = playerStatsUsed.get(l.playerId) ?? new Set();
    // Block exact duplicate stat for same player (Hits+Hits is just a
    // double-down, not diversification).
    if (usedStats.has(l.statKey)) continue;
    // HR-pairing block: per spec, HR/triples + RBI/Runs/TB/Hits on
    // the same player on the same card = catastrophic dependency.
    if (createsHrDependency(l.statKey, usedStats)) continue;
    // Same-game stack cap.
    const gameKey = l.gameKey;
    if (gameKey) {
      const gameSeen = gameLegCount.get(gameKey) ?? 0;
      if (gameSeen >= gameCap) continue;
    }
    // Same-team-direction stack cap (hitters only).
    const tsKey = teamSideKey(l);
    if (tsKey) {
      const tsSeen = teamSideLegCount.get(tsKey) ?? 0;
      if (tsSeen >= teamSideCap) continue;
    }
    // Within-card stat-family cap. Stops a Best 6 from being all-Ks
    // or all-HRs (the "boring + public" / "fragile correlation"
    // anti-patterns the Exposure Engine spec calls out).
    const fam = statFamilyOf(l.statKey);
    const famSeen = familyLegCount.get(fam) ?? 0;
    if (famSeen >= famCap) continue;
    picked.push(l);
    playerLegCount.set(l.playerId, seen + 1);
    usedStats.add(l.statKey);
    playerStatsUsed.set(l.playerId, usedStats);
    if (gameKey) gameLegCount.set(gameKey, (gameLegCount.get(gameKey) ?? 0) + 1);
    if (tsKey) teamSideLegCount.set(tsKey, (teamSideLegCount.get(tsKey) ?? 0) + 1);
    familyLegCount.set(fam, famSeen + 1);
    if (picked.length >= n) break;
  }
  return picked;
}

function combinedHit(legs: ResolvedMlbLine[]): number {
  let p = 1;
  for (const l of legs) p *= l.projection.probability / 100;
  return Math.round(p * 1000) / 10;     // 0-100, 1 decimal
}

// Correlation penalty per the NBA spec we're now porting to MLB.
// Counts pairs of legs that share a game (same gameKey) OR same
// team (cross-game stacks like two Yankees hitters on different
// nights are NOT penalized — only same-game / same-team-same-night).
// Tier multiplier:
//   None      → 1.00× (independent)
//   Low       → 0.97× (1 same-game pair)
//   Medium    → 0.92× (2 pairs)
//   High      → 0.85× (3 pairs)
//   Very High → 0.75× (4+ pairs — capped here, denser stacks should
//                       have been blocked at selection time)
export function computeCorrelationRisk(
  legs: ResolvedMlbLine[],
): { tier: MlbComboCorrelationRisk; multiplier: number; pairs: number } {
  let pairs = 0;
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i]!;
      const b = legs[j]!;
      // Same game (strongest correlation): same gameKey.
      if (a.gameKey && b.gameKey && a.gameKey === b.gameKey) {
        pairs += 1;
        continue;
      }
      // Same team on the same slate is a softer signal — usually
      // means same game, but if gameKeys differ (rare data-quality
      // issue) team-only still indicates correlation.
      if (a.team.id !== null && b.team.id !== null && a.team.id === b.team.id) {
        pairs += 1;
      }
    }
  }
  if (pairs === 0) return { tier: 'None',      multiplier: 1.00, pairs };
  if (pairs === 1) return { tier: 'Low',       multiplier: 0.97, pairs };
  if (pairs === 2) return { tier: 'Medium',    multiplier: 0.92, pairs };
  if (pairs === 3) return { tier: 'High',      multiplier: 0.85, pairs };
  return            { tier: 'Very High',       multiplier: 0.75, pairs };
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
    // Iter-10 corrected ceilings: 6-leg Power Play 6/6 = 14× verified
    // May 2026; with all-Demon stack 14 × 1.05⁶ ≈ 18.7×. Pre-iter-10
    // claimed ~50× — that was the contest 1st-place number, not the
    // actual 6/6 payout.
    return size === 6
      ? 'Lottery · ~18× target with Demon stack'
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

  const raw = combinedHit(legs);
  const corr = computeCorrelationRisk(legs);
  const adjusted = Math.round(raw * corr.multiplier * 10) / 10;

  // Construction notes — plain-language explanation of what the
  // engine actually did (Phases 28-32 made these decisions visible).
  const constructionNotes = computeConstructionNotes(legs);

  return {
    label,
    subtitle: subtitleFor(mode, size),
    size,
    legs: legs.map(toComboLeg),
    rawCombinedHit: raw,
    adjustedCombinedHit: adjusted,
    correlationRisk: corr.tier,
    correlationPairs: corr.pairs,
    averageEdge: avg(legs.map((l) => l.projection.edgePercent)),
    averageTrap: avg(legs.map((l) => l.projection.trapScore)),
    weakestLegName: worst.playerName,
    weakestLegReason,
    constructionNotes,
  };
}

function computeConstructionNotes(legs: ResolvedMlbLine[]): MlbCombo['constructionNotes'] {
  const players = new Map<number, number>();
  const stats = new Set<string>();
  const games = new Set<string>();
  const teams = new Map<string, number>();
  for (const l of legs) {
    players.set(l.playerId, (players.get(l.playerId) ?? 0) + 1);
    stats.add(l.statKey);
    if (l.gameKey) games.add(l.gameKey);
    if (l.team.abbr) teams.set(l.team.abbr, (teams.get(l.team.abbr) ?? 0) + 1);
  }
  const sameTeamMax = teams.size > 0 ? Math.max(...teams.values()) : 0;
  const samePlayerMax = players.size > 0 ? Math.max(...players.values()) : 0;

  // Compose summary based on the actual diversification profile.
  const parts: string[] = [];
  parts.push(
    `${players.size} player${players.size === 1 ? '' : 's'}` +
    ` · ${stats.size} stat type${stats.size === 1 ? '' : 's'}`,
  );
  if (games.size > 0) {
    parts.push(`${games.size} game${games.size === 1 ? '' : 's'}`);
  }
  if (samePlayerMax >= 2) {
    parts.push(`${samePlayerMax}-stat stack on top player`);
  }
  if (sameTeamMax >= 3) {
    parts.push(`${sameTeamMax} legs same team`);
  }
  // Headline verdict.
  let verdict: string;
  if (legs.length >= 5 && players.size === legs.length && games.size >= legs.length - 1) {
    verdict = 'Diversified portfolio.';
  } else if (samePlayerMax >= 3) {
    verdict = 'Concentrated star-stack.';
  } else if (sameTeamMax >= legs.length - 1) {
    verdict = 'Heavy team stack.';
  } else {
    verdict = 'Balanced.';
  }
  return {
    uniquePlayers: players.size,
    uniqueStats: stats.size,
    uniqueGames: games.size,
    uniqueTeams: teams.size,
    sameTeamMaxStack: sameTeamMax,
    samePlayerMaxStack: samePlayerMax,
    summary: `${verdict} ${parts.join(' · ')}.`,
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
    // Phase 101 — pass through market intel fields from the projection.
    marketImpliedProb: l.projection.marketImpliedProb,
    lineInflationScore: l.projection.lineInflationScore,
    publicBiasTags: l.projection.publicBiasTags,
    sharpnessScore: l.projection.sharpnessScore,
    edgeDurability: l.projection.edgeDurability,
    whyMarketWrong: l.projection.whyMarketWrong,
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

  // Phase 58 — Exposure Control & Portfolio Protection Engine.
  //
  // The previous algorithm built the LARGEST card first and derived
  // smaller cards as strict subsets. That maximized internal coherence
  // but produced catastrophic portfolio fragility — the same player
  // showed up on every card, so one bad night sank the whole slate.
  //
  // The new algorithm walks sizes ASCENDING (Best 2 → Best 6) and
  // tracks slate-wide exposure across player / game / team / stat-
  // family. Each subsequent card pays a soft penalty for reusing
  // already-exposed picks, so larger cards naturally rotate in fresh
  // names. A hard cap (4 of 6 slots, or 5 for institutional-grade)
  // prevents any single player from dominating the entire slate.
  //
  // Best 2 still gets the highest-confidence picks — by going first
  // it has the cleanest pool. Best 6 by going last is the most
  // diversified — exactly the spec's "feels like a professionally
  // diversified portfolio" goal.
  const slateExposure = newSlateExposure();
  const sizes = [...cfg.allowedSizes].sort((a, b) => a - b);

  for (const size of sizes) {
    const label = (`Best ${size}`) as MlbCombo['label'];
    const sizeFragCap = cfg.perSize[size]?.maxLegFragility;
    const sizePool = sizeFragCap !== undefined
      ? eligible.filter((l) => l.projection.fragilityScore <= sizeFragCap)
      : eligible;
    if (sizePool.length < size) {
      slots.push({
        size,
        label,
        combo: null,
        reason: sizeFragCap !== undefined && sizePool.length < eligible.length
          ? `Not enough sturdy legs (≤${sizeFragCap} fragility) for a ${size}-stack: have ${sizePool.length}, need ${size}.`
          : `Not enough eligible legs (have ${sizePool.length}, need ${size}).`,
      });
      continue;
    }
    // Diversified pick: respects intra-card caps + slate-wide exposure
    // penalty + hard cap on max card appearances per player.
    const picks = pickTopN(sizePool, size, resolvedMode, slateExposure);
    if (picks.length < size) {
      slots.push({
        size,
        label,
        combo: null,
        reason:
          `Not enough diversified legs to fill ${size}: only ${picks.length} pass intra-card ` +
          `caps + slate-wide exposure limits. Smaller cards already absorbed the strongest ` +
          `non-overlapping picks.`,
      });
      continue;
    }
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
    // Commit this card's legs into slate exposure so subsequent cards
    // diversify away from these names / games / families.
    for (const leg of picks) addLegToExposure(slateExposure, leg);
  }
  // Already in ascending order, no re-sort needed.

  // Wild Card — must feel "independent, sharp, less public" per spec.
  // We hard-exclude players who already appear on 3+ Best cards so
  // Wild Card never reads as a copy of Best 6. Mild reuse (2 prior
  // cards) is OK if Wild Card's own scoring formula picks them up
  // — that means the same name is genuinely the strongest signal in
  // multiple lenses, not just lazy duplication.
  const heavySlatePlayers = new Set<number>();
  for (const [pid, cnt] of slateExposure.player) {
    if (cnt >= 3) heavySlatePlayers.add(pid);
  }
  const wildCard = buildMlbWildCard(lines, heavySlatePlayers);

  return { resolvedMode, combos: slots, wildCard };
}

// ---------- Re-exports for tests ----------

export { MODE_CONFIG, eligibleLegs, legScore, pickTopN, combinedHit };
