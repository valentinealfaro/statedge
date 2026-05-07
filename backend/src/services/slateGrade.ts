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

  // Snapshotted model state (echoed so UI shows what we predicted vs
  // what happened):
  pct: number;

  // Actual outcome:
  actual: number | null;     // null when we couldn't find a game
  outcome: LegOutcome;
};

export type GradedCombo = {
  label: Combo['label'];
  tag: Combo['tag'];
  legs: GradedLeg[];
  combinedPct: number;
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
      pct: leg.pct,
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
    pct: leg.pct,
    actual,
    outcome,
  };
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
    tag: combo.tag,
    legs,
    combinedPct: combo.combinedPct,
    status,
    hitCount,
    missCount,
    pendingCount,
  };
}
