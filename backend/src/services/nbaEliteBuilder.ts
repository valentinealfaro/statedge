// NBA Elite ticket builder — institutional 3-leg service (NBA edition).
//
// Same product spec as MLB Elite: 3-leg target with 6× combined fair
// payout, 2-leg fallback at 3×, per-leg auto-reject on probability,
// edge, trap score, and fragility. Per-leg quality gate adapts to
// NBA's ProjectionResult shape (no market_intel fields — those are
// MLB-only). Cross-sport ticket shape stays identical so the frontend
// renders both with one component.

import type { ResolvedLine } from './slatePipeline.js';
import type { EliteLeg, EliteTicket, EdgeReason } from './mlbEliteBuilder.js';

export type { EliteTicket, EliteLeg } from './mlbEliteBuilder.js';

const MIN_FAIR_PAYOUT_3LEG = 6.0;
const MIN_FAIR_PAYOUT_2LEG = 3.0;
const MIN_PROBABILITY = 60;
const MAX_TRAP_SCORE = 35;
const MAX_FRAGILITY = 45;
const MIN_EDGE_SCORE = 8;       // NBA edge.score is 0-100, treat as edge-pp proxy

// Translate an NBA ResolvedLine to a flat shape the Elite-style filter
// + scorer can read uniformly. Returns null when the line is missing
// the projection fields the filter needs.
type NbaLegFlat = {
  raw: ResolvedLine;
  direction: 'OVER' | 'UNDER';
  probability: number;            // 0-100, direction-aware
  edgeScore: number;              // 0-100, NBA's edge.score
  trapScore: number;              // 0-100, mapped from risk.score
  fragilityScore: number;         // 0-100
  momentumScore: number;          // 0-100, momentumExpansionScore
};

function flatten(l: ResolvedLine): NbaLegFlat | null {
  const p = l.projection;
  if (!p) return null;
  // Pick the side the model leans. edge.lean is 'over' / 'under' /
  // sometimes other strings — fall back by comparing probabilities.
  const leanRaw = (p.edge?.lean ?? '').toLowerCase();
  const leansUnder = leanRaw === 'under' ||
    (leanRaw !== 'over' && p.probability.under > p.probability.over);
  const direction: 'OVER' | 'UNDER' = leansUnder ? 'UNDER' : 'OVER';
  const probability = leansUnder ? p.probability.under : p.probability.over;
  return {
    raw: l,
    direction,
    probability,
    edgeScore: p.edge?.score ?? 0,
    trapScore: p.risk?.score ?? 0,
    fragilityScore: p.fragility?.score ?? 0,
    momentumScore: p.momentumExpansionScore ?? 50,
  };
}

export function buildNbaElite(lines: ResolvedLine[]): EliteTicket | null {
  // ---------- 1. Per-leg auto-reject filter ----------
  const eligible: NbaLegFlat[] = [];
  for (const l of lines) {
    try {
      const flat = flatten(l);
      if (!flat) continue;
      if (rejectLeg(flat)) continue;
      eligible.push(flat);
    } catch (err) {
      console.warn('nba elite per-leg filter failed', (err as Error).message);
    }
  }
  if (eligible.length < 2) return null;

  // ---------- 2. Top candidates ----------
  const ranked = [...eligible].sort((a, b) => legElitenessScore(b) - legElitenessScore(a));
  const candidates = ranked.slice(0, 24);
  if (candidates.length < 2) return null;

  // ---------- 3. Try 3-leg first, then 2-leg fallback ----------
  if (candidates.length >= 3) {
    const three = bestThreeLeg(candidates);
    if (three) return three;
  }
  return bestTwoLeg(candidates);
}

function rejectLeg(l: NbaLegFlat): boolean {
  if (l.probability < MIN_PROBABILITY) return true;
  if (l.edgeScore   < MIN_EDGE_SCORE) return true;
  if (l.trapScore   > MAX_TRAP_SCORE) return true;
  if (l.fragilityScore > MAX_FRAGILITY) return true;
  return false;
}

function legElitenessScore(l: NbaLegFlat): number {
  // Higher edge + lower trap + lower fragility + momentum bonus.
  // Same shape as MLB's score, NBA's coefficients tuned to its 0-100
  // edge scale rather than MLB's edge-pp scale.
  const momentumBonus = l.momentumScore >= 65 ? 4 : l.momentumScore <= 35 ? -3 : 0;
  return l.edgeScore - l.trapScore / 8 - l.fragilityScore / 12 + momentumBonus;
}

function passesDiversificationN(legs: NbaLegFlat[]): boolean {
  if (legs.length < 2) return false;
  const ids = new Set(legs.map((l) => l.raw.playerId));
  if (ids.size < legs.length) return false;

  // No two legs from the same matchup (player team + opponent abbr,
  // sorted) — when opponent is missing, fall back to team-only.
  const games = legs.map((l) => legGameKey(l.raw)).filter((g): g is string => g !== null);
  if (new Set(games).size < games.length) return false;

  // Stat-family monoculture
  const familyCounts = new Map<string, number>();
  for (const l of legs) {
    const f = statFamily(l.raw.statKey);
    familyCounts.set(f, (familyCounts.get(f) ?? 0) + 1);
  }
  for (const [, n] of familyCounts) {
    if (n >= legs.length) return false;
  }

  // Pair-correlation cap (≥ legs.length-1 pairs ≈ "high" tier)
  let pairs = 0;
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const ag = legGameKey(legs[i]!.raw);
      const bg = legGameKey(legs[j]!.raw);
      if (ag && bg && ag === bg) pairs += 1;
      else if (legs[i]!.raw.team && legs[j]!.raw.team && legs[i]!.raw.team === legs[j]!.raw.team) pairs += 1;
    }
  }
  if (pairs >= legs.length - 1) return false;

  return true;
}

function legGameKey(l: ResolvedLine): string | null {
  if (!l.team) return null;
  const opp = l.vsOpponent?.opponentAbbr ?? null;
  if (!opp) return `team:${l.team}`;
  return [l.team, opp].sort().join('-');
}

function statFamily(key: string): string {
  if (['points', 'three_pt_made', 'fg_made', 'ft_made'].includes(key)) return 'scoring';
  if (['rebounds', 'offensive_rebounds', 'defensive_rebounds'].includes(key)) return 'rebounding';
  if (['assists'].includes(key)) return 'playmaking';
  if (['steals', 'blocks', 'stocks'].includes(key)) return 'defense';
  if (['turnovers'].includes(key)) return 'turnovers';
  if (['pra', 'pr', 'pa', 'ra'].includes(key)) return 'combo';
  return 'other';
}

function bestThreeLeg(candidates: NbaLegFlat[]): EliteTicket | null {
  let best: EliteTicket | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < candidates.length - 2; i++) {
    for (let j = i + 1; j < candidates.length - 1; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        const a = candidates[i]!;
        const b = candidates[j]!;
        const c = candidates[k]!;
        try {
          if (!passesDiversificationN([a, b, c])) continue;
          const ticket = scoreTicket([a, b, c], '3-leg');
          if (!ticket) continue;
          if (ticket.combinedFairPayout < MIN_FAIR_PAYOUT_3LEG) continue;
          const score = ticket.dislocationScore * Math.log2(ticket.combinedFairPayout) * (1 + ticket.combinedEdgePercent / 100);
          if (score > bestScore) { bestScore = score; best = ticket; }
        } catch (err) {
          console.warn('nba elite 3-leg combo failed', (err as Error).message);
        }
      }
    }
  }
  return best;
}

function bestTwoLeg(candidates: NbaLegFlat[]): EliteTicket | null {
  let best: EliteTicket | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < candidates.length - 1; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      try {
        if (!passesDiversificationN([a, b])) continue;
        const ticket = scoreTicket([a, b], '2-leg');
        if (!ticket) continue;
        if (ticket.combinedFairPayout < MIN_FAIR_PAYOUT_2LEG) continue;
        const score = ticket.dislocationScore * Math.log2(ticket.combinedFairPayout) * (1 + ticket.combinedEdgePercent / 100);
        if (score > bestScore) { bestScore = score; best = ticket; }
      } catch (err) {
        console.warn('nba elite 2-leg combo failed', (err as Error).message);
      }
    }
  }
  return best;
}

function scoreTicket(rawLegs: NbaLegFlat[], tier: '3-leg' | '2-leg'): EliteTicket | null {
  if (rawLegs.length < 2) return null;
  const legs: EliteLeg[] = rawLegs.map(legToElite);
  const probs = legs.map((l) => l.probability / 100);
  const combined = probs.reduce((p, q) => p * q, 1);
  const combinedProbability = Math.round(combined * 1000) / 10;
  const combinedFairPayout = combined > 0
    ? Math.round((1 / combined) * 100) / 100
    : 0;
  const combinedEdgePercent = legs.reduce((s, l) => s + l.edgePercent, 0) / legs.length;
  // Without NBA market-intel fields, dislocationScore proxies as
  // edge × momentum-bonus (+0.2 if rawLegs[i].momentumScore >= 65).
  const dislocationScore = rawLegs.reduce((s, raw, i) => {
    const leg = legs[i]!;
    const momentumBoost = raw.momentumScore >= 65 ? 1.2
      : raw.momentumScore <= 35 ? 0.8 : 1.0;
    return s + leg.edgePercent * momentumBoost;
  }, 0);
  const grade = letterGrade({ dislocationScore, combinedFairPayout, combinedEdgePercent, tier });
  const rationale = buildRationale(legs, { combinedFairPayout, dislocationScore, combinedEdgePercent, tier });
  return {
    tier,
    legs,
    combinedProbability,
    combinedFairPayout,
    combinedEdgePercent: Math.round(combinedEdgePercent * 10) / 10,
    dislocationScore: Math.round(dislocationScore * 10) / 10,
    grade,
    rationale,
  };
}

function legToElite(f: NbaLegFlat): EliteLeg {
  const l = f.raw;
  return {
    playerId: l.playerId,
    playerName: l.playerName,
    team: l.team,
    statKey: l.statKey,
    statLabel: l.statLabel,
    line: l.line,
    direction: f.direction,
    probability: Math.round(f.probability * 10) / 10,
    edgePercent: Math.round(f.edgeScore * 10) / 10,    // NBA edge.score 0-100 displayed as edgePercent
    trapScore: Math.round(f.trapScore),
    fragilityScore: Math.round(f.fragilityScore),
    // NBA-specific projection doesn't carry these market-intel fields;
    // the EliteLeg shape allows null. Frontend cards already handle.
    marketImpliedProb: null,
    publicBiasTags: [],
    sharpnessScore: null,
    edgeDurability: null,
    qualifyingEdge: classifyEdge(f),
  };
}

function classifyEdge(f: NbaLegFlat): EdgeReason {
  // NBA's signal vocabulary is narrower (no market-intel tags).
  // Map momentum + edge-strength to the closest spec category.
  if (f.momentumScore >= 70 && f.edgeScore >= 12) return 'role_expansion';
  if (f.edgeScore >= 18) return 'matchup_asymmetry';
  if (f.edgeScore >= 12) return 'model_disagreement';
  return 'model_disagreement';
}

function letterGrade(s: { dislocationScore: number; combinedFairPayout: number; combinedEdgePercent: number; tier: '3-leg' | '2-leg' }): 'A+' | 'A' | 'B' {
  if (s.tier === '3-leg') {
    if (s.dislocationScore >= 30 && s.combinedFairPayout >= 8   && s.combinedEdgePercent >= 13) return 'A+';
    if (s.dislocationScore >= 22 && s.combinedFairPayout >= 6.5 && s.combinedEdgePercent >= 10) return 'A';
    return 'B';
  }
  if (s.dislocationScore >= 22 && s.combinedFairPayout >= 4   && s.combinedEdgePercent >= 13) return 'A+';
  if (s.dislocationScore >= 16 && s.combinedFairPayout >= 3.2 && s.combinedEdgePercent >= 10) return 'A';
  return 'B';
}

function buildRationale(legs: EliteLeg[], s: { combinedFairPayout: number; dislocationScore: number; combinedEdgePercent: number; tier: '3-leg' | '2-leg' }): string[] {
  const out: string[] = [];
  if (s.tier === '3-leg') {
    out.push(`Combined fair payout ${s.combinedFairPayout.toFixed(1)}× — clears the 6× 3-leg institutional bar.`);
  } else {
    out.push(`2-leg fallback · combined fair payout ${s.combinedFairPayout.toFixed(1)}× — no 3-leg combination cleared the 6× bar today, this pair clears the 3× 2-leg fallback.`);
  }
  out.push(`Mean leg edge ${s.combinedEdgePercent.toFixed(1)} (NBA edge-score scale); dislocation ${s.dislocationScore.toFixed(1)}.`);
  const edgeKinds = legs.map((l) => l.qualifyingEdge);
  out.push(`Qualifying edges: ${[...new Set(edgeKinds)].join(' + ')}.`);
  const teams = legs.map((l) => l.team).filter((t): t is string => !!t);
  out.push(`${new Set(teams).size} different teams across ${legs.length} different games — environmental risk decorrelated.`);
  return out;
}
