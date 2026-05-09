// UFC projection engine — Phase 136 foundation.
//
// First-cut UFC projections derived from the moneyline market we
// already pull from The Odds API plus simple style heuristics. NOT
// a full quantitative engine — fighter career stats need their own
// ingestion pipeline (UFCStats / ESPN MMA athlete endpoint), which
// is a substantial multi-phase build.
//
// The output shape mirrors what the Elite cross-sport builder
// expects so UFC legs can join the cross-sport ticket via the same
// EliteCandidate normalization path.
//
// Strategy
// --------
// Without a fighter-stat database, every projection here is anchored
// to (a) the de-vigged moneyline (the closest thing to a "true win
// probability" we have access to), and (b) the line itself (the
// market's best estimate of the median outcome). We project around
// the line by ±10% and assign a 60-70% probability based on whether
// our heuristics agree with the line's direction.
//
// This is honest about its limits: the projections are conservative
// market-anchored estimates, not deep-water fundamental projections.
// When a fighter-stat database lands, projectUfcProp gets replaced
// from the inside without changing its public contract.

export type UfcProjectionInput = {
  fighterName: string;
  opponentName: string;
  // De-vigged win probability for the fighter, 0-1 (from oddsFormula.deVigPair)
  fairProbability: number | null;
  // PrizePicks line + the sides the line is bookable on
  statKey:
    | 'sig_strikes' | 'rd1_sig_strikes'
    | 'takedowns' | 'rd1_takedowns'
    | 'knockdowns'
    | 'rounds' | 'fight_time'
    | 'fantasy_score' | 'control_time';
  line: number;
  direction: 'over' | 'under' | 'both';
};

export type UfcProjectionResult = {
  projectionValue: number;          // our central estimate
  probability: number;              // 0-100 — direction-aware
  modelDirection: 'OVER' | 'UNDER';
  edgePercent: number;              // 0-100 — abs(probability - 50)
  trapScore: number;                // 0-100 — higher = trappier
  fragilityScore: number;           // 0-100 — higher = more fragile
  // Free-text rationale for transparency
  reasonCodes: string[];
};

// Stat-specific market biases. Each returns:
//   bias: how much our central estimate differs from the line
//        (positive = we project HIGHER than line)
//   confidence: 0-100 baseline probability for our directional read
//
// These are heuristic anchors. When the fighter-stat database lands,
// each function gets replaced by a real per-fighter computation.
function statHeuristic(input: UfcProjectionInput): { bias: number; confidence: number; reasonCodes: string[] } {
  const { statKey, fairProbability } = input;
  const reasons: string[] = [];

  switch (statKey) {
    case 'sig_strikes': {
      // Underdogs (fair < 0.4) tend to throw MORE — they're chasing a
      // KO or stealing rounds. Favorites can coast.
      if (fairProbability !== null && fairProbability < 0.4) {
        reasons.push('Underdog volume — chasing finishes / round-stealing.');
        return { bias: +3, confidence: 58, reasonCodes: reasons };
      }
      if (fairProbability !== null && fairProbability > 0.7) {
        reasons.push('Heavy favorite — may finish early, capping volume.');
        return { bias: -2, confidence: 56, reasonCodes: reasons };
      }
      reasons.push('Even matchup — line typically priced near median output.');
      return { bias: 0, confidence: 53, reasonCodes: reasons };
    }
    case 'rd1_sig_strikes': {
      // R1 sig strikes are highly volatile (any KO/TKO truncates).
      // We can't beat the market here without fighter-stat data.
      reasons.push('Round-1 volatility is high; no edge without per-fighter pace data.');
      return { bias: 0, confidence: 51, reasonCodes: reasons };
    }
    case 'takedowns':
    case 'rd1_takedowns': {
      // No edge without per-fighter wrestling data; don't claim one.
      reasons.push('Takedowns require per-fighter style data — no model edge yet.');
      return { bias: 0, confidence: 50, reasonCodes: reasons };
    }
    case 'knockdowns': {
      reasons.push('Knockdowns are tail events; no edge without per-fighter KO rate.');
      return { bias: 0, confidence: 50, reasonCodes: reasons };
    }
    case 'rounds':
    case 'fight_time': {
      // Heavy favorites finish faster; even matchups go later.
      if (fairProbability !== null && fairProbability > 0.72) {
        reasons.push('Heavy favorite often finishes inside distance.');
        return { bias: -0.5, confidence: 60, reasonCodes: reasons };
      }
      if (fairProbability !== null && Math.abs(fairProbability - 0.5) < 0.08) {
        reasons.push('Even matchup tends to go the distance.');
        return { bias: +0.3, confidence: 58, reasonCodes: reasons };
      }
      return { bias: 0, confidence: 51, reasonCodes: reasons };
    }
    case 'fantasy_score': {
      // Fantasy score is ~ activity. Favorites and underdogs both
      // often hit if the fight goes 15 minutes.
      if (fairProbability !== null && Math.abs(fairProbability - 0.5) < 0.08) {
        reasons.push('Even matchup likely to go distance — fantasy ceiling raised.');
        return { bias: +2, confidence: 55, reasonCodes: reasons };
      }
      return { bias: 0, confidence: 51, reasonCodes: reasons };
    }
    case 'control_time': {
      reasons.push('Control time requires per-fighter grappling data — no model edge yet.');
      return { bias: 0, confidence: 50, reasonCodes: reasons };
    }
    default:
      return { bias: 0, confidence: 50, reasonCodes: ['No specific heuristic for this stat.'] };
  }
}

export function projectUfcProp(input: UfcProjectionInput): UfcProjectionResult {
  const { line } = input;
  const { bias, confidence, reasonCodes } = statHeuristic(input);
  const projectionValue = Math.max(0, Math.round((line + bias) * 100) / 100);
  // Direction-aware probability: confidence reads as the chance our
  // directional read (over/under) is correct. If projection > line
  // we lean OVER; if projection < line we lean UNDER; equal → coin flip.
  const modelDirection: 'OVER' | 'UNDER' =
    projectionValue > line ? 'OVER'
    : projectionValue < line ? 'UNDER'
    : 'OVER';
  // If the line allows only one side (Demon = over-only, Goblin = under-only),
  // and our model leans the other way, force probability ≤ 50 since
  // we'd be taking the side our model disagrees with.
  let probability = confidence;
  if (input.direction === 'over' && modelDirection === 'UNDER') probability = 100 - confidence;
  if (input.direction === 'under' && modelDirection === 'OVER') probability = 100 - confidence;

  const edgePercent = Math.max(0, probability - 50);
  // Trap signals: stat keys we explicitly said we have no edge on
  // get a higher trapScore so the Elite filter rejects them.
  const noEdgeStats = new Set(['rd1_sig_strikes', 'takedowns', 'rd1_takedowns', 'knockdowns', 'control_time']);
  const trapScore = noEdgeStats.has(input.statKey) ? 60 : 30;
  // Fragility: round / fight-time props are fragile (any early
  // finish blows them up). Sig strikes are also fragile in early-
  // finish scenarios but less so on the over side.
  const fragilityScore =
    input.statKey === 'rounds' || input.statKey === 'fight_time' ? 55
    : input.statKey === 'rd1_sig_strikes' || input.statKey === 'rd1_takedowns' ? 50
    : 40;

  return {
    projectionValue,
    probability,
    modelDirection,
    edgePercent,
    trapScore,
    fragilityScore,
    reasonCodes,
  };
}
