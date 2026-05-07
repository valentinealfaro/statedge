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
import type { PlayerArchetype } from './playerArchetype.js';
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

  // Derived ranking score (spec §"Pick Ranking Formula"):
  slateScore: number;

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

  // Set only on legs picked for the Wild Card combo. Frontend reads
  // this to render the spec'd "Hit X of last 10 and has hit this line
  // against the current opponent" copy underneath the leg.
  wildCardReason?: string;
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

    out.push({
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
      l10Avg: l.last10Avg,
      vsOppAvg: l.vsOpponent?.avg ?? null,
      injuryStatus: injStatus,
      last10HitCount,
      last10HitRate: Math.round(last10HitRate),
      vsOpponentGames: vsOppValues.length,
      vsOpponentHitCount,
      vsOpponentHitRate: Math.round(vsOpponentHitRate),
      statVolatility,
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
    });
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
function pickWithDiversity<T extends ComboCandidate>(
  pool: T[],
  target: number,
  caps: Caps,
  usage: Map<string, number>,
): T[] {
  const sorted = [...pool].sort((a, b) => {
    const ua = usage.get(comboKey(a)) ?? 0;
    const ub = usage.get(comboKey(b)) ?? 0;
    if (ua !== ub) return ua - ub;
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

// Card subtitles. Cards are now built independently (no shared picks
// when the slate has enough candidates), so the safest picks anchor
// Best 6 and smaller cards use different picks. Subtitles emphasize
// that each card is its own ticket — submit them in parallel and one
// bad leg only knocks out the cards that included it.
const SUBTITLES: Record<Combo['label'], string> = {
  'Best 2': 'Compact Ticket',
  'Best 3': 'Balanced Ticket',
  'Best 4': 'Mid Ticket',
  'Best 5': 'Wide Ticket',
  'Best 6': 'Max Ticket — anchors the safest picks',
  'Wild Card': 'Higher Risk',
};

function makeCombo(
  label: Combo['label'],
  legs: ComboCandidate[],
  tag: Combo['tag'],
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
  return {
    label,
    subtitle: SUBTITLES[label],
    tag,
    legs,
    rawCombinedHit: raw,
    adjustedCombinedHit: adjusted,
    correlationRisk: risk,
    warnings,
  };
}

// -----------------------------------------------------------------
// Public entry point.
// -----------------------------------------------------------------
export type SlateCombosResult = {
  combos: Combo[];
};

export function buildCombos(lines: ResolvedLine[]): SlateCombosResult {
  const allCandidates = buildCandidates(lines);
  const eligible = allCandidates
    .filter((c) => passesEligibility(c, ELIGIBLE))
    .sort((a, b) => b.slateScore - a.slateScore);

  // Build cards LARGEST → SMALLEST so the safest 6 picks land on
  // Best 6 first. Each subsequent card prefers picks not yet used on
  // a bigger card (diversity-first); when the slate is too small for
  // full independence, the shared `usage` map drives graceful sharing.
  const usage = new Map<string, number>();
  const best6 = pickWithDiversity(eligible, 6, CAPS_LARGE, usage);
  const best5 = pickWithDiversity(eligible, 5, CAPS_LARGE, usage);
  const best4 = pickWithDiversity(eligible, 4, CAPS_LARGE, usage);
  const best3 = pickWithDiversity(eligible, 3, CAPS_TIGHT, usage);
  const best2 = pickWithDiversity(eligible, 2, CAPS_TIGHT, usage);

  const combos: Combo[] = [];
  // Order matches what the rail renders left-to-right (Best 2 → 6).
  if (best2.length === 2) combos.push(makeCombo('Best 2', stripAll(best2), 'safe'));
  if (best3.length === 3) combos.push(makeCombo('Best 3', stripAll(best3), 'safe'));
  if (best4.length === 4) combos.push(makeCombo('Best 4', stripAll(best4), 'safe'));
  if (best5.length === 5) combos.push(makeCombo('Best 5', stripAll(best5), 'safe'));
  if (best6.length >= 2) combos.push(makeCombo('Best 6', stripAll(best6), 'safe'));

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
    // +4 line raised — stub: line raising is staged for a follow-up,
    // so this never fires today. Reason tag preserved for future work.
    // +3 minutes trending up — stub: minutes time series not yet
    // exposed on ResolvedLine. Skip.
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
  const wildCombo = makeCombo('Wild Card', wildCard.legs, 'wild');
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

  return { combos };
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
