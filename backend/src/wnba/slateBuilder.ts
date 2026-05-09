// WNBA slate builder — Phase 77b port of MLB's Phase 58 Exposure
// Control & Portfolio Protection Engine.
//
// Same algorithm: ASC build order (Best 2 → Best 6), slate-wide
// exposure tracking (player / game / team / stat-family), soft
// penalty schedule on subsequent picks, hard cap (max 4 of 6 slots
// per player, 5 if institutional). Same-game cap of 2 across all
// sizes ≥3 to prevent environmental fragility from sinking
// multiple cards on one bad game.
//
// WNBA-specific tweaks vs MLB:
//   - Stat families adapted for basketball (scoring_volume / floor_play
//     / power_3pt / defense / discipline / combo)
//   - Combo-stat pairing block: PRA contains points + rebounds + assists
//     so stacking PRA + Points + Rebounds on the same player creates
//     the catastrophic dependency the spec calls out
//   - No HR/triples magnet (basketball doesn't have rare-event power
//     props the same way; high-ceiling 3pt_made plays are isolated)

import type { ProjectedWnbaLine } from './projection.js';

export type WnbaSlateMode = 'safe' | 'balanced' | 'aggressive' | 'insane' | 'auto';
export type WnbaResolvedSlateMode = Exclude<WnbaSlateMode, 'auto'>;

const MODE_CONFIG: Record<WnbaResolvedSlateMode, {
  label: string;
  minLegProb: number;
  minLegEdge: number;
  maxLegTrap: number;
  allowedSizes: ReadonlySet<number>;
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
    perSize: {
      2: { minAvgEdge: 5,  maxLegFragility: 80 },
      3: { minAvgEdge: 7,  maxLegFragility: 70 },
      4: { minAvgEdge: 9,  maxLegFragility: 60 },
      5: { minAvgEdge: 14, maxLegFragility: 55 },
      6: { minAvgEdge: 17, maxLegFragility: 50 },
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
      5: { minAvgEdge: 18, maxLegFragility: 60 },
      6: { minAvgEdge: 22, maxLegFragility: 55 },
    },
  },
  insane: {
    label: 'Insane',
    minLegProb: 45,
    minLegEdge: 8,
    maxLegTrap: 70,
    allowedSizes: new Set([5, 6]),
    perSize: {
      5: { minAvgEdge: 14, maxLegFragility: 85 },
      6: { minAvgEdge: 16, maxLegFragility: 80 },
    },
  },
};

// ---------- Stat family taxonomy (WNBA basketball) ----------

const STAT_FAMILY_MAP: Record<string, string> = {
  points:         'scoring_volume',
  fg_made:        'scoring_volume',
  fg_attempted:   'scoring_volume',
  ft_made:        'scoring_volume',
  ft_attempted:   'scoring_volume',
  rebounds:       'floor_play',
  assists:        'floor_play',
  three_pt_made:  'power_3pt',
  steals:         'defense',
  blocks:         'defense',
  stocks:         'defense',
  turnovers:      'discipline',
  personal_fouls: 'discipline',
  pra:            'combo',
  pr:             'combo',
  pa:             'combo',
  ra:             'combo',
};

function statFamilyOf(statKey: string): string {
  return STAT_FAMILY_MAP[statKey] ?? 'other';
}

// Combo stats absorb their components — stacking PRA + Points on the
// same player is a catastrophic dependency since one bad game kills
// both legs. This is the basketball equivalent of MLB's HR-pairing
// block (Phase 32).
const COMBO_CONTAINS: Record<string, Set<string>> = {
  pra: new Set(['points', 'rebounds', 'assists', 'pr', 'pa', 'ra']),
  pr:  new Set(['points', 'rebounds']),
  pa:  new Set(['points', 'assists']),
  ra:  new Set(['rebounds', 'assists']),
};

function createsComboDependency(newStat: string, existingStats: Set<string>): boolean {
  // If the new stat is a combo, block when any of its components
  // already appears for this player.
  const newComponents = COMBO_CONTAINS[newStat];
  if (newComponents) {
    for (const s of existingStats) if (newComponents.has(s)) return true;
  }
  // If the new stat is a component, block when a combo containing it
  // already appears.
  for (const existing of existingStats) {
    const components = COMBO_CONTAINS[existing];
    if (components && components.has(newStat)) return true;
  }
  return false;
}

// Per-card same-family cap. Best 5/6 enforce diversity (no all-points
// or all-3PT stacks); smaller cards are exempt.
function maxLegsPerFamilyInCard(cardSize: number): number {
  if (cardSize >= 5) return 3;
  return cardSize;
}

// Per-card same-player cap.
function maxLegsPerPlayer(cardSize: number): number {
  if (cardSize >= 5) return 2;
  return 3;
}

// Per-card same-game cap. Tightened to 2 for sizes ≥3 — environmental
// fragility (blowout pace collapse, foul trouble cascade) wipes
// stacked offensive overs together in basketball even more reliably
// than baseball.
function maxLegsPerGame(_cardSize: number): number {
  return 2;
}

// Per-team-OVER hitter cap. Same-team scoring shares pace, blowouts
// kill bench scoring, etc.
function maxLegsPerTeamSide(cardSize: number): number {
  if (cardSize >= 5) return 2;
  return 3;
}

// ---------- Slate exposure tracker (Phase 58 model) ----------

type SlateExposure = {
  player: Map<string, number>;       // WNBA athleteId is string
  game: Map<string, number>;
  team: Map<string, number>;
  family: Map<string, number>;
};

function newSlateExposure(): SlateExposure {
  return { player: new Map(), game: new Map(), team: new Map(), family: new Map() };
}

function gameKeyFor(line: ProjectedWnbaLine): string | null {
  // Lines don't carry gameKey in v1 — use team as a coarse proxy.
  // This degrades the same-game cap into a same-team cap, which is
  // acceptable for v1. Real game keys land in 77c when the slate
  // pipeline persists matchup ids.
  return line.team ? `team::${line.team}` : null;
}

function teamSideKey(line: ProjectedWnbaLine): string | null {
  if (!line.team) return null;
  return `${line.team}::${line.direction}`;
}

function addLegToExposure(exp: SlateExposure, leg: ProjectedWnbaLine): void {
  exp.player.set(leg.athleteId, (exp.player.get(leg.athleteId) ?? 0) + 1);
  const gKey = gameKeyFor(leg);
  if (gKey) exp.game.set(gKey, (exp.game.get(gKey) ?? 0) + 1);
  if (leg.team) exp.team.set(leg.team, (exp.team.get(leg.team) ?? 0) + 1);
  const fam = statFamilyOf(leg.statKey);
  exp.family.set(fam, (exp.family.get(fam) ?? 0) + 1);
}

// Institutional grade — strict on purpose; this should be the
// minority of any slate. Same gates MLB uses, mapped to WNBA's
// projection shape.
function isInstitutionalGrade(leg: ProjectedWnbaLine): boolean {
  return leg.probability >= 70
    && leg.edgePercent >= 12
    && leg.fragilityScore <= 40
    && leg.trapScore <= 35;
}

function maxCardAppearances(leg: ProjectedWnbaLine): number {
  return isInstitutionalGrade(leg) ? 5 : 4;
}

function exposurePenalty(leg: ProjectedWnbaLine, exp: SlateExposure): number {
  let penalty = 0;
  const playerPrior = exp.player.get(leg.athleteId) ?? 0;
  const isInst = isInstitutionalGrade(leg);
  const playerSchedule = isInst
    ? [0, 0, 4, 10, 30, 1000]
    : [0, 0, 8, 22, 60, 1000];
  penalty += playerSchedule[Math.min(playerPrior, 5)] ?? 1000;

  const gKey = gameKeyFor(leg);
  if (gKey) {
    const gPrior = exp.game.get(gKey) ?? 0;
    if (gPrior >= 2) penalty += (gPrior - 1) * 4;
  }
  if (leg.team) {
    const tPrior = exp.team.get(leg.team) ?? 0;
    if (tPrior >= 2) penalty += (tPrior - 1) * 2.5;
  }
  const fam = statFamilyOf(leg.statKey);
  const fPrior = exp.family.get(fam) ?? 0;
  if (fPrior >= 3) penalty += (fPrior - 2) * 1.5;
  return penalty;
}

// ---------- Leg scoring per mode ----------

function legScore(leg: ProjectedWnbaLine, mode: WnbaResolvedSlateMode): number {
  switch (mode) {
    case 'safe':
      return leg.probability * 0.50 - leg.fragilityScore * 0.20 - leg.trapScore * 0.15;
    case 'balanced':
      return leg.probability * 0.30 + leg.edgePercent * 0.30 - leg.fragilityScore * 0.15 - leg.trapScore * 0.10;
    case 'aggressive':
      return leg.edgePercent * 0.45 + leg.momentumScore * 0.20 + leg.probability * 0.15 - leg.trapScore * 0.10;
    case 'insane':
      return leg.edgePercent * 0.40 + leg.momentumScore * 0.30 - leg.trapScore * 0.05;
  }
}

function diversifiedScore(
  leg: ProjectedWnbaLine,
  mode: WnbaResolvedSlateMode,
  exp: SlateExposure,
): number {
  return legScore(leg, mode) - exposurePenalty(leg, exp);
}

// ---------- Pick + filter ----------

function eligibleLegs(lines: ProjectedWnbaLine[], mode: WnbaResolvedSlateMode): ProjectedWnbaLine[] {
  const cfg = MODE_CONFIG[mode];
  return lines.filter((l) => {
    if (l.probability < cfg.minLegProb) return false;
    if (l.edgePercent < cfg.minLegEdge) return false;
    if (l.trapScore > cfg.maxLegTrap) return false;
    // At-volume / coin-flip filter (Phase 96, ported from MLB Phase 90).
    // When |line − seasonAvg| sits within 10% of season volume, the
    // prop is structurally a coin flip — model edge is mostly noise.
    // Insane mode hard-skips; Aggressive softens to probability ≥58%.
    if ((mode === 'insane' || mode === 'aggressive') && l.seasonAvg > 0) {
      const dist = Math.abs(l.line - l.seasonAvg);
      const atVolume = dist < l.seasonAvg * 0.10;
      if (atVolume) {
        if (mode === 'insane') return false;
        if (l.probability < 58) return false;
      }
    }
    return true;
  });
}

function pickTopN(
  pool: ProjectedWnbaLine[],
  n: number,
  mode: WnbaResolvedSlateMode,
  slateExposure: SlateExposure,
): ProjectedWnbaLine[] {
  const ranked = [...pool].sort((a, b) =>
    diversifiedScore(b, mode, slateExposure) - diversifiedScore(a, mode, slateExposure),
  );
  const picked: ProjectedWnbaLine[] = [];
  const playerLegCount = new Map<string, number>();
  const playerStatsUsed = new Map<string, Set<string>>();
  const gameLegCount = new Map<string, number>();
  const teamSideLegCount = new Map<string, number>();
  const familyLegCount = new Map<string, number>();

  const cap = maxLegsPerPlayer(n);
  const gameCap = maxLegsPerGame(n);
  const teamSideCap = maxLegsPerTeamSide(n);
  const famCap = maxLegsPerFamilyInCard(n);

  for (const l of ranked) {
    const slatePrior = slateExposure.player.get(l.athleteId) ?? 0;
    if (slatePrior >= maxCardAppearances(l)) continue;

    const seen = playerLegCount.get(l.athleteId) ?? 0;
    if (seen >= cap) continue;

    const usedStats = playerStatsUsed.get(l.athleteId) ?? new Set<string>();
    if (usedStats.has(l.statKey)) continue;
    if (createsComboDependency(l.statKey, usedStats)) continue;

    const gKey = gameKeyFor(l);
    if (gKey) {
      const gameSeen = gameLegCount.get(gKey) ?? 0;
      if (gameSeen >= gameCap) continue;
    }
    const tsKey = teamSideKey(l);
    if (tsKey) {
      const tsSeen = teamSideLegCount.get(tsKey) ?? 0;
      if (tsSeen >= teamSideCap) continue;
    }
    const fam = statFamilyOf(l.statKey);
    const famSeen = familyLegCount.get(fam) ?? 0;
    if (famSeen >= famCap) continue;

    picked.push(l);
    playerLegCount.set(l.athleteId, seen + 1);
    usedStats.add(l.statKey);
    playerStatsUsed.set(l.athleteId, usedStats);
    if (gKey) gameLegCount.set(gKey, (gameLegCount.get(gKey) ?? 0) + 1);
    if (tsKey) teamSideLegCount.set(tsKey, (teamSideLegCount.get(tsKey) ?? 0) + 1);
    familyLegCount.set(fam, famSeen + 1);
    if (picked.length >= n) break;
  }
  return picked;
}

// ---------- Combo packaging ----------

export type WnbaCombo = {
  label: 'Best 2' | 'Best 3' | 'Best 4' | 'Best 5' | 'Best 6';
  size: number;
  subtitle: string;
  legs: ProjectedWnbaLine[];
  rawCombinedHit: number;
  adjustedCombinedHit: number;
  correlationRisk: 'None' | 'Low' | 'Medium' | 'High' | 'Very High';
  correlationPairs: number;
  averageEdge: number;
  averageTrap: number;
  averageFragility: number;
  weakestLegName: string;
  weakestLegReason: string;
  constructionNotes: {
    uniquePlayers: number;
    uniqueStats: number;
    uniqueTeams: number;
    summary: string;
  };
};

function combinedHit(legs: ProjectedWnbaLine[]): number {
  let p = 1;
  for (const l of legs) p *= l.probability / 100;
  return Math.round(p * 1000) / 10;
}

function correlationRisk(legs: ProjectedWnbaLine[]): { tier: WnbaCombo['correlationRisk']; multiplier: number; pairs: number } {
  let pairs = 0;
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      if (legs[i]!.team && legs[i]!.team === legs[j]!.team) pairs += 1;
    }
  }
  if (pairs === 0) return { tier: 'None', multiplier: 1.00, pairs };
  if (pairs === 1) return { tier: 'Low', multiplier: 0.97, pairs };
  if (pairs === 2) return { tier: 'Medium', multiplier: 0.92, pairs };
  if (pairs === 3) return { tier: 'High', multiplier: 0.85, pairs };
  return { tier: 'Very High', multiplier: 0.75, pairs };
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 10) / 10;
}

function subtitleFor(mode: WnbaResolvedSlateMode, size: number): string {
  if (mode === 'insane') return size === 6 ? 'Lottery · ~50× target' : 'Lottery · high ceiling';
  if (mode === 'safe') return 'Safe Core · highest probability';
  if (mode === 'aggressive') return size >= 5 ? 'Aggressive Edge · strongest mispricings' : 'Aggressive Edge · projection gaps';
  if (size <= 2) return 'Safe Core · highest probability';
  if (size <= 3) return 'Safe Core · balanced anchor';
  if (size === 4) return 'Balanced EV · risk-adjusted edge';
  return 'Aggressive Edge · projection gaps';
}

function makeCombo(size: number, legs: ProjectedWnbaLine[], mode: WnbaResolvedSlateMode): WnbaCombo {
  const label = (`Best ${size}`) as WnbaCombo['label'];
  let worst = legs[0]!;
  for (const l of legs) {
    const score = (l.trapScore ?? 0) + (l.fragilityScore ?? 0);
    const wScore = (worst.trapScore ?? 0) + (worst.fragilityScore ?? 0);
    if (score > wScore) worst = l;
  }
  const weakestLegReason = worst.reasonCodes.find((r) => /trap|volat|thin|fragile/i.test(r))
    ?? 'Highest combined trap + fragility on this card.';

  const raw = combinedHit(legs);
  const corr = correlationRisk(legs);
  const adjusted = Math.round(raw * corr.multiplier * 10) / 10;

  const uniquePlayers = new Set(legs.map((l) => l.athleteId)).size;
  const uniqueStats = new Set(legs.map((l) => l.statKey)).size;
  const uniqueTeams = new Set(legs.map((l) => l.team).filter(Boolean)).size;
  const summary =
    legs.length >= 5 && uniquePlayers === legs.length && uniqueTeams >= legs.length - 1
      ? `Diversified portfolio. ${uniquePlayers} players · ${uniqueStats} stats · ${uniqueTeams} teams.`
      : `${uniquePlayers} players · ${uniqueStats} stats · ${uniqueTeams} teams.`;

  return {
    label,
    size,
    subtitle: subtitleFor(mode, size),
    legs,
    rawCombinedHit: raw,
    adjustedCombinedHit: adjusted,
    correlationRisk: corr.tier,
    correlationPairs: corr.pairs,
    averageEdge: avg(legs.map((l) => l.edgePercent)),
    averageTrap: avg(legs.map((l) => l.trapScore)),
    averageFragility: avg(legs.map((l) => l.fragilityScore)),
    weakestLegName: worst.playerName,
    weakestLegReason,
    constructionNotes: {
      uniquePlayers,
      uniqueStats,
      uniqueTeams,
      summary,
    },
  };
}

// ---------- Auto mode resolver ----------

function resolveAutoMode(eligible: ProjectedWnbaLine[]): WnbaResolvedSlateMode {
  if (eligible.length < 4) return 'safe';
  const eliteCount = eligible.filter((l) => l.edgePercent >= 18).length;
  const strongCount = eligible.filter((l) => l.edgePercent >= 12).length;
  if (eliteCount >= 6 && strongCount >= 10) return 'insane';
  if (strongCount >= 6) return 'aggressive';
  if (eligible.length >= 6) return 'balanced';
  return 'safe';
}

// ---------- Public entry point ----------

export type WnbaSlateResult = {
  resolvedMode: WnbaResolvedSlateMode;
  combos: Array<{
    size: number;
    label: WnbaCombo['label'];
    combo: WnbaCombo | null;
    reason: string;
  }>;
};

export function buildWnbaSlate(
  lines: ProjectedWnbaLine[],
  mode: WnbaSlateMode = 'balanced',
): WnbaSlateResult {
  const resolvedMode: WnbaResolvedSlateMode =
    mode === 'auto' ? resolveAutoMode(lines) : mode;
  const cfg = MODE_CONFIG[resolvedMode];
  const eligible = eligibleLegs(lines, resolvedMode);

  const slots: WnbaSlateResult['combos'] = [];
  const slateExposure = newSlateExposure();
  const sizes = [...cfg.allowedSizes].sort((a, b) => a - b);

  for (const size of sizes) {
    const label = (`Best ${size}`) as WnbaCombo['label'];
    const sizeFragCap = cfg.perSize[size]?.maxLegFragility;
    const sizePool = sizeFragCap !== undefined
      ? eligible.filter((l) => l.fragilityScore <= sizeFragCap)
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
    const picks = pickTopN(sizePool, size, resolvedMode, slateExposure);
    if (picks.length < size) {
      slots.push({
        size,
        label,
        combo: null,
        reason: `Not enough diversified legs to fill ${size}: only ${picks.length} pass intra-card caps + slate-wide exposure limits.`,
      });
      continue;
    }
    const sizeReq = cfg.perSize[size];
    const avgEdge = avg(picks.map((l) => l.edgePercent));
    if (sizeReq && avgEdge < sizeReq.minAvgEdge) {
      slots.push({
        size,
        label,
        combo: null,
        reason: `No clean ${size}-leg edge tonight (avg edge ${avgEdge.toFixed(1)}% < required ${sizeReq.minAvgEdge}%).`,
      });
      continue;
    }
    slots.push({ size, label, combo: makeCombo(size, picks, resolvedMode), reason: 'OK' });
    for (const leg of picks) addLegToExposure(slateExposure, leg);
  }

  return { resolvedMode, combos: slots };
}
