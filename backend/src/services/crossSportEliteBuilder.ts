// Cross-sport Elite ticket builder — always produces a play.
//
// Per the user's product directive: combine NBA + MLB + UFC legs into
// a single ticket and ALWAYS return something. The institutional bar
// still grades the ticket (A+/A/B for clean Elite, C/D for relaxed-
// fallback "best of the day"), but we never publish nothing — there's
// always a "today's best play" even on quiet boards. UFC contribution
// rides on the Phase 136 moneyline-anchored projection engine
// (mma/projectionEngine.projectUfcProp) — a market-anchored heuristic
// that gets swapped for a deeper fighter-stat fundamental engine in
// a future phase without changing this builder's contract.
//
// Strategy: progressive fallback through quality tiers. The engine
// tries strict 3-leg → strict 2-leg → relaxed 3-leg → relaxed 2-leg,
// and finally just the strongest two candidates. Whichever tier
// produces the first valid combination wins, and the ticket is
// graded according to which tier it came from.
//
// Pure function. Inputs: MLB + NBA resolved-slate arrays + UFC stored
// lines + UFC moneylines. Output: EliteTicket (always non-null when
// ≥2 candidates exist anywhere across the three sports).

import type { ResolvedLine as NbaResolvedLine } from './slatePipeline.js';
import type { ResolvedMlbLine } from './mlbSlatePipeline.js';
import type { EliteLeg, EliteTicket, EdgeReason } from './mlbEliteBuilder.js';
import type { MmaStoredLine } from '../mma/slateStore.js';
import { projectUfcProp, type UfcProjectionInput } from '../mma/projectionEngine.js';

export type { EliteTicket, EliteLeg } from './mlbEliteBuilder.js';

// ---------- Common candidate shape ----------

type Sport = 'mlb' | 'nba' | 'mma';

type EliteCandidate = {
  sport: Sport;
  // Composite key — sport prefix prevents NBA playerId 100 from
  // colliding with MLB playerId 100 in the diversification check.
  ckey: string;
  playerId: string;
  // ESPN MMA athlete id when sport === 'mma' (resolved from scoreboard
  // by fighter-name match). Lets the frontend render real UFC
  // headshots instead of falling back to initials.
  espnAthleteId?: string;
  playerName: string;
  team: string | null;
  statKey: string;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  probability: number;            // 0-100
  edgeScore: number;              // 0-100 (MLB edgePercent or NBA edge.score)
  trapScore: number;
  fragilityScore: number;
  marketImpliedProb: number | null;
  publicBiasTags: string[];
  sharpnessScore: number | null;
  edgeDurability: 'stable' | 'mixed' | 'fragile' | null;
  momentumScore: number | null;
  gameKey: string | null;
  qualifyingEdge: EdgeReason;
};

// ---------- Normalizers ----------

export function normalizeMlb(l: ResolvedMlbLine): EliteCandidate | null {
  const p = l.projection;
  if (!p) return null;
  return {
    sport: 'mlb',
    ckey: `mlb:${l.playerId}`,
    playerId: String(l.playerId),
    playerName: l.playerName,
    team: l.team.abbr,
    statKey: l.statKey,
    statLabel: l.statLabel,
    line: l.line,
    direction: l.modelDirection,
    probability: p.probability,
    edgeScore: p.edgePercent,
    trapScore: p.trapScore,
    fragilityScore: p.fragilityScore,
    marketImpliedProb: p.marketImpliedProb ?? null,
    publicBiasTags: p.publicBiasTags ?? [],
    sharpnessScore: p.sharpnessScore ?? null,
    edgeDurability: p.edgeDurability ?? null,
    momentumScore: null,
    gameKey: l.gameKey,
    qualifyingEdge: classifyMlbEdge(p),
  };
}

export function normalizeNba(l: NbaResolvedLine): EliteCandidate | null {
  const p = l.projection;
  if (!p) return null;
  const leanRaw = (p.edge?.lean ?? '').toLowerCase();
  const leansUnder = leanRaw === 'under' ||
    (leanRaw !== 'over' && p.probability.under > p.probability.over);
  const direction: 'OVER' | 'UNDER' = leansUnder ? 'UNDER' : 'OVER';
  const probability = leansUnder ? p.probability.under : p.probability.over;
  const team = l.team;
  const opp = l.vsOpponent?.opponentAbbr ?? null;
  const gameKey = team
    ? (opp ? [team, opp].sort().join('-') : `team:${team}`)
    : null;
  return {
    sport: 'nba',
    ckey: `nba:${l.playerId}`,
    playerId: String(l.playerId),
    playerName: l.playerName,
    team,
    statKey: l.statKey,
    statLabel: l.statLabel,
    line: l.line,
    direction,
    probability,
    edgeScore: p.edge?.score ?? 0,
    trapScore: p.risk?.score ?? 0,
    fragilityScore: p.fragility?.score ?? 0,
    marketImpliedProb: null,
    publicBiasTags: [],
    sharpnessScore: null,
    edgeDurability: null,
    momentumScore: p.momentumExpansionScore ?? 50,
    gameKey,
    qualifyingEdge: classifyNbaEdge(p),
  };
}

function classifyMlbEdge(p: ResolvedMlbLine['projection']): EdgeReason {
  if (p.marketImpliedProb !== null && Math.abs(p.probability - p.marketImpliedProb) >= 12) {
    return 'market_disagreement';
  }
  if (p.publicBiasTags?.includes('STRUCTURAL_EDGE')) return 'matchup_asymmetry';
  if (p.edgeDurability === 'stable' && (p.sharpnessScore ?? 0) >= 60) return 'clv_opportunity';
  if (p.publicBiasTags?.includes('CONTRARIAN_VALUE')) return 'public_overreaction';
  if (p.edgeDurability === 'stable' && p.publicBiasTags?.includes('STRUCTURAL_EDGE')) return 'role_expansion';
  return 'model_disagreement';
}

function classifyNbaEdge(p: NbaResolvedLine['projection']): EdgeReason {
  if (!p) return 'model_disagreement';
  if ((p.momentumExpansionScore ?? 50) >= 70 && (p.edge?.score ?? 0) >= 12) return 'role_expansion';
  if ((p.edge?.score ?? 0) >= 18) return 'matchup_asymmetry';
  return 'model_disagreement';
}

// UFC stat-label map for display.
const UFC_STAT_LABEL: Record<string, string> = {
  sig_strikes: 'Sig Strikes',
  rd1_sig_strikes: 'R1 Sig Strikes',
  takedowns: 'Takedowns',
  rd1_takedowns: 'R1 Takedowns',
  knockdowns: 'Knockdowns',
  rounds: 'Rounds',
  fight_time: 'Fight Time',
  fantasy_score: 'Fantasy Score',
  control_time: 'Control Time',
};

export function normalizeMma(opts: {
  line: MmaStoredLine;
  fairProbability: number | null;
  opponentName: string | null;
  matchupKey: string | null;       // sorted-pair fight key for diversification
  espnAthleteId?: string;          // for UFC headshot rendering
}): EliteCandidate | null {
  // Only the stat keys our projection engine recognizes
  const supportedStats = new Set([
    'sig_strikes', 'rd1_sig_strikes',
    'takedowns', 'rd1_takedowns',
    'knockdowns', 'rounds', 'fight_time', 'fantasy_score', 'control_time',
  ]);
  if (!supportedStats.has(opts.line.statKey)) return null;

  const projInput: UfcProjectionInput = {
    fighterName: opts.line.fighterName,
    opponentName: opts.opponentName ?? 'TBD',
    fairProbability: opts.fairProbability,
    statKey: opts.line.statKey as UfcProjectionInput['statKey'],
    line: opts.line.line,
    direction: opts.line.direction,
  };
  const proj = projectUfcProp(projInput);

  return {
    sport: 'mma',
    ckey: `mma:${opts.line.fighterName}`,
    playerId: opts.line.fighterName,            // no numeric id; use name as key
    espnAthleteId: opts.espnAthleteId,
    playerName: opts.line.fighterName,
    team: null,
    statKey: opts.line.statKey,
    statLabel: UFC_STAT_LABEL[opts.line.statKey] ?? opts.line.statKey,
    line: opts.line.line,
    direction: proj.modelDirection,
    probability: proj.probability,
    edgeScore: proj.edgePercent,
    trapScore: proj.trapScore,
    fragilityScore: proj.fragilityScore,
    marketImpliedProb: opts.fairProbability !== null ? opts.fairProbability * 100 : null,
    publicBiasTags: [],
    sharpnessScore: null,
    edgeDurability: null,
    momentumScore: null,
    gameKey: opts.matchupKey,
    qualifyingEdge: 'model_disagreement',
  };
}

// ---------- Tier definitions ----------

type Tier = {
  name: string;
  legCount: 2 | 3;
  minProb: number;
  minEdge: number;
  maxTrap: number;
  maxFrag: number;
  minPayout: number;
  // The grade ceiling for tickets produced by this tier — relaxed
  // tiers can't produce A+/A grades even if the math says they should.
  gradeCeiling: 'A+' | 'A' | 'B' | 'C';
};

const TIERS: Tier[] = [
  { name: '3-leg · institutional', legCount: 3, minProb: 60, minEdge: 8, maxTrap: 35, maxFrag: 45, minPayout: 6.0, gradeCeiling: 'A+' },
  { name: '2-leg · institutional', legCount: 2, minProb: 60, minEdge: 8, maxTrap: 35, maxFrag: 45, minPayout: 3.0, gradeCeiling: 'A+' },
  { name: '3-leg · relaxed',       legCount: 3, minProb: 55, minEdge: 5, maxTrap: 50, maxFrag: 60, minPayout: 4.0, gradeCeiling: 'B'  },
  { name: '2-leg · relaxed',       legCount: 2, minProb: 55, minEdge: 5, maxTrap: 50, maxFrag: 60, minPayout: 2.0, gradeCeiling: 'B'  },
  { name: '2-leg · best-of-day',   legCount: 2, minProb: 50, minEdge: 0, maxTrap: 100, maxFrag: 100, minPayout: 1.5, gradeCeiling: 'C' },
];

// ---------- Public entry ----------

export type CrossSportTicket = EliteTicket & {
  // What tier produced the ticket — surfaced on the UI so users
  // know whether it's an institutional play or a "best available".
  tierName: string;
  // sport breakdown for the UI's diversification chip
  sportsCovered: Sport[];
};

export function buildCrossSportElite(opts: {
  mlb: ResolvedMlbLine[];
  nba: NbaResolvedLine[];
  // Pre-normalized MMA candidates — the route layer hydrates these
  // because UFC needs moneyline + matchup data from separate sources.
  mma?: EliteCandidate[];
}): CrossSportTicket | null {
  const candidates: EliteCandidate[] = [];
  for (const l of opts.mlb) {
    try {
      const c = normalizeMlb(l);
      if (c) candidates.push(c);
    } catch (err) {
      console.warn('cross-sport elite mlb normalize failed', (err as Error).message);
    }
  }
  for (const l of opts.nba) {
    try {
      const c = normalizeNba(l);
      if (c) candidates.push(c);
    } catch (err) {
      console.warn('cross-sport elite nba normalize failed', (err as Error).message);
    }
  }
  for (const c of opts.mma ?? []) candidates.push(c);
  if (candidates.length < 2) return null;

  for (const tier of TIERS) {
    const eligible = candidates.filter((c) => passesLegFilter(c, tier));
    if (eligible.length < tier.legCount) continue;
    // Cap per tier so combinatorial blowup stays bounded
    const ranked = [...eligible].sort((a, b) => legElitenessScore(b) - legElitenessScore(a));
    const candidatePool = ranked.slice(0, 24);
    const ticket = tier.legCount === 3
      ? bestThreeLeg(candidatePool, tier)
      : bestTwoLeg(candidatePool, tier);
    if (ticket) return { ...ticket, tierName: tier.name, sportsCovered: collectSports(ticket) };
  }

  // Last resort: just take the two highest-eliteness candidates that
  // pass diversification. This guarantees a play exists when ≥2
  // candidates have any projection at all.
  const ranked = [...candidates].sort((a, b) => legElitenessScore(b) - legElitenessScore(a));
  for (let i = 0; i < ranked.length - 1; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const pair = [ranked[i]!, ranked[j]!];
      if (!passesDiversification(pair)) continue;
      const ticket = scoreTicket(pair, '2-leg', { gradeCeiling: 'C', minPayout: 0 });
      if (ticket) return { ...ticket, tierName: '2-leg · forced fallback', sportsCovered: collectSports(ticket) };
    }
  }
  return null;
}

// ---------- Filters ----------

function passesLegFilter(c: EliteCandidate, tier: Tier): boolean {
  if (c.probability < tier.minProb) return false;
  if (c.edgeScore   < tier.minEdge) return false;
  if (c.trapScore   > tier.maxTrap) return false;
  if (c.fragilityScore > tier.maxFrag) return false;
  // Sport-specific guards retained for the strict tiers only — at the
  // relaxed/forced tiers, the structural-edge / streak-driven checks
  // would block the very fallbacks we want to surface.
  if (tier.gradeCeiling === 'A+') {
    const tags = c.publicBiasTags;
    if (c.edgeDurability === 'fragile' && (tags.includes('HOT_STREAK_OVERREACTION') || tags.includes('NARRATIVE_RISK'))) {
      return false;
    }
    if (tags.includes('PUBLIC_OVER_MAGNET') && c.direction === 'OVER' && !tags.includes('STRUCTURAL_EDGE')) {
      return false;
    }
    if (c.edgeDurability === 'fragile' && c.marketImpliedProb !== null
        && Math.abs(c.probability - c.marketImpliedProb) < 5) {
      return false;
    }
  }
  return true;
}

function legElitenessScore(c: EliteCandidate): number {
  const stableBonus = c.edgeDurability === 'stable' ? 5 : 0;
  const momentumBonus = (c.momentumScore ?? 50) >= 65 ? 4
    : (c.momentumScore ?? 50) <= 35 ? -3 : 0;
  return c.edgeScore
    + (c.sharpnessScore ?? 0) / 10
    - c.trapScore / 8
    - c.fragilityScore / 12
    + stableBonus
    + momentumBonus;
}

function passesDiversification(legs: EliteCandidate[]): boolean {
  if (legs.length < 2) return false;
  const players = new Set(legs.map((l) => l.ckey));
  if (players.size < legs.length) return false;
  // Different games (cross-sport games are inherently distinct since
  // gameKey is sport-prefixed via team abbr — the only collision risk
  // is two MLB legs from the same matchup, which we block here).
  const gameKeys = legs.map((l) => `${l.sport}::${l.gameKey ?? ''}`).filter((k) => !k.endsWith('::'));
  if (new Set(gameKeys).size < gameKeys.length) return false;
  // Stat-family monoculture WITHIN a single sport. Cross-sport pairs
  // are inherently family-decorrelated (NBA points + MLB hits are
  // unrelated mechanisms even if both are "scoring").
  const familyBySport = new Map<string, number>();
  for (const l of legs) {
    const k = `${l.sport}::${statFamily(l)}`;
    familyBySport.set(k, (familyBySport.get(k) ?? 0) + 1);
  }
  for (const [, n] of familyBySport) {
    if (n >= legs.length) return false;
  }
  return true;
}

function statFamily(c: EliteCandidate): string {
  const k = c.statKey;
  if (c.sport === 'mlb') {
    if (['home_runs', 'total_bases', 'rbis', 'runs', 'hits_runs_rbis'].includes(k)) return 'mlb_power';
    if (['hits', 'walks', 'stolen_bases'].includes(k)) return 'mlb_on_base';
    if (['strikeouts'].includes(k)) return 'mlb_hitter_k';
    if (['ks', 'pitcher_outs', 'innings_pitched'].includes(k)) return 'mlb_pitcher_volume';
    if (['earned_runs_allowed', 'hits_allowed', 'walks_allowed', 'home_runs_allowed'].includes(k)) return 'mlb_pitcher_results';
    return 'mlb_other';
  }
  if (['points', 'three_pt_made', 'fg_made', 'ft_made'].includes(k)) return 'nba_scoring';
  if (['rebounds', 'offensive_rebounds', 'defensive_rebounds'].includes(k)) return 'nba_rebounding';
  if (['assists'].includes(k)) return 'nba_playmaking';
  if (['steals', 'blocks', 'stocks'].includes(k)) return 'nba_defense';
  if (['turnovers'].includes(k)) return 'nba_turnovers';
  if (['pra', 'pr', 'pa', 'ra'].includes(k)) return 'nba_combo';
  return 'nba_other';
}

// ---------- Combo search ----------

function bestThreeLeg(pool: EliteCandidate[], tier: Tier): EliteTicket | null {
  let best: EliteTicket | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < pool.length - 2; i++) {
    for (let j = i + 1; j < pool.length - 1; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        const trio = [pool[i]!, pool[j]!, pool[k]!];
        try {
          if (!passesDiversification(trio)) continue;
          const ticket = scoreTicket(trio, '3-leg', tier);
          if (!ticket) continue;
          if (ticket.combinedFairPayout < tier.minPayout) continue;
          const score = ticket.dislocationScore * Math.log2(Math.max(1.01, ticket.combinedFairPayout)) * (1 + ticket.combinedEdgePercent / 100)
            + sportDiversityBonus(trio);
          if (score > bestScore) { bestScore = score; best = ticket; }
        } catch (err) {
          console.warn('cross-sport 3-leg combo failed', (err as Error).message);
        }
      }
    }
  }
  return best;
}

function bestTwoLeg(pool: EliteCandidate[], tier: Tier): EliteTicket | null {
  let best: EliteTicket | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < pool.length - 1; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const pair = [pool[i]!, pool[j]!];
      try {
        if (!passesDiversification(pair)) continue;
        const ticket = scoreTicket(pair, '2-leg', tier);
        if (!ticket) continue;
        if (ticket.combinedFairPayout < tier.minPayout) continue;
        const score = ticket.dislocationScore * Math.log2(Math.max(1.01, ticket.combinedFairPayout)) * (1 + ticket.combinedEdgePercent / 100)
          + sportDiversityBonus(pair);
        if (score > bestScore) { bestScore = score; best = ticket; }
      } catch (err) {
        console.warn('cross-sport 2-leg combo failed', (err as Error).message);
      }
    }
  }
  return best;
}

// Reward genuinely cross-sport tickets — institutional users want
// portfolio diversification across leagues, not just within one.
function sportDiversityBonus(legs: EliteCandidate[]): number {
  const sports = new Set(legs.map((l) => l.sport));
  if (sports.size === 1) return 0;
  return 4 * (sports.size - 1);   // small but breaks ties toward cross-sport
}

// ---------- Ticket scoring ----------

function scoreTicket(rawLegs: EliteCandidate[], legCountLabel: '3-leg' | '2-leg', tier: { gradeCeiling: 'A+' | 'A' | 'B' | 'C'; minPayout: number }): EliteTicket | null {
  if (rawLegs.length < 2) return null;
  const legs: EliteLeg[] = rawLegs.map(legToElite);
  const probs = legs.map((l) => l.probability / 100);
  const combined = probs.reduce((p, q) => p * q, 1);
  const combinedProbability = Math.round(combined * 1000) / 10;
  const combinedFairPayout = combined > 0
    ? Math.round((1 / combined) * 100) / 100
    : 0;
  const combinedEdgePercent = legs.reduce((s, l) => s + l.edgePercent, 0) / legs.length;
  const dislocationScore = rawLegs.reduce((s, raw) => {
    const modelMinusMarket = raw.marketImpliedProb !== null
      ? raw.probability - raw.marketImpliedProb
      : raw.edgeScore;
    const sharpness = (raw.sharpnessScore ?? 50) / 100;
    const durabilityBonus = raw.edgeDurability === 'stable' ? 1.2
      : raw.edgeDurability === 'mixed' ? 1.0
      : raw.edgeDurability === 'fragile' ? 0.7
      : 1.0;
    const publicBiasAdj = raw.publicBiasTags.includes('STRUCTURAL_EDGE') ? 1.15 : 1.0;
    return s + modelMinusMarket * sharpness * durabilityBonus * publicBiasAdj;
  }, 0);

  const grade = letterGradeWithCeiling(
    { dislocationScore, combinedFairPayout, combinedEdgePercent, tier: legCountLabel },
    tier.gradeCeiling,
  );

  const rationale = buildRationale(rawLegs, legs, {
    combinedFairPayout, dislocationScore, combinedEdgePercent, tier: legCountLabel,
  });

  return {
    tier: legCountLabel,
    legs,
    combinedProbability,
    combinedFairPayout,
    combinedEdgePercent: Math.round(combinedEdgePercent * 10) / 10,
    dislocationScore: Math.round(dislocationScore * 10) / 10,
    grade,
    rationale,
  };
}

function legToElite(c: EliteCandidate): EliteLeg {
  // EliteLeg.playerId is typed `number`. Coerce; non-numeric string
  // ids (rare for MLB/NBA — relevant for UFC where ESPN athlete ids
  // are sometimes alphanumeric) collapse to 0 so the shape stays
  // valid. The display name carries identity in those cases anyway,
  // and espnAthleteId carries the canonical id separately for
  // headshot resolution.
  const numericId = typeof c.playerId === 'string' && /^\d+$/.test(c.playerId)
    ? Number(c.playerId)
    : Number(c.playerId);
  return {
    playerId: Number.isFinite(numericId) ? numericId : 0,
    espnAthleteId: c.espnAthleteId,
    playerName: c.playerName,
    team: c.team,
    statKey: c.statKey,
    statLabel: c.statLabel,
    line: c.line,
    direction: c.direction,
    probability: Math.round(c.probability * 10) / 10,
    edgePercent: Math.round(c.edgeScore * 10) / 10,
    trapScore: Math.round(c.trapScore),
    fragilityScore: Math.round(c.fragilityScore),
    marketImpliedProb: c.marketImpliedProb,
    publicBiasTags: c.publicBiasTags,
    sharpnessScore: c.sharpnessScore,
    edgeDurability: c.edgeDurability,
    qualifyingEdge: c.qualifyingEdge,
  };
}

function letterGradeWithCeiling(s: { dislocationScore: number; combinedFairPayout: number; combinedEdgePercent: number; tier: '3-leg' | '2-leg' }, ceiling: 'A+' | 'A' | 'B' | 'C'): 'A+' | 'A' | 'B' {
  // Compute the natural grade then cap it at the tier ceiling. We
  // don't return 'C' from EliteTicket.grade (that would require typed
  // changes upstream); we collapse C-ceiling tier outputs to 'B'.
  let natural: 'A+' | 'A' | 'B' = 'B';
  if (s.tier === '3-leg') {
    if (s.dislocationScore >= 30 && s.combinedFairPayout >= 8   && s.combinedEdgePercent >= 13) natural = 'A+';
    else if (s.dislocationScore >= 22 && s.combinedFairPayout >= 6.5 && s.combinedEdgePercent >= 10) natural = 'A';
  } else {
    if (s.dislocationScore >= 22 && s.combinedFairPayout >= 4   && s.combinedEdgePercent >= 13) natural = 'A+';
    else if (s.dislocationScore >= 16 && s.combinedFairPayout >= 3.2 && s.combinedEdgePercent >= 10) natural = 'A';
  }
  if (ceiling === 'A+') return natural;
  if (ceiling === 'A')  return natural === 'A+' ? 'A' : natural;
  return 'B';   // 'B' or 'C' ceiling collapses to B
}

function buildRationale(rawLegs: EliteCandidate[], legs: EliteLeg[], s: { combinedFairPayout: number; dislocationScore: number; combinedEdgePercent: number; tier: '3-leg' | '2-leg' }): string[] {
  const out: string[] = [];
  out.push(`Combined fair payout ${s.combinedFairPayout.toFixed(1)}× · combined hit ${(legs.map((l) => l.probability / 100).reduce((p, q) => p * q, 1) * 100).toFixed(1)}%.`);
  const sports = collectSports({ legs, tier: s.tier } as unknown as CrossSportTicket);
  // 'mma' → 'UFC' for user-facing rationale text (matches the rest
  // of the platform's sport label vocabulary).
  const sportLabel = (sp: Sport): string => sp === 'mma' ? 'UFC' : sp.toUpperCase();
  out.push(`Cross-sport coverage: ${sports.length === 1 ? sportLabel(sports[0]!) : sports.map(sportLabel).join(' + ')}.`);
  const edgeKinds = legs.map((l) => l.qualifyingEdge);
  out.push(`Qualifying edges: ${[...new Set(edgeKinds)].join(' + ')}.`);
  out.push(`Mean leg edge ${s.combinedEdgePercent.toFixed(1)}; dislocation ${s.dislocationScore.toFixed(1)}.`);
  void rawLegs;
  return out;
}

function collectSports(ticket: { legs: EliteLeg[] }): Sport[] {
  // The EliteLeg type doesn't carry sport directly. Detect via the
  // statKey vocabulary — each sport has a distinct set of stat keys.
  const MLB_STATS = new Set(['home_runs', 'total_bases', 'rbis', 'runs', 'hits', 'hits_runs_rbis', 'walks', 'stolen_bases', 'strikeouts', 'doubles', 'triples', 'ks', 'pitcher_outs', 'innings_pitched', 'earned_runs_allowed', 'hits_allowed', 'walks_allowed', 'home_runs_allowed']);
  const MMA_STATS = new Set(['sig_strikes', 'rd1_sig_strikes', 'takedowns', 'rd1_takedowns', 'knockdowns', 'rounds', 'fight_time', 'fantasy_score', 'control_time']);
  const sports = new Set<Sport>();
  for (const leg of ticket.legs) {
    if (MMA_STATS.has(leg.statKey)) sports.add('mma');
    else if (MLB_STATS.has(leg.statKey)) sports.add('mlb');
    else sports.add('nba');
  }
  return [...sports];
}
