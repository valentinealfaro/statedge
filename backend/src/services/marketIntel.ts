// Market Intelligence Engine — Phase 101.
//
// Per the team's directive: stop being a "projection engine + ranking
// layer," become a "projection engine + sportsbook disagreement engine."
// This module is the disagreement engine.
//
// Inputs: a leg's projection, line, recent + season averages, fragility,
// trap, reasonCodes, edge%. Outputs: explicit market-implied probability,
// public-bias tag set, line-inflation score, sharpness score, edge
// durability tier, and a single-sentence "why the market may be wrong"
// narrative.
//
// IMPORTANT: this engine is intentionally heuristic — we do NOT have
// real line-history, sharp-action, or public-bet-percentage feeds. Every
// "market" inference is derived from the projection vs season + recent
// baseline distribution. When we get real market data, only this module
// gets upgraded; the surface area stays stable.
//
// Sport-agnostic. NBA / MLB / WNBA all call the same function.

export type PublicBiasTag =
  | 'STAR_TAX'           // big-name premium — line above season baseline + thin model edge
  | 'STREAK_INFLATION'   // L5 spike + line walked up — typical recency-bias pattern
  | 'PUBLIC_OVER'        // OVER side + line above season + thin edge + trap risk
  | 'NARRATIVE_RISK'     // reasonCodes mention spike/streak/surge — line priced to story
  | 'CONTRARIAN_VALUE'   // we agree with the UNDER / under-the-radar side
  | 'STRUCTURAL_EDGE';   // matchup/park/weather/usage signals — edge has real legs

export type EdgeDurability = 'stable' | 'mixed' | 'fragile';

export type MarketIntelInputs = {
  probability: number;        // 0-100, our model
  edgePercent: number;        // model − implied break-even
  projection: number;          // model's central projection
  line: number;
  seasonAvg: number;          // 0+ (use 0 to skip season-relative checks)
  l5Avg: number | null;
  l10Avg: number | null;
  fragilityScore: number;     // 0-100
  trapScore: number;          // 0-100
  reasonCodes: string[];
  direction: 'OVER' | 'UNDER';
  statKey: string;
};

export type MarketIntelResult = {
  // Explicit market implied probability — what break-even rate the
  // sportsbook is pricing at. Front-and-center on every leg per the
  // Phase 101 spec ("EVERY line must compute market implied probability").
  marketImpliedProb: number;

  // 0-100 — how much has the line walked up relative to season + recent
  // averages. Not the same as trap (which conflates spike + line move
  // + outlier risk). This isolates the line-walk component.
  lineInflationScore: number;

  // Why the line might be priced this way from the public's perspective.
  publicBiasTags: PublicBiasTag[];

  // 0-100 — how robust is the underlying edge. Composite of low
  // fragility + low trap + rich reasonCodes + conviction distance from
  // coin-flip. A +12% edge with 75 sharpness beats a +18% edge with 35
  // sharpness — the smaller edge is more real.
  sharpnessScore: number;

  // Stable = matchup/role/usage driving the edge — edge persists
  // tomorrow. Fragile = pure recent streak / unsustainable shooting %.
  // Mixed = some of each.
  edgeDurability: EdgeDurability;

  // Single-sentence "why the market may be wrong" narrative. The Phase
  // 101 spec calls this the platform moat. Null when we don't have a
  // defensible read.
  whyMarketWrong: string | null;
};

// Regexes encode signal categories. Update one place when new reason
// codes get added to projection engines.
const STABLE_SIGNAL_RE = /\b(matchup|park|weather|opponent|starter|bullpen|rotation|lineup|injury|role|usage|vs[ -][LR]HP|vs L|vs R|game[- ]script)\b/i;
const FRAGILE_SIGNAL_RE = /\b(spike|streak|surge|recent.{0,15}heat|hot stretch|small sample|thin sample|low.*conf|volatile)\b/i;
const NARRATIVE_RE = /\b(spike|streak|surge)\b/i;

export function computeMarketIntel(i: MarketIntelInputs): MarketIntelResult {
  // 1. Implied probability — explicit derivation. edge = our_p − implied,
  // so implied = our_p − edge. Clamped to [1, 99] to prevent display
  // artifacts on extreme edges.
  const marketImpliedProb = Math.max(1, Math.min(99, i.probability - i.edgePercent));

  // 2. Line inflation — how high is the line sitting vs season baseline?
  // We use season as the slow-moving anchor. Recent (L5) is checked
  // separately for the streak-inflation tag below. A line at season *
  // 1.20 → score 40; at season * 1.50 → 100.
  const inflationVsSeason = i.seasonAvg > 0 ? Math.max(0, (i.line - i.seasonAvg) / i.seasonAvg) : 0;
  const lineInflationScore = Math.round(Math.min(100, inflationVsSeason * 200));

  // 3. Public bias tags — heuristic categorizations.
  const tags: PublicBiasTag[] = [];

  // STAR_TAX: line walks high but our model edge is thin. Pattern:
  // sportsbook is pricing the player's name (rep + media presence),
  // not a structural mispricing.
  if (
    i.seasonAvg > 0 &&
    i.line >= i.seasonAvg &&
    i.projection >= i.seasonAvg * 1.05 &&
    Math.abs(i.edgePercent) < 5
  ) {
    tags.push('STAR_TAX');
  }

  // STREAK_INFLATION: L5 average ≥20% above season baseline AND line
  // also walked up + non-zero trap signal. Classic recency-bias trap.
  if (
    i.l5Avg !== null &&
    i.seasonAvg > 0 &&
    i.l5Avg >= i.seasonAvg * 1.20 &&
    i.line >= i.seasonAvg * 1.10 &&
    i.trapScore >= 40
  ) {
    tags.push('STREAK_INFLATION');
  }

  // PUBLIC_OVER: OVER + line walked above season + edge thin + trap
  // signal. The classic public-hammer pattern — line is priced for
  // public action, not actual distribution.
  if (
    i.direction === 'OVER' &&
    i.seasonAvg > 0 &&
    i.line >= i.seasonAvg * 1.15 &&
    Math.abs(i.edgePercent) < 8 &&
    i.trapScore >= 30
  ) {
    tags.push('PUBLIC_OVER');
  }

  // NARRATIVE_RISK: reasonCodes explicitly call out spike/streak/surge.
  // Even when other tags don't fire, this flags edges built on a
  // narrative the market may also be pricing.
  if (i.reasonCodes.some((r) => NARRATIVE_RE.test(r))) {
    tags.push('NARRATIVE_RISK');
  }

  // CONTRARIAN_VALUE: UNDER side + line at season high + meaningful
  // edge. The market is leaning over via public action; we're taking
  // the unloved side.
  if (
    i.direction === 'UNDER' &&
    i.seasonAvg > 0 &&
    i.line >= i.seasonAvg * 1.10 &&
    i.edgePercent >= 10
  ) {
    tags.push('CONTRARIAN_VALUE');
  }

  // STRUCTURAL_EDGE: edge is supported by ≥2 stable signals (matchup,
  // park, weather, usage, etc.). High durability tier.
  const stableHits = i.reasonCodes.filter((r) => STABLE_SIGNAL_RE.test(r)).length;
  if (stableHits >= 2 && Math.abs(i.edgePercent) >= 7) {
    tags.push('STRUCTURAL_EDGE');
  }

  // 4. Sharpness — edge quality composite.
  // Sharper when fragility is low, trap is low, reasonCodes are rich,
  // and conviction is meaningfully off coin-flip. Each component is
  // independently bounded [0, 100] then weighted.
  const fragilityComponent = (100 - i.fragilityScore) * 0.30;
  const trapComponent      = (100 - i.trapScore)      * 0.25;
  const reasonRichness     = Math.min(100, i.reasonCodes.length * 15) * 0.20;
  const convictionFromCoin = Math.min(100, Math.abs(i.probability - 50) * 2) * 0.25;
  const sharpnessScore = Math.round(fragilityComponent + trapComponent + reasonRichness + convictionFromCoin);

  // 5. Edge durability — stable vs fragile vs mixed.
  // Decision tree: high fragility OR more fragile signals than stable
  // ones → fragile. ≥2 stable signals AND low fragility → stable.
  // Anything else → mixed.
  const fragileHits = i.reasonCodes.filter((r) => FRAGILE_SIGNAL_RE.test(r)).length;
  let edgeDurability: EdgeDurability;
  if (i.fragilityScore >= 65 || fragileHits > stableHits) {
    edgeDurability = 'fragile';
  } else if (stableHits >= 2 && i.fragilityScore <= 45) {
    edgeDurability = 'stable';
  } else {
    edgeDurability = 'mixed';
  }

  // 6. "Why the market may be wrong" — single-sentence narrative.
  // Only emitted when edge is meaningful AND we can defend it. Phase
  // 101 spec: "this becomes the platform moat."
  let whyMarketWrong: string | null = null;
  if (Math.abs(i.edgePercent) >= 8) {
    if (tags.includes('STREAK_INFLATION') && i.l5Avg !== null) {
      whyMarketWrong = `Market overweighting recent L5 (${i.l5Avg.toFixed(1)}) — model anchored to ${i.seasonAvg.toFixed(1)} season baseline rebalances toward true distribution.`;
    } else if (tags.includes('PUBLIC_OVER')) {
      whyMarketWrong = `Line walked to ${i.line} for public OVER action — model projects ${i.projection.toFixed(1)}, market is paying the public-hammer premium.`;
    } else if (tags.includes('STAR_TAX')) {
      whyMarketWrong = `Line priced for player reputation, not distribution. Star-tax inflation typical on name-recognition props.`;
    } else if (tags.includes('CONTRARIAN_VALUE')) {
      whyMarketWrong = `Public is hammering the OVER; book is leaning into it. Model says the unloved UNDER has ${Math.abs(i.edgePercent).toFixed(0)}% edge.`;
    } else if (tags.includes('STRUCTURAL_EDGE')) {
      const codes = i.reasonCodes.filter((r) => STABLE_SIGNAL_RE.test(r)).slice(0, 2);
      whyMarketWrong = `Market underweighting structural signals: ${codes.join(' · ')}. Edge has real legs.`;
    } else if (i.edgePercent < 0 && i.direction === 'UNDER') {
      whyMarketWrong = `Line favors the UNDER but market may be overcorrecting; model still leans toward distribution baseline.`;
    } else {
      whyMarketWrong = `${Math.abs(i.edgePercent).toFixed(0)}% gap between our model (${i.probability.toFixed(0)}%) and market (${marketImpliedProb.toFixed(0)}%) — confirm with sharpness ${sharpnessScore} before sizing.`;
    }
  }

  return {
    marketImpliedProb: Math.round(marketImpliedProb * 10) / 10,
    lineInflationScore,
    publicBiasTags: tags,
    sharpnessScore,
    edgeDurability,
    whyMarketWrong,
  };
}
