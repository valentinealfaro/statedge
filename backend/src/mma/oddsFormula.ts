// MMA odds formula — Phase 130.
//
// Bookmaker prices include juice (the vig); the implied probability
// from a posted American line is biased upward because the two-way
// market sums to >100%. De-vigging removes the bookmaker's edge to
// expose the FAIR probability — what the book actually thinks the
// outcome is, before they tilt the line in their favor.
//
// For two-way markets (most MMA moneylines):
//   fair_A = implied_A / (implied_A + implied_B)
//   fair_B = implied_B / (implied_A + implied_B)
//
// This is the proportional method (a.k.a. multiplicative). It's the
// canonical first-pass de-vig for symmetric markets and matches what
// sharp aggregators publish. More sophisticated methods (Shin, Power,
// Logarithmic) add edge cases for heavy favorites; for now we ship
// proportional and document its limits.
//
// Pure functions — no I/O, no state. Trivially testable and reusable
// across moneylines, totals, method-of-victory, rounds.

export type DevigResult = {
  fairProbA: number;
  fairProbB: number;
  vigPct: number;       // (impliedA + impliedB - 100) — the book's hold percentage
  bookHoldImplied: number;  // raw sum of implied probs (e.g., 1.045 = 4.5% hold)
};

export function deVigPair(impliedA: number, impliedB: number): DevigResult {
  // Inputs are 0–1 implied probabilities (e.g., 0.55 for 55%). If
  // callers pass 0–100 percentages we coerce defensively rather
  // than emit nonsense.
  const a = impliedA > 1 ? impliedA / 100 : impliedA;
  const b = impliedB > 1 ? impliedB / 100 : impliedB;
  const sum = a + b;
  if (sum <= 0) {
    return { fairProbA: 0, fairProbB: 0, vigPct: 0, bookHoldImplied: 0 };
  }
  return {
    fairProbA: a / sum,
    fairProbB: b / sum,
    vigPct: Math.round((sum - 1) * 1000) / 10,        // pp difference, rounded to 0.1
    bookHoldImplied: sum,
  };
}

// American → implied (0-1). Same math as in providers, but kept
// here so consumers don't have to import from a provider module.
export function americanToImplied(americanOdds: number): number {
  if (americanOdds === 0) return 0;
  return americanOdds > 0
    ? 100 / (americanOdds + 100)
    : Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
}

// Implied → American (round to nearest int). Useful when emitting
// "fair line" alongside the book's posted line.
export function impliedToAmerican(implied: number): number {
  // Coerce 0-100 percentages defensively.
  const p = implied > 1 ? implied / 100 : implied;
  if (p <= 0 || p >= 1) return 0;
  return p >= 0.5
    ? -Math.round((p / (1 - p)) * 100)
    : Math.round(((1 - p) / p) * 100);
}

// EV at a given posted line, assuming the model probability `modelProb`
// is correct. Standard sports-betting EV formula, normalized to
// "expected return per unit staked" (so 0 = breakeven, +0.10 = 10%
// edge per dollar, -0.05 = -5%).
export function expectedValuePerUnit(modelProb: number, americanOdds: number): number {
  const p = modelProb > 1 ? modelProb / 100 : modelProb;
  const decimal = americanOdds > 0 ? 1 + americanOdds / 100 : 1 + 100 / Math.abs(americanOdds);
  // Net-payout EV: p × (decimal − 1) − (1 − p) × 1
  return p * (decimal - 1) - (1 - p);
}

// Kelly fraction — the optimal bankroll % to stake on a +EV bet.
// b = decimal odds − 1; p = our edge prob; q = 1 − p.
// Returns 0 when EV ≤ 0 (don't bet a negative-EV proposition under
// any sizing rule). Apply a fractional-Kelly multiplier (e.g., 0.25)
// at the call site for risk control — this returns FULL Kelly.
export function kellyFraction(modelProb: number, americanOdds: number): number {
  const p = modelProb > 1 ? modelProb / 100 : modelProb;
  const b = americanOdds > 0 ? americanOdds / 100 : 100 / Math.abs(americanOdds);
  if (b <= 0 || p <= 0 || p >= 1) return 0;
  const f = (b * p - (1 - p)) / b;
  return Math.max(0, f);
}
