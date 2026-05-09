// Loss Forensics Engine — Phase 102a.
//
// Per the Phase 102 spec: every miss must be classified WHY. Over time,
// archetype distributions become institutional knowledge — e.g., "steals
// props above 80% confidence fail disproportionately due to variance."
//
// This module classifies a graded miss using the signals we already
// captured at projection time (trap, fragility, momentum, line
// inflation, public bias tags) plus the actual outcome. Pure-function,
// sport-agnostic. Called at grading time and persisted on the history
// row.
//
// IMPORTANT: only runs on MISSES. Hits don't need a failure archetype.
// Pushes likewise excluded.
//
// Phase 102b extensions (queued for when we have richer data):
//   - injury / foul-trouble detection (needs in-game event feed)
//   - blowout / minutes-collapse (needs minutes-played at miss time)
//   - bullpen / weather variance (specific to MLB, needs game-state)

export type FailureArchetype =
  | 'PUBLIC_TRAP'              // line was flagged trap at projection time + missed
  | 'LINE_INFLATION'           // line walked too far above season — market overcorrected
  | 'STREAK_FADED'             // we rode L5 momentum + it didn't sustain
  | 'STAR_TAX_REVERSE'         // we faded a star + the star did star things
  | 'CONTRARIAN_CRUSHED'       // we took the unloved side + public was right
  | 'NARRATIVE_OVERLOAD'       // narrative-risk flag fired + miss confirms
  | 'FRAGILE_PROJECTION'       // high-fragility leg — outcome inside expected variance
  | 'MODEL_ERROR'              // low fragility + sizable miss — model misjudged
  | 'CLOSE_MISS'               // result within 1 unit of line — coin-flip variance
  | 'VARIANCE'                 // catch-all when no archetype dominates
  | 'UNKNOWN';                 // missing data — record but don't claim signal

export type FailureArchetypeInputs = {
  // What we projected at write time:
  probability: number;           // 0-100
  edgePercent: number;
  projection: number;
  line: number;
  direction: 'OVER' | 'UNDER';
  trapScore: number;             // 0-100
  fragilityScore: number;        // 0-100
  momentumScore: number | null;  // 0-100, null when not available
  lineInflationScore: number;    // 0-100
  publicBiasTags: string[];      // raw PublicBiasTag strings
  // What actually happened:
  resultValue: number;           // actual stat outcome
};

export function classifyFailure(i: FailureArchetypeInputs): FailureArchetype {
  // Bail early if we don't have enough signal (e.g. legacy rows with
  // no fragility/trap captured at write time).
  if (
    !Number.isFinite(i.probability) ||
    !Number.isFinite(i.line) ||
    !Number.isFinite(i.resultValue)
  ) {
    return 'UNKNOWN';
  }

  // CLOSE_MISS: result within 1 unit of line (or 5% of season-typical
  // for high-volume stats). Variance noise dominates.
  const missMargin = Math.abs(i.resultValue - i.line);
  if (missMargin <= 1) {
    return 'CLOSE_MISS';
  }

  // PUBLIC_TRAP: trap score was already elevated when we projected.
  // The leg was flagged AND it missed — public-trap pattern realized.
  if (i.trapScore >= 60) {
    return 'PUBLIC_TRAP';
  }

  // LINE_INFLATION: line walked above season + we took the over and
  // missed. Classic recency-bias trap.
  if (i.lineInflationScore >= 50 && i.direction === 'OVER') {
    return 'LINE_INFLATION';
  }

  // STREAK_FADED: rode L5 momentum on the OVER + missed. The streak
  // didn't sustain — characteristic regression to baseline.
  if (
    (i.momentumScore ?? 0) >= 65 &&
    i.direction === 'OVER' &&
    i.publicBiasTags.includes('NARRATIVE_RISK')
  ) {
    return 'STREAK_FADED';
  }

  // STAR_TAX_REVERSE: we faded a star (likely UNDER, with STAR_TAX
  // tag implying line walked high) + the star delivered.
  if (
    i.publicBiasTags.includes('STAR_TAX') &&
    i.direction === 'UNDER' &&
    i.resultValue > i.line
  ) {
    return 'STAR_TAX_REVERSE';
  }

  // CONTRARIAN_CRUSHED: we took the unloved side (CONTRARIAN_VALUE
  // tag fired) + the public was right.
  if (i.publicBiasTags.includes('CONTRARIAN_VALUE')) {
    return 'CONTRARIAN_CRUSHED';
  }

  // NARRATIVE_OVERLOAD: narrative tag fired + we sided with the
  // narrative + missed.
  if (i.publicBiasTags.includes('NARRATIVE_RISK')) {
    return 'NARRATIVE_OVERLOAD';
  }

  // MODEL_ERROR: low fragility + big delta between projection and
  // actual. This isn't variance — model mispredicted central tendency.
  // "Big delta" = absolute miss > 30% of projection magnitude.
  const projectionDelta = Math.abs(i.projection - i.resultValue);
  const projMagnitude = Math.max(1, Math.abs(i.projection));
  if (i.fragilityScore <= 35 && projectionDelta / projMagnitude >= 0.30) {
    return 'MODEL_ERROR';
  }

  // FRAGILE_PROJECTION: high fragility was already telegraphed —
  // the outcome was inside expected variance. The model anticipated
  // this could happen.
  if (i.fragilityScore >= 60) {
    return 'FRAGILE_PROJECTION';
  }

  // Catch-all when nothing dominates — variance noise.
  return 'VARIANCE';
}

// Aggregate distribution of failure archetypes — used by the
// calibration page to show "where are misses concentrating?"
export type FailureArchetypeBucket = {
  archetype: FailureArchetype;
  count: number;
  pct: number;                  // 0-100, share of total misses
};

export function summarizeArchetypes(
  archetypes: FailureArchetype[],
): FailureArchetypeBucket[] {
  if (archetypes.length === 0) return [];
  const counts = new Map<FailureArchetype, number>();
  for (const a of archetypes) counts.set(a, (counts.get(a) ?? 0) + 1);
  return [...counts.entries()]
    .map(([archetype, count]) => ({
      archetype,
      count,
      pct: Math.round((count / archetypes.length) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count);
}
