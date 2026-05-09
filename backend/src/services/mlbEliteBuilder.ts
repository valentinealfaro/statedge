// MLB Elite ticket builder — institutional 3-leg service.
//
// Per the Elite product spec: this is NOT volume betting. The
// service exists to identify rare, high-conviction 3-leg
// combinations with asymmetric payout potential AND beat-market
// expected value. Returns ONE ticket per slate, or NULL.
//
// "Publish nothing" is a feature: forcing a ticket on days with
// no real edge corrupts trust. The `null` return is the default
// path — only quality combinations get through.
//
// Pure function. Inputs: the resolved-and-projected slate. Output:
// EliteTicket or null. The route layer pulls today's slate and
// hands it in; the engine has no I/O.

import type { ResolvedMlbLine } from './mlbSlatePipeline.js';
import { computeCorrelationRisk } from './mlbSlateBuilder.js';

export type EliteLeg = {
  playerId: number;
  playerName: string;
  team: string | null;
  statKey: string;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  // Projection signals
  probability: number;            // 0-100
  edgePercent: number;            // 0-100, vs implied 50
  trapScore: number;              // 0-100, lower = better
  fragilityScore: number;         // 0-100, lower = better
  // Phase 102 market-intelligence fields (some nullable for legacy lines)
  marketImpliedProb: number | null;
  publicBiasTags: string[];
  sharpnessScore: number | null;
  edgeDurability: 'stable' | 'mixed' | 'fragile' | null;
  // Why this leg qualified — one of the mandatory edge requirements
  qualifyingEdge: EdgeReason;
};

export type EdgeReason =
  | 'market_disagreement'      // PrizePicks vs consensus market
  | 'model_disagreement'       // Internal projection beats market implied
  | 'clv_opportunity'          // Edge durability + sharpness composite
  | 'role_expansion'           // Momentum signal
  | 'public_overreaction'      // Public-bias tag against the side we want
  | 'matchup_asymmetry'        // High edge with stable durability
  | 'historical_archetype';    // Reserved for similarity matching (Phase 132)

export type EliteTicket = {
  legs: [EliteLeg, EliteLeg, EliteLeg];
  // Combined statistics (assumes leg independence — 3-leg correlation
  // already filtered out by construction rules below)
  combinedProbability: number;       // 0-100
  combinedFairPayout: number;        // 1 / combined_probability
  combinedEdgePercent: number;       // mean of per-leg edges
  // Dislocation score per spec: model − market, weighted by
  // sharpness/CLV/public-bias adjustments. Sum across legs.
  dislocationScore: number;
  // Letter grade derived from dislocation × payout × diversification
  grade: 'A+' | 'A' | 'B';
  // Construction notes — what makes this ticket pass the spec
  rationale: string[];
};

const MIN_FAIR_PAYOUT = 6.0;            // ≥6× per spec
const MIN_PROBABILITY = 60;             // each leg ≥60% (institutional bar)
const MAX_TRAP_SCORE = 35;
const MAX_FRAGILITY = 45;
const MIN_EDGE_PERCENT = 8;             // each leg must clear 8pp edge

export function buildMlbElite(lines: ResolvedMlbLine[]): EliteTicket | null {
  // ---------- 1. Per-leg auto-reject filter ----------
  const eligible: ResolvedMlbLine[] = [];
  for (const l of lines) {
    // Defensive: an individual line missing a required field shouldn't
    // 500 the endpoint. Skip the row, keep going.
    try {
      if (!l || !l.projection) continue;
      if (rejectLeg(l)) continue;
      eligible.push(l);
    } catch (err) {
      console.warn('elite per-leg filter failed', (err as Error).message);
      continue;
    }
  }
  if (eligible.length < 3) return null;

  // ---------- 2. Cap to top candidates so we don't combinatorially explode
  // Sort by edge × (1 − trap/100) so the strongest legs lead.
  const ranked = [...eligible].sort((a, b) => {
    try { return legElitenessScore(b) - legElitenessScore(a); }
    catch { return 0; }
  });
  const candidates = ranked.slice(0, 18);
  if (candidates.length < 3) return null;

  // ---------- 3. Generate diversified 3-leg combinations ----------
  let best: EliteTicket | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < candidates.length - 2; i++) {
    for (let j = i + 1; j < candidates.length - 1; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        const a = candidates[i]!;
        const b = candidates[j]!;
        const c = candidates[k]!;
        // A bad row (unexpected null on a deeply nested field) shouldn't
        // take down the whole endpoint — skip the combo and keep going.
        try {
          if (!passesDiversification(a, b, c)) continue;
          const ticket = scoreTicket(a, b, c);
          if (!ticket) continue;
          if (ticket.combinedFairPayout < MIN_FAIR_PAYOUT) continue;

          // Composite ranking: dislocation × payout, weighted by combined edge
          const score = ticket.dislocationScore * Math.log2(ticket.combinedFairPayout) * (1 + ticket.combinedEdgePercent / 100);
          if (score > bestScore) {
            bestScore = score;
            best = ticket;
          }
        } catch (err) {
          console.warn('elite combo evaluation failed', (err as Error).message);
          continue;
        }
      }
    }
  }

  return best;
}

// ---------- Per-leg gating ----------

function rejectLeg(l: ResolvedMlbLine): boolean {
  const p = l.projection;
  if (p.probability < MIN_PROBABILITY) return true;
  if (p.edgePercent  < MIN_EDGE_PERCENT) return true;
  if (p.trapScore    > MAX_TRAP_SCORE) return true;
  if (p.fragilityScore > MAX_FRAGILITY) return true;
  // Edge generated solely from a recent streak = momentum without depth.
  // Reject when edge durability is fragile AND a hot-streak/narrative
  // tag is present (the typical fragile-on-recency pattern).
  const tags = p.publicBiasTags ?? [];
  if (p.edgeDurability === 'fragile' && (tags.includes('HOT_STREAK_OVERREACTION') || tags.includes('NARRATIVE_RISK'))) {
    return true;
  }
  // Public-over-magnet on the OVER side = inflated demand we shouldn't
  // chase. We can still take the OVER if we have a structural read,
  // but not when this tag fires alone.
  if (tags.includes('PUBLIC_OVER_MAGNET') &&
      l.modelDirection === 'OVER' &&
      !tags.includes('STRUCTURAL_EDGE')) {
    return true;
  }
  // Line already moved too far — unstable + market-implied gap closing.
  if (p.edgeDurability === 'fragile' && p.marketImpliedProb !== null
      && Math.abs(p.probability - p.marketImpliedProb) < 5) {
    return true;
  }
  return false;
}

function legElitenessScore(l: ResolvedMlbLine): number {
  const p = l.projection;
  // Higher edge = better. Lower trap + fragility = better. Edge
  // durability stable is a bonus.
  const stableBonus = p.edgeDurability === 'stable' ? 5 : 0;
  return p.edgePercent
    + (p.sharpnessScore ?? 0) / 10
    - p.trapScore / 8
    - p.fragilityScore / 12
    + stableBonus;
}

// ---------- Diversification ----------

function passesDiversification(a: ResolvedMlbLine, b: ResolvedMlbLine, c: ResolvedMlbLine): boolean {
  // No duplicate players
  const ids = new Set([a.playerId, b.playerId, c.playerId]);
  if (ids.size < 3) return false;

  // No two legs from the same game (shared environmental risk —
  // weather, blowout script, ump zone all hit simultaneously)
  const games = [a.gameKey, b.gameKey, c.gameKey].filter((g): g is string => g !== null);
  const uniqueGames = new Set(games);
  if (uniqueGames.size < games.length) return false;

  // No two legs with HR-correlated stats on different players that
  // happen to be in the same game (already blocked above) is fine.
  // But across legs: don't stack three home_runs OVER bets — that's
  // weather-correlated. Stat-family monoculture rule.
  const families = [statFamily(a.statKey), statFamily(b.statKey), statFamily(c.statKey)];
  const familyCounts = new Map<string, number>();
  for (const f of families) familyCounts.set(f, (familyCounts.get(f) ?? 0) + 1);
  for (const [, n] of familyCounts) {
    if (n >= 3) return false;     // all 3 same family = correlated
  }

  // Reuse the existing correlation risk function — if it returns
  // 'High' or 'Very High', the ticket is too correlated for Elite.
  // Note: computeCorrelationRisk reads team.id off each leg, so pass
  // the full ResolvedMlbLine objects rather than a thinner adapter.
  const corr = computeCorrelationRisk([a, b, c]);
  if (corr.tier === 'High' || corr.tier === 'Very High') return false;

  return true;
}

function statFamily(key: string): string {
  if (['home_runs', 'total_bases', 'rbis', 'runs', 'hits_runs_rbis'].includes(key)) return 'power';
  if (['hits', 'walks', 'stolen_bases'].includes(key)) return 'on_base';
  if (['strikeouts'].includes(key)) return 'hitter_k';
  if (['ks', 'pitcher_outs', 'innings_pitched'].includes(key)) return 'pitcher_volume';
  if (['earned_runs_allowed', 'hits_allowed', 'walks_allowed', 'home_runs_allowed'].includes(key)) return 'pitcher_results';
  return 'other';
}

// ---------- Ticket scoring ----------

function scoreTicket(a: ResolvedMlbLine, b: ResolvedMlbLine, c: ResolvedMlbLine): EliteTicket | null {
  const legs: [EliteLeg, EliteLeg, EliteLeg] = [
    legToElite(a),
    legToElite(b),
    legToElite(c),
  ];

  // Combined (assume independence; correlation already filtered)
  const probs = legs.map((l) => l.probability / 100);
  const combined = probs.reduce((p, q) => p * q, 1);
  const combinedProbability = Math.round(combined * 1000) / 10;
  const combinedFairPayout = combined > 0
    ? Math.round((1 / combined) * 100) / 100
    : 0;
  const combinedEdgePercent = legs.reduce((s, l) => s + l.edgePercent, 0) / 3;

  // Dislocation score per spec
  const dislocationScore = legs.reduce((s, l) => {
    const modelMinusMarket = l.marketImpliedProb !== null
      ? l.probability - l.marketImpliedProb
      : l.edgePercent;
    const sharpness = (l.sharpnessScore ?? 50) / 100;
    const durabilityBonus = l.edgeDurability === 'stable' ? 1.2
      : l.edgeDurability === 'mixed' ? 1.0 : 0.7;
    const publicBiasAdj = l.publicBiasTags.includes('STRUCTURAL_EDGE') ? 1.15 : 1.0;
    return s + modelMinusMarket * sharpness * durabilityBonus * publicBiasAdj;
  }, 0);

  const grade = letterGrade({ dislocationScore, combinedFairPayout, combinedEdgePercent });

  const rationale = buildRationale(legs, { combinedFairPayout, dislocationScore, combinedEdgePercent });

  return {
    legs,
    combinedProbability,
    combinedFairPayout,
    combinedEdgePercent: Math.round(combinedEdgePercent * 10) / 10,
    dislocationScore: Math.round(dislocationScore * 10) / 10,
    grade,
    rationale,
  };
}

function legToElite(l: ResolvedMlbLine): EliteLeg {
  const p = l.projection;
  return {
    playerId: l.playerId,
    playerName: l.playerName,
    team: l.team.abbr,
    statKey: l.statKey,
    statLabel: l.statLabel,
    line: l.line,
    direction: l.modelDirection,
    probability: Math.round(p.probability * 10) / 10,
    edgePercent: Math.round(p.edgePercent * 10) / 10,
    trapScore: Math.round(p.trapScore),
    fragilityScore: Math.round(p.fragilityScore),
    marketImpliedProb: p.marketImpliedProb ?? null,
    publicBiasTags: p.publicBiasTags ?? [],
    sharpnessScore: p.sharpnessScore ?? null,
    edgeDurability: p.edgeDurability ?? null,
    qualifyingEdge: classifyEdge(p),
  };
}

function classifyEdge(p: ResolvedMlbLine['projection']): EdgeReason {
  // Order matters — strongest reasons first.
  if (p.marketImpliedProb !== null && Math.abs(p.probability - p.marketImpliedProb) >= 12) {
    return 'market_disagreement';
  }
  if (p.publicBiasTags?.includes('STRUCTURAL_EDGE')) {
    return 'matchup_asymmetry';
  }
  if (p.edgeDurability === 'stable' && (p.sharpnessScore ?? 0) >= 60) {
    return 'clv_opportunity';
  }
  if (p.publicBiasTags?.includes('CONTRARIAN_VALUE')) {
    return 'public_overreaction';
  }
  // Role expansion is signaled by NARRATIVE_RISK off a stable
  // durability — i.e., the underlying story is real, not just a
  // streak. We don't have a direct momentum field on ProjectionResult.
  if (p.edgeDurability === 'stable' && p.publicBiasTags?.includes('STRUCTURAL_EDGE')) {
    return 'role_expansion';
  }
  return 'model_disagreement';
}

function letterGrade(s: { dislocationScore: number; combinedFairPayout: number; combinedEdgePercent: number }): 'A+' | 'A' | 'B' {
  if (s.dislocationScore >= 30 && s.combinedFairPayout >= 8 && s.combinedEdgePercent >= 13) return 'A+';
  if (s.dislocationScore >= 22 && s.combinedFairPayout >= 6.5 && s.combinedEdgePercent >= 10) return 'A';
  return 'B';
}

function buildRationale(legs: [EliteLeg, EliteLeg, EliteLeg], s: { combinedFairPayout: number; dislocationScore: number; combinedEdgePercent: number }): string[] {
  const out: string[] = [];
  out.push(`Combined fair payout ${s.combinedFairPayout.toFixed(1)}× — clears the 6× institutional bar.`);
  out.push(`Mean leg edge ${s.combinedEdgePercent.toFixed(1)}pp; dislocation score ${s.dislocationScore.toFixed(1)}.`);
  const edgeKinds = legs.map((l) => l.qualifyingEdge);
  const uniqueKinds = [...new Set(edgeKinds)];
  out.push(`Qualifying edges: ${uniqueKinds.join(' + ')}.`);
  const games = legs.map((l) => l.team).filter((t): t is string => !!t);
  out.push(`${new Set(games).size} different teams across 3 different games — environmental risk decorrelated.`);
  return out;
}
