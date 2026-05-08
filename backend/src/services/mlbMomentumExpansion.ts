// Layer 2 — Opportunity & Usage Intelligence: momentumExpansionScore.
//
// Per the StatEdge MLB Intelligence Engine spec, the model needs a
// first-class composite signal for "hidden usage growth + recent
// production lift + projection separation." This is the number that
// powers Wild Card / Aggressive ranking per the 2026-05-08 philosophy
// shift ("Wild Card = controlled market-inefficiency portfolio").
//
// Direction-aware: for OVER picks, momentum-up is positive; for UNDER
// picks, momentum-down is positive (player cooling off → UNDER edge).
//
// Output: 0..100, where 50 = neutral, ≥65 = real momentum, ≤35 =
// anti-momentum (which for OVER means trap risk, for UNDER means a
// fading edge).

export type MomentumExpansionInputs = {
  direction: 'OVER' | 'UNDER';
  // Recent production. last10Average is always present from the L10
  // engine; last5Average is null when fewer than 5 logged games.
  last10Average: number;
  last5Average: number | null;
  // Long-term anchor. null when seasonGames < 1 (rare — empty player).
  seasonAverage: number | null;
  seasonGames: number;
  // 0..100, projection separation from line in standard deviations
  // (already direction-baked-in by the projection engine).
  projectionDistanceScore: number;
  // 0..100, L10 hit rate at the queried line in chosen direction.
  // null when no line was queried.
  last10HitRate: number | null;
};

// Component weights. Sum to 1.0 when all components are present.
// When a component is missing (null inputs), we drop it and
// renormalize the rest — same pattern the projection engine uses.
const W = {
  productionLift: 0.40,    // L5 vs L10 — strongest "right now" signal
  seasonLift:     0.25,    // L10 vs season — confirms it's not just one hot week
  separation:     0.25,    // projection distance — does the model itself buy in?
  volumeLift:     0.10,    // L10 hit rate — actual cover frequency at this line
} as const;

// How aggressively a ratio above/below 1.0 expands toward the bounds.
// At 50% lift (ratio 1.5 OVER, ratio 0.5 UNDER), the component hits
// 100. At 50% deficit, it floors at 0. Linear in between.
const LIFT_GAIN = 100;

// Convert a ratio (recent / baseline) to a 0..100 component, direction-aware.
// OVER: ratio > 1.0 is good; UNDER: ratio < 1.0 is good.
function liftToComponent(
  ratio: number,
  direction: 'OVER' | 'UNDER',
): number {
  // Symmetrize around 1.0 → 50.
  const delta = direction === 'OVER' ? ratio - 1.0 : 1.0 - ratio;
  const raw = 50 + delta * LIFT_GAIN;
  return Math.max(0, Math.min(100, raw));
}

// Direction-aware version of last10HitRate. OVER uses the rate as-is;
// UNDER inverts (low cover rate at line means UNDER side has been
// hitting frequently).
function volumeLiftComponent(
  hitRate: number,
  direction: 'OVER' | 'UNDER',
): number {
  return direction === 'OVER' ? hitRate : 100 - hitRate;
}

export function computeMomentumExpansionScore(
  inputs: MomentumExpansionInputs,
): number {
  // Build component values, dropping any that aren't computable.
  const components: Array<{ value: number; weight: number }> = [];

  // (1) Production lift: L5 vs L10. Requires both present, L10 > 0.
  if (
    inputs.last5Average !== null
    && inputs.last10Average > 0
  ) {
    const ratio = inputs.last5Average / inputs.last10Average;
    components.push({
      value: liftToComponent(ratio, inputs.direction),
      weight: W.productionLift,
    });
  }

  // (2) Season lift: L10 vs season. Requires meaningful season sample.
  // 10 games chosen as the floor to avoid letting a 3-game cup-of-coffee
  // baseline drive the composite.
  if (
    inputs.seasonAverage !== null
    && inputs.seasonAverage > 0
    && inputs.seasonGames >= 10
    && inputs.last10Average > 0
  ) {
    const ratio = inputs.last10Average / inputs.seasonAverage;
    components.push({
      value: liftToComponent(ratio, inputs.direction),
      weight: W.seasonLift,
    });
  }

  // (3) Projection separation: already 0..100 with direction baked in
  // by the projection engine. Always present (defaults to 0 on no-data).
  components.push({
    value: inputs.projectionDistanceScore,
    weight: W.separation,
  });

  // (4) Volume lift: L10 hit rate at line. Optional — null when no line.
  if (inputs.last10HitRate !== null) {
    components.push({
      value: volumeLiftComponent(inputs.last10HitRate, inputs.direction),
      weight: W.volumeLift,
    });
  }

  // Renormalize and blend.
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) return 50;
  const blended =
    components.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight;
  return Math.round(blended * 10) / 10;
}

// Convenience label for UI surfacing. Bands chosen so "Strong" is rare
// enough to mean something — only ~top-quartile of legs.
export function momentumExpansionLabel(score: number): string {
  if (score >= 75) return 'Strong Expansion';
  if (score >= 60) return 'Expanding';
  if (score >= 40) return 'Neutral';
  if (score >= 25) return 'Cooling';
  return 'Fading Hard';
}
