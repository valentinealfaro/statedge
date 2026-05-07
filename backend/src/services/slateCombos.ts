// Server-side computation of the "Pre-built parlays" rail (Best 2-6 +
// Wild Card). Logic is ported from the frontend BestPicksRail so we
// have one source of truth and a stable per-day snapshot we can grade
// against actuals later.
//
// Inputs are ResolvedLine[] (already enriched by slatePipeline). Each
// combo touches N distinct players (variance is correlated within a
// player, especially across PRA/PR/PA combo stats), and Wild Card
// adds a stricter stat-label diversity rule.

import type { Last10StatId } from './last10.js';
import type { ResolvedLine } from './slatePipeline.js';

export type ComboLeg = {
  // Leg identity (used to grade against player_game_logs later):
  playerId: number;
  playerName: string;
  team: string | null;
  opponentAbbr: string | null;
  statKey: Last10StatId;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';

  // Snapshot of the model state at lock time so the History view can
  // show the user "what we predicted" alongside "what happened":
  pct: number;             // hit % for the chosen direction (0-100)
  edge: number;            // projection-engine edge score (0-100)
  l10Avg: number;
  vsOppAvg: number | null;
};

export type Combo = {
  // Stable label used as the row key in the History UI:
  label: 'Best 2' | 'Best 3' | 'Best 4' | 'Best 5' | 'Best 6' | 'Wild Card';
  // 'safe' = top picks combo, 'wild' = longshot variant.
  tag: 'safe' | 'wild';
  legs: ComboLeg[];
  combinedPct: number;     // product of leg pcts (assumes independence)
};

type Candidate = {
  line: ResolvedLine;
  pct: number;
  edge: number;
  direction: 'OVER' | 'UNDER';
};

function pickDiverse(sorted: Candidate[], n: number): Candidate[] {
  const seen = new Set<number>();
  const out: Candidate[] = [];
  for (const c of sorted) {
    if (seen.has(c.line.playerId)) continue;
    out.push(c);
    seen.add(c.line.playerId);
    if (out.length === n) break;
  }
  return out;
}

function pickDiverseByStat(sorted: Candidate[], n: number): Candidate[] {
  const seenPlayers = new Set<number>();
  const seenStats = new Set<string>();
  const out: Candidate[] = [];
  for (const c of sorted) {
    if (seenPlayers.has(c.line.playerId)) continue;
    if (seenStats.has(c.line.statLabel)) continue;
    out.push(c);
    seenPlayers.add(c.line.playerId);
    seenStats.add(c.line.statLabel);
    if (out.length === n) break;
  }
  // Relax stat constraint to fill remaining slots if the slate doesn't
  // have enough variety in the longshot zone.
  if (out.length < n) {
    for (const c of sorted) {
      if (out.includes(c)) continue;
      if (seenPlayers.has(c.line.playerId)) continue;
      out.push(c);
      seenPlayers.add(c.line.playerId);
      if (out.length === n) break;
    }
  }
  return out;
}

function combinedPct(picks: Candidate[]): number {
  return picks.reduce((p, c) => p * (c.pct / 100), 1) * 100;
}

function toLeg(c: Candidate): ComboLeg {
  return {
    playerId: c.line.playerId,
    playerName: c.line.playerName,
    team: c.line.team,
    opponentAbbr: c.line.vsOpponent?.opponentAbbr ?? null,
    statKey: c.line.statKey,
    statLabel: c.line.statLabel,
    line: c.line.line,
    direction: c.direction,
    pct: c.pct,
    edge: c.edge,
    l10Avg: c.line.last10Avg,
    vsOppAvg: c.line.vsOpponent?.avg ?? null,
  };
}

export function buildCombos(lines: ResolvedLine[]): Combo[] {
  // Filter to lines with a clear directional lean (no coin-flips) and
  // a resolved projection. OUT players are excluded — we never want a
  // "best pick" parlay that includes someone who isn't playing.
  const candidates: Candidate[] = lines
    .filter((l) => l.injury?.status !== 'Out')
    .map((l) => {
      const p = l.projection;
      if (!p || p.noProjection) return null;
      const lean = p.edge.lean;
      if (lean === 'No Clear Edge') return null;
      const isOver = lean.includes('Over');
      // Skip lines where the model's lean conflicts with the available
      // bettable side. Demon (over-only) + UNDER lean and Goblin
      // (under-only) + OVER lean are unbettable — don't snapshot picks
      // we couldn't have actually played.
      const dirRestriction = l.direction;
      if (dirRestriction === 'over' && !isOver) return null;
      if (dirRestriction === 'under' && isOver) return null;
      return {
        line: l,
        pct: isOver ? p.probability.over : p.probability.under,
        edge: p.edge.score,
        direction: (isOver ? 'OVER' : 'UNDER') as 'OVER' | 'UNDER',
      };
    })
    .filter((x): x is Candidate => x !== null);

  const combos: Combo[] = [];

  // Best 2-6: top N by hit % with same-player diversity.
  const sortedByPct = [...candidates].sort((a, b) => b.pct - a.pct);
  for (const n of [2, 3, 4, 5, 6] as const) {
    const legs = pickDiverse(sortedByPct, n);
    if (legs.length === n) {
      combos.push({
        label: `Best ${n}` as Combo['label'],
        tag: 'safe',
        legs: legs.map(toLeg),
        combinedPct: combinedPct(legs),
      });
    }
  }

  // Wild Card: a real longshot. Skip Goblins (lower payout), skip the
  // very-highest-probability picks (already covered by Best 6), require
  // edge ≥ 40, sort by edge × (105 - pct) so a 75%-confidence edge-70
  // pick beats a 92%-confidence edge-72 pick.
  const wildPool = candidates.filter((c) => {
    if (c.line.direction === 'under') return false;        // no Goblins
    if (c.pct >= 90) return false;                          // skip locks
    if (c.edge < 40) return false;                          // skip weak edges
    return true;
  });
  const sortedByLongshot = [...wildPool].sort((a, b) => {
    const score = (c: Candidate) => c.edge * (105 - c.pct);
    const aScore = score(a);
    const bScore = score(b);
    if (aScore !== bScore) return bScore - aScore;
    // Tiebreak: Demons first (higher payout).
    const aDemon = a.line.direction === 'over' ? 1 : 0;
    const bDemon = b.line.direction === 'over' ? 1 : 0;
    return bDemon - aDemon;
  });
  const wildLegs = pickDiverseByStat(sortedByLongshot, 6);
  if (wildLegs.length >= 4) {
    combos.push({
      label: 'Wild Card',
      tag: 'wild',
      legs: wildLegs.map(toLeg),
      combinedPct: combinedPct(wildLegs),
    });
  }

  return combos;
}
