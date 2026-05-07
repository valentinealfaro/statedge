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
import type { ResolvedLine } from './slatePipeline.js';

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
// Correlation map. Highly-correlated stats from the SAME PLAYER on
// the same card amplify variance — if Points misses badly, PRA tends
// to miss too. We block these combinations (spec §"Same Player Rule"
// and §"Correlation Risk Rules"). Cross-player correlation (game
// script, opposing players) is harder to model with current data;
// not enforced in V1.
// -----------------------------------------------------------------
const CORRELATED_STATS: Record<string, readonly Last10StatId[]> = {
  points: ['pra', 'pr', 'pa'],
  pra: ['points', 'pr', 'pa', 'ra', 'rebounds', 'assists'],
  pr: ['points', 'rebounds', 'pra'],
  pa: ['points', 'assists', 'pra'],
  ra: ['rebounds', 'assists', 'pra'],
  rebounds: ['pra', 'pr', 'ra', 'offensive_rebounds', 'defensive_rebounds'],
  assists: ['pra', 'pa', 'ra'],
  blocks: ['stocks'],
  steals: ['stocks'],
  stocks: ['blocks', 'steals'],
  three_pt_made: ['fg_made'],
  fg_made: ['three_pt_made', 'fg_attempted'],
  fg_attempted: ['fg_made'],
  ft_made: ['ft_attempted'],
  ft_attempted: ['ft_made'],
  offensive_rebounds: ['rebounds'],
  defensive_rebounds: ['rebounds'],
};

function statsCorrelated(a: Last10StatId, b: Last10StatId): boolean {
  if (a === b) return true;
  return CORRELATED_STATS[a]?.includes(b) ?? false;
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
};

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

// -----------------------------------------------------------------
// Build candidate list from resolved lines. One candidate per line
// (whose projection has a clear directional lean). OUT players are
// dropped at the source. Picks that fail Eligibility don't appear in
// the eligible pool but we still rank them for Wild Card consideration.
// -----------------------------------------------------------------
function buildCandidates(lines: ResolvedLine[]): ComboCandidate[] {
  const out: ComboCandidate[] = [];
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
    });
  }
  return out;
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
function pickByCaps(
  sorted: ComboCandidate[],
  target: number,
  caps: Caps,
): ComboCandidate[] {
  const playerCount = new Map<number, number>();
  const gameCount = new Map<string, number>();
  const teamCount = new Map<string, number>();
  const statCount = new Map<string, number>();
  const out: ComboCandidate[] = [];

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

// Top-down derivation. Best N (for N < 6) = the top N legs of Best 6
// by slateScore that ALSO satisfy the tighter caps for that card
// size (Best 2/3 use CAPS_TIGHT; Best 4/5 reuse CAPS_LARGE since
// they're already inside the Best 6 envelope).
function deriveSubset(
  best6: ComboCandidate[],
  target: number,
  caps: Caps,
): ComboCandidate[] {
  const sorted = [...best6].sort((a, b) => b.slateScore - a.slateScore);
  return pickByCaps(sorted, target, caps);
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

const SUBTITLES: Record<Combo['label'], string> = {
  'Best 2': 'Safest Core',
  'Best 3': 'Balanced Core',
  'Best 4': 'Strong Slate',
  'Best 5': 'Full Slate',
  'Best 6': 'Max Slate',
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

  // Build Best 6 first (spec §"Building Best 6"). Greedy by
  // slateScore with full exposure caps + correlation block.
  const best6 = pickByCaps(eligible, 6, CAPS_LARGE);

  const combos: Combo[] = [];
  if (best6.length >= 2) {
    // Top-down derivations from Best 6 (spec §"Building Best 5/4/3/2"):
    const best5 = deriveSubset(best6, 5, CAPS_LARGE);
    const best4 = deriveSubset(best6, 4, CAPS_LARGE);
    const best3 = deriveSubset(best6, 3, CAPS_TIGHT);
    const best2 = deriveSubset(best6, 2, CAPS_TIGHT);

    // Order matches what the rail renders left-to-right.
    if (best2.length === 2) combos.push(makeCombo('Best 2', best2, 'safe'));
    if (best3.length === 3) combos.push(makeCombo('Best 3', best3, 'safe'));
    if (best4.length === 4) combos.push(makeCombo('Best 4', best4, 'safe'));
    if (best5.length === 5) combos.push(makeCombo('Best 5', best5, 'safe'));
    if (best6.length >= 2) combos.push(makeCombo('Best 6', best6, 'safe'));
  }

  // Wild Card: bigger, riskier, still data-supported. Pulls from the
  // looser eligibility pool but explicitly skips picks already on
  // Best 6 (so the wild slate is a different angle, not a re-shuffle).
  const usedKeys = new Set(best6.map(comboKey));
  const wildPool = allCandidates
    .filter((c) => passesEligibility(c, WILD))
    .filter((c) => !passesEligibility(c, ELIGIBLE) || !usedKeys.has(comboKey(c)))
    // Wild Card prioritizes upside: highest edge × volatility above
    // 50% probability. We re-rank by a "longshot" score that favors
    // strong-edge picks that aren't already locks.
    .map((c) => ({ c, longshot: c.edgeScore * Math.max(20, 105 - c.probability) }))
    .sort((a, b) => b.longshot - a.longshot)
    .map((x) => x.c);
  const wildLegs = pickByCaps(wildPool, 6, CAPS_LARGE);
  if (wildLegs.length >= 4) {
    combos.push(makeCombo('Wild Card', wildLegs, 'wild'));
  }

  return { combos };
}

function comboKey(c: ComboCandidate): string {
  return `${c.playerId}-${c.statKey}-${c.line}-${c.direction}`;
}

// Stat label fallback used when older snapshots don't carry the
// statLabel field. Looks up the canonical label from last10's map.
export function labelForStat(key: Last10StatId): string {
  return LAST10_LABELS[key] ?? String(key);
}
