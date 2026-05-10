// De-vigging — convert sportsbook raw implied probabilities into the
// book's actual belief about the true probability of an outcome.
//
// Why this matters (per the institutional reading of how books price
// player props):
//
//   "Sportsbooks do not offer fair odds. They include a fee known as
//    the vig or juice. If the odds were fair, the implied probabilities
//    would total 100%. Instead, they might offer -110 on both sides,
//    which implies a probability of roughly 52.4% for each side,
//    totaling over 100%. The extra percentage is their profit margin."
//
// So when our model compares its predicted probability to a raw
// `implied_probability` value from market_snapshots, we are comparing
// against the book's *charged* number — not the book's *belief*. Edge
// math is biased: if we say 75% over and the book's raw implied for
// the over is 52.4% (the -110 case), the apparent edge is 22.6pp; the
// real edge against the book's belief (50%) is 25pp. In one-sided
// vig (-150/+125) the asymmetry is larger and one direction looks
// shorter than it really is.
//
// Two methods supported:
//
//   1. Multiplicative (standard "normalization" / "proportional
//      de-vig"): given both sides' raw implied probabilities, scale
//      so they sum to 100%. This is the canonical method and the one
//      most public CLV calculators use. It assumes the book's vig
//      tax is applied proportionally to each side, which is true for
//      symmetric markets (-110/-110 → 50/50) and approximately true
//      otherwise.
//
//      true_p_over = raw_p_over / (raw_p_over + raw_p_under)
//
//   2. Single-side fallback: when only one side is observed, subtract
//      half the typical vig from the raw implied. We default to a
//      4.5% total vig (≈2.25% per side), which lines up with the
//      observed average across FanDuel / DraftKings / BetMGM /
//      Caesars on -110/-110 player-prop markets.

export type DevigPairResult = {
  trueOver: number;          // 0..100
  trueUnder: number;         // 0..100, complement of trueOver
  rawOver: number;
  rawUnder: number;
  vigPct: number;            // (rawOver + rawUnder) - 100; the book's fee
  method: 'multiplicative';
};

// De-vig a paired over/under quote. Inputs are raw implied
// probabilities in 0..100 (e.g. 52.4 for -110, NOT 0.524).
//
// Returns the book's "true belief" for each side, normalized so
// trueOver + trueUnder = 100. Also returns the raw vig in pp so we
// can surface it on the audit pages and in modelNotes.
export function devigPair(
  rawOverPct: number,
  rawUnderPct: number,
): DevigPairResult {
  if (!Number.isFinite(rawOverPct) || !Number.isFinite(rawUnderPct)) {
    throw new Error('devigPair: inputs must be finite numbers');
  }
  if (rawOverPct <= 0 || rawUnderPct <= 0) {
    // Pathological: zero or negative implied probability has no
    // meaningful de-vig. Caller should fall back to single-side or
    // skip the de-vig entirely.
    throw new Error('devigPair: inputs must be positive');
  }
  const sum = rawOverPct + rawUnderPct;
  const trueOver = (rawOverPct / sum) * 100;
  const trueUnder = (rawUnderPct / sum) * 100;
  return {
    trueOver: round1(trueOver),
    trueUnder: round1(trueUnder),
    rawOver: rawOverPct,
    rawUnder: rawUnderPct,
    vigPct: round1(sum - 100),
    method: 'multiplicative',
  };
}

// Single-side fallback. When the snapshot for the other side is
// missing, the best we can do is approximate by subtracting half the
// typical total vig. Default is 4.5% total vig → 2.25% per side; this
// matches the observed mean across FanDuel/DraftKings/BetMGM/Caesars
// for typical player-prop markets at standard pricing. Caller can
// override `assumedTotalVigPct` if surveying a different book mix.
//
// Honest about the limitation: a one-sided +250 underdog quote can
// have asymmetric vig where this approximation is wrong by a couple
// percentage points. devigPair() is always preferred when both sides
// are available.
export function devigSingleSide(
  rawSidePct: number,
  assumedTotalVigPct = 4.5,
): number {
  if (!Number.isFinite(rawSidePct) || rawSidePct <= 0) {
    throw new Error('devigSingleSide: rawSidePct must be a positive number');
  }
  const halfVig = assumedTotalVigPct / 2;
  const trueP = rawSidePct - halfVig;
  // Clamp into a sane band so a freaky stored value can't break edge
  // math. The 1..99 ceiling matches the existing fetch-side clamp.
  return Math.max(1, Math.min(99, round1(trueP)));
}

// Convenience: pull the requested side off a paired de-vig result.
export function trueProbForSide(
  result: DevigPairResult,
  side: 'OVER' | 'UNDER',
): number {
  return side === 'OVER' ? result.trueOver : result.trueUnder;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
