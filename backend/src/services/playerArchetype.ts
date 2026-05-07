// Player volatility classification — turns the raw season game log
// into a one-tag archetype the user can read at a glance ("Boom/Bust",
// "Stable Producer") and the projection layer can lean on for risk.
//
// Per the StatEdge Quantitative Intelligence spec: every player should
// carry a volatility profile so the user knows whether tonight's
// projection is sitting on a steady producer or a coin-flip
// archetype where one bad matchup blows up the line. The classifier
// is rule-based on top of the existing game-log data; no ML, no
// external data, no extra DB roundtrips.

import type { PlayerGame } from '../nba/client.js';
import { isDoubleDoubleGame, STAT_MAP, type Last10StatId } from './last10.js';

export type PlayerArchetype =
  | 'Stable Producer'
  | 'Moderately Volatile'
  | 'High Variance'
  | 'Boom/Bust'
  | 'Minutes Sensitive'
  | 'Insufficient Data';

export type ArchetypeReport = {
  archetype: PlayerArchetype;
  // Coefficient of variation on the selected stat (stddev / mean) over
  // the player's recent sample window. Higher = more variable.
  statCV: number;
  // Coefficient of variation on minutes — surfaces "minutes sensitive"
  // archetypes whose stat output is fine but who get yanked into and
  // out of the lineup unpredictably.
  minutesCV: number;
  // Boom rate / bust rate: fraction of games ≥1.5σ above / below the
  // mean. A player with both high boom AND high bust = Boom/Bust.
  boomRate: number;
  bustRate: number;
  sampleSize: number;
  // Short human-readable explanation surfaced in the UI tooltip.
  reason: string;
};

const MIN_SAMPLE = 8;          // need at least 8 games for the CV math to mean anything
const SAMPLE_WINDOW = 20;      // look at the most-recent 20 games

// Compute mean / stddev / boom-bust rates for a stat array.
function statsForValues(values: number[]): {
  mean: number;
  std: number;
  cv: number;
  boomRate: number;
  bustRate: number;
} {
  if (values.length === 0) return { mean: 0, std: 0, cv: 0, boomRate: 0, bustRate: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  const cv = mean === 0 ? 0 : std / Math.abs(mean);
  // "Boom" / "bust" thresholds at ±1.5σ from the mean — the same cut
  // used in robust-stats outlier detection. A 1-in-7 frequency at
  // either tail is the classifier signal.
  const boomCount = values.filter((v) => v >= mean + 1.5 * std).length;
  const bustCount = values.filter((v) => v <= mean - 1.5 * std).length;
  return {
    mean,
    std,
    cv,
    boomRate: boomCount / values.length,
    bustRate: bustCount / values.length,
  };
}

export function classifyArchetype(
  games: PlayerGame[],
  selectedStat: Last10StatId,
): ArchetypeReport {
  const recent = games.slice(0, SAMPLE_WINDOW);
  if (recent.length < MIN_SAMPLE) {
    return {
      archetype: 'Insufficient Data',
      statCV: 0,
      minutesCV: 0,
      boomRate: 0,
      bustRate: 0,
      sampleSize: recent.length,
      reason: `Only ${recent.length} game${recent.length === 1 ? '' : 's'} on file — need at least ${MIN_SAMPLE} for a profile.`,
    };
  }

  // For DD, "values" is binary (0/1). CV/boom/bust math doesn't really
  // apply — the archetype is "boom/bust by definition". Skip the stat
  // pass and just lean on minutes stability.
  const isDD = selectedStat === 'double_double';
  const statValues = isDD
    ? recent.map((g) => (isDoubleDoubleGame(g) ? 1 : 0))
    : recent.map(STAT_MAP[selectedStat]);
  const minutesValues = recent.map((g) => g.minutes ?? 0);

  const statS = statsForValues(statValues);
  const minutesS = statsForValues(minutesValues);

  // Classification rules. Order matters — first match wins.
  let archetype: PlayerArchetype;
  let reason: string;

  if (isDD) {
    // DD is binary; just call out the rate.
    archetype = 'Moderately Volatile';
    reason = `Double-double rate is ${Math.round(statS.mean * 100)}% over the last ${recent.length} games.`;
  } else if (minutesS.cv >= 0.20 && statS.cv < 0.35) {
    // Stat is fine but minutes swing hard — DNPs and 4-min foul-outs
    // are doing the damage rather than skill volatility.
    archetype = 'Minutes Sensitive';
    reason = `Minutes swing widely (CV ${(minutesS.cv * 100).toFixed(0)}%) — output depends on whether the rotation lands.`;
  } else if (statS.boomRate >= 0.20 && statS.bustRate >= 0.20) {
    // ≥20% boom AND ≥20% bust = classic boom/bust archetype.
    archetype = 'Boom/Bust';
    reason = `${Math.round(statS.boomRate * 100)}% boom games, ${Math.round(statS.bustRate * 100)}% bust games — coin-flip distribution.`;
  } else if (statS.cv >= 0.45) {
    archetype = 'Boom/Bust';
    reason = `Stat CV ${(statS.cv * 100).toFixed(0)}% — extreme game-to-game swings.`;
  } else if (statS.cv >= 0.30) {
    archetype = 'High Variance';
    reason = `Stat CV ${(statS.cv * 100).toFixed(0)}% — production runs hot and cold.`;
  } else if (statS.cv >= 0.20) {
    archetype = 'Moderately Volatile';
    reason = `Stat CV ${(statS.cv * 100).toFixed(0)}% — typical NBA-level variance.`;
  } else {
    archetype = 'Stable Producer';
    reason = `Stat CV ${(statS.cv * 100).toFixed(0)}% — consistent output game over game.`;
  }

  return {
    archetype,
    statCV: round2(statS.cv),
    minutesCV: round2(minutesS.cv),
    boomRate: round2(statS.boomRate),
    bustRate: round2(statS.bustRate),
    sampleSize: recent.length,
    reason,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
