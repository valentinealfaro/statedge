// Grade a snapshotted combo against the player's actual stats from
// player_game_logs. We look up each leg by (playerId, slate_date) —
// PlayerGame.date is "YYYY-MM-DD" matching the slate's ET date — and
// compute hit/miss/push using the same STAT_MAP / isDoubleDoubleGame
// helpers the slate uses for projections.
//
// A leg "pushes" if the actual stat exactly equals the line. Standard
// PrizePicks behavior is to refund a push and the parlay continues at
// reduced legs, but for our scoreboard we treat any non-loss as
// surviving — so a parlay only loses if any leg outright misses.
//
// The grader is shape-tolerant: ComboLeg gained extra fields in the
// new combo builder rewrite (probability/confidence/risk/edge replacing
// a single `pct`). Older snapshots in slate_results.combos JSONB
// still have the old shape, so we read both new and legacy field
// names and degrade gracefully when something is missing.

import type { PlayerGame } from '../nba/client.js';
import { isDoubleDoubleGame, STAT_MAP, type Last10StatId } from './last10.js';
import type { Combo, ComboLeg } from './slateCombos.js';

export type LegOutcome = 'hit' | 'miss' | 'push' | 'no_game' | 'unknown_stat';

export type GradedLeg = {
  // Echo of the snapshotted leg so the UI can render history without
  // a second join:
  playerId: number;
  playerName: string;
  team: string | null;
  opponentAbbr: string | null;
  statKey: Last10StatId;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';

  // Snapshotted model state echoed onto the graded shape so the UI
  // can show "what we predicted vs what happened" without a second
  // join. probability is the per-leg hit % at lock time.
  probability: number;
  confidence?: number;
  confidenceLabel?: string;

  // Actual outcome:
  actual: number | null;     // null when we couldn't find a game
  outcome: LegOutcome;
};

export type GradedCombo = {
  label: Combo['label'];
  subtitle?: string;
  tag: Combo['tag'];
  legs: GradedLeg[];
  // Predicted hit % at lock time. Mirrors Combo's adjusted hit; kept
  // as a single number on the graded shape so the History UI doesn't
  // need to know about correlation tiers post-hoc.
  predictedHit: number;
  // Aggregate parlay status:
  //   'won'     all legs hit (pushes count as survival, mirrors PP)
  //   'lost'    at least one leg missed
  //   'pending' at least one leg has no game data yet (and none missed)
  status: 'won' | 'lost' | 'pending';
  hitCount: number;
  missCount: number;
  pendingCount: number;
};

function valueFor(g: PlayerGame, stat: Last10StatId): number {
  if (stat === 'double_double') return isDoubleDoubleGame(g) ? 1 : 0;
  const get = STAT_MAP[stat];
  return get(g);
}

// Old snapshots stored `pct` instead of `probability`. Read either,
// fall back to 0 so the UI still renders something sensible.
function legProbability(leg: ComboLeg | (ComboLeg & { pct?: number })): number {
  const lp = leg as { probability?: number; pct?: number };
  return lp.probability ?? lp.pct ?? 0;
}

function legConfidence(leg: ComboLeg): number | undefined {
  const lp = leg as { confidence?: number };
  return typeof lp.confidence === 'number' ? lp.confidence : undefined;
}

function legConfidenceLabel(leg: ComboLeg): string | undefined {
  const lp = leg as { confidenceLabel?: string };
  return typeof lp.confidenceLabel === 'string' ? lp.confidenceLabel : undefined;
}

export function gradeLeg(
  leg: ComboLeg,
  gamesByDate: PlayerGame[],
  slateDate: string,
): GradedLeg {
  // PlayerGame.date is "YYYY-MM-DD" matching slate_date (both are ET-
  // calendar dates). Take the most recent game on or before slateDate
  // ONLY if it lands on slateDate exactly — earlier dates mean the
  // player didn't play tonight (game logs are appended after each game).
  const game = gamesByDate.find((g) => g.date === slateDate);
  const probability = legProbability(leg);
  const confidence = legConfidence(leg);
  const confidenceLabel = legConfidenceLabel(leg);

  if (!game) {
    return {
      playerId: leg.playerId,
      playerName: leg.playerName,
      team: leg.team,
      opponentAbbr: leg.opponentAbbr,
      statKey: leg.statKey,
      statLabel: leg.statLabel,
      line: leg.line,
      direction: leg.direction,
      probability,
      confidence,
      confidenceLabel,
      actual: null,
      outcome: 'no_game',
    };
  }

  const actual = valueFor(game, leg.statKey);
  let outcome: LegOutcome;
  if (leg.statKey === 'double_double') {
    // For DD, the "line" doesn't really exist (the stat is binary).
    // We treat OVER as "must have a DD" and UNDER as "must NOT have one".
    const hit = leg.direction === 'OVER' ? actual === 1 : actual === 0;
    outcome = hit ? 'hit' : 'miss';
  } else if (actual === leg.line) {
    outcome = 'push';
  } else if (leg.direction === 'OVER') {
    outcome = actual > leg.line ? 'hit' : 'miss';
  } else {
    outcome = actual < leg.line ? 'hit' : 'miss';
  }

  return {
    playerId: leg.playerId,
    playerName: leg.playerName,
    team: leg.team,
    opponentAbbr: leg.opponentAbbr,
    statKey: leg.statKey,
    statLabel: leg.statLabel,
    line: leg.line,
    direction: leg.direction,
    probability,
    confidence,
    confidenceLabel,
    actual,
    outcome,
  };
}

// Read the predicted-hit % off a Combo, tolerating both new and
// legacy shapes. New: adjustedCombinedHit (or rawCombinedHit fallback).
// Legacy: combinedPct.
function comboPredictedHit(combo: Combo): number {
  const c = combo as {
    adjustedCombinedHit?: number;
    rawCombinedHit?: number;
    combinedPct?: number;
  };
  return c.adjustedCombinedHit ?? c.rawCombinedHit ?? c.combinedPct ?? 0;
}

export function gradeCombo(
  combo: Combo,
  gamesByPlayer: Map<number, PlayerGame[]>,
  slateDate: string,
): GradedCombo {
  const legs = combo.legs.map((leg) =>
    gradeLeg(leg, gamesByPlayer.get(leg.playerId) ?? [], slateDate),
  );
  let hitCount = 0;
  let missCount = 0;
  let pendingCount = 0;
  for (const l of legs) {
    if (l.outcome === 'hit' || l.outcome === 'push') hitCount++;
    else if (l.outcome === 'miss') missCount++;
    else pendingCount++;
  }
  const status: GradedCombo['status'] =
    missCount > 0 ? 'lost' : pendingCount > 0 ? 'pending' : 'won';
  return {
    label: combo.label,
    subtitle: combo.subtitle,
    tag: combo.tag,
    legs,
    predictedHit: comboPredictedHit(combo),
    status,
    hitCount,
    missCount,
    pendingCount,
  };
}
