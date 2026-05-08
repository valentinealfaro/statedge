// Layer 10 — Confidence Intelligence System.
//
// Per the StatEdge MLB Intelligence Engine spec:
//
//   "Confidence is NOT hit probability. Confidence measures:
//    model agreement, sample stability, projection reliability,
//    context clarity, data completeness, variance resistance."
//
// The legacy engine collapsed this into "sample size + signal
// agreement." The spec calls for six orthogonal components so users
// can see WHY confidence is low even when probability is high.
//
// Pure module — no DB, no MLB API. Inputs come from data the engine
// already has when it computes a projection.

// ----- Component weights (sum to 1.0) -----
const W = {
  sampleQuality:        0.20,   // L10 size + season-vs-stabilization
  projectionAgreement:  0.20,   // L10 / L5 / season / opponent agreement
  matchupClarity:       0.15,   // opponent sample size + handedness known
  opportunityCertainty: 0.20,   // lineup confirmed + game context loaded
  calibrationStrength:  0.15,   // historical bucket accuracy (data-gated)
  dataCompleteness:     0.10,   // count of context layers populated
} as const;

export type ConfidenceInputs = {
  // L10 + season sample.
  last10Size: number;                  // 0..10
  seasonGames: number;                 // total season games logged
  stabilizationGames: number;          // stat-specific threshold from L1

  // Projection agreement — pairwise distance between baselines.
  // Each entry is the absolute % deviation of that source from L10
  // (L10 is the anchor). null when the source isn't populated.
  agreementSpread: {
    seasonVsLast10: number | null;     // 0..1+ (relative)
    opponentVsLast10: number | null;
    last5VsLast10: number | null;
  };

  // Matchup clarity.
  opponentGames: number;               // 0+ — more = clearer matchup
  handednessKnown: boolean;            // batter's bats / pitcher's throws

  // Opportunity certainty (hitter-specific signals; pitcher-aware).
  playerType: 'hitter' | 'pitcher';
  lineupConfirmed: boolean | null;     // null for pitchers
  gameContextLoaded: boolean;          // gamePk threaded → venue/weather/lineup

  // Calibration strength — historical hit-rate accuracy by bucket.
  // null when we don't have enough history to bucket meaningfully.
  // 0..100 where 100 = perfectly calibrated, 50 = neutral.
  calibrationScore: number | null;

  // Data completeness — how many context layers fired non-neutral.
  contextLayers: {
    park: boolean;
    weather: boolean;
    lineup: boolean;
    bvp: boolean;
    gameScript: boolean;
  };
};

export type ConfidenceTier =
  | 'Weak'
  | 'Medium'
  | 'Strong'
  | 'Elite'
  | 'Institutional';

export type ConfidenceResult = {
  confidence: number;                  // 0..100
  tier: ConfidenceTier;
  components: {
    sampleQuality: number;
    projectionAgreement: number;
    matchupClarity: number;
    opportunityCertainty: number;
    calibrationStrength: number;
    dataCompleteness: number;
  };
};

// ----- Component scoring (each returns 0..100) -----

// Sample quality: half from L10 fill (10 games = full), half from
// season-vs-stabilization. A player with 10 logged L10 games AND
// crossing the stabilization threshold scores 100.
function sampleQualityComponent(
  last10Size: number,
  seasonGames: number,
  threshold: number,
): number {
  const l10Fill = Math.min(100, last10Size * 10);
  const seasonFill = Math.min(100, (seasonGames / threshold) * 100);
  return Math.round((l10Fill + seasonFill) / 2);
}

// Projection agreement: penalize spread between L10 / L5 / season /
// opponent. Each populated source contributes a penalty proportional
// to its deviation from L10. Lower spread → higher score.
function projectionAgreementComponent(
  spreads: ConfidenceInputs['agreementSpread'],
): number {
  const present: number[] = [];
  if (spreads.seasonVsLast10  !== null) present.push(spreads.seasonVsLast10);
  if (spreads.opponentVsLast10 !== null) present.push(spreads.opponentVsLast10);
  if (spreads.last5VsLast10    !== null) present.push(spreads.last5VsLast10);
  if (present.length === 0) return 50;       // no agreement signal at all
  const avgSpread = present.reduce((s, x) => s + x, 0) / present.length;
  // 0% spread → 100; 50% spread → 0. Anything above 50% deviation
  // floors at 0 (severe disagreement).
  return Math.max(0, Math.min(100, 100 * (1 - Math.min(1, avgSpread / 0.5))));
}

// Matchup clarity: scales with opponent sample. 0 games vs opp = 30
// (handedness still gives some signal), 5+ games = 100. Halved when
// handedness unknown.
function matchupClarityComponent(
  opponentGames: number,
  handednessKnown: boolean,
): number {
  let raw: number;
  if (opponentGames === 0)      raw = 30;
  else if (opponentGames === 1) raw = 50;
  else if (opponentGames === 2) raw = 70;
  else if (opponentGames === 3) raw = 85;
  else                           raw = 100;
  return handednessKnown ? raw : Math.round(raw * 0.7);
}

// Opportunity certainty: lineup confirmed + game context loaded for
// hitters; for pitchers, just game context (probable starter).
function opportunityCertaintyComponent(
  playerType: 'hitter' | 'pitcher',
  lineupConfirmed: boolean | null,
  gameContextLoaded: boolean,
): number {
  if (playerType === 'pitcher') {
    return gameContextLoaded ? 90 : 50;
  }
  if (lineupConfirmed === true && gameContextLoaded) return 95;
  if (lineupConfirmed === true) return 75;
  if (gameContextLoaded) return 50;
  return 30;
}

// Calibration strength: passes through when present, neutral 50 when
// not enough history. Once we accumulate ≥ 200 graded predictions,
// the calibration engine populates this.
function calibrationStrengthComponent(score: number | null): number {
  return score === null ? 50 : Math.max(0, Math.min(100, score));
}

// Data completeness: count of context layers that fired with real
// data (not the scaffolding 1.0 default).
function dataCompletenessComponent(
  layers: ConfidenceInputs['contextLayers'],
): number {
  const total = 5;     // park + weather + lineup + bvp + gameScript
  let fired = 0;
  if (layers.park)       fired += 1;
  if (layers.weather)    fired += 1;
  if (layers.lineup)     fired += 1;
  if (layers.bvp)        fired += 1;
  if (layers.gameScript) fired += 1;
  return Math.round((fired / total) * 100);
}

// ----- Tier mapping -----

export function confidenceTier(score: number): ConfidenceTier {
  if (score < 40) return 'Weak';
  if (score < 60) return 'Medium';
  if (score < 75) return 'Strong';
  if (score < 90) return 'Elite';
  return 'Institutional';     // spec: should be extremely rare
}

// ----- Public entry -----

export function computeConfidence(inputs: ConfidenceInputs): ConfidenceResult {
  const sampleQuality        = sampleQualityComponent(
    inputs.last10Size, inputs.seasonGames, inputs.stabilizationGames,
  );
  const projectionAgreement  = projectionAgreementComponent(inputs.agreementSpread);
  const matchupClarity       = matchupClarityComponent(
    inputs.opponentGames, inputs.handednessKnown,
  );
  const opportunityCertainty = opportunityCertaintyComponent(
    inputs.playerType, inputs.lineupConfirmed, inputs.gameContextLoaded,
  );
  const calibrationStrength  = calibrationStrengthComponent(inputs.calibrationScore);
  const dataCompleteness     = dataCompletenessComponent(inputs.contextLayers);

  const confidence =
    sampleQuality * W.sampleQuality
    + projectionAgreement * W.projectionAgreement
    + matchupClarity * W.matchupClarity
    + opportunityCertainty * W.opportunityCertainty
    + calibrationStrength * W.calibrationStrength
    + dataCompleteness * W.dataCompleteness;

  return {
    confidence: Math.round(confidence),
    tier: confidenceTier(confidence),
    components: {
      sampleQuality,
      projectionAgreement: Math.round(projectionAgreement),
      matchupClarity,
      opportunityCertainty,
      calibrationStrength: Math.round(calibrationStrength),
      dataCompleteness,
    },
  };
}
