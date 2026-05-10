// MLB projection engine — Phase 3.
//
// Two layers, deliberately separated:
//
//   1. computeMlbProjection(inputs) — pure formula. No DB, no
//      randomness, fully testable with synthetic inputs.
//
//   2. projectMlbStat(args) — orchestrator. Loads the inputs from
//      the DB (game-log averages, opponent splits, home/away splits)
//      and hands them to (1).
//
// The pure formula is what tests cover. Calibration / weight tuning
// happens here in one place.
//
// Mission discipline: we only use signals we actually have. Park
// factor, weather, BvP, pitcher arsenal, lineup spot, and bullpen
// context are all deferred to later phases. The formula renormalizes
// the weights of available signals so a missing input doesn't bias
// the projection — it just shrinks the model to what we know.

import { getPool } from '../db.js';
import {
  type HittingRow,
  type MlbHitterStatKey,
  type MlbPitcherStatKey,
  type MlbStatKey,
  playerTypeForStat,
  valueFromHittingRow,
  valueFromPitchingRow,
} from '../mlb/stats.js';
import {
  findPlayerLineupSpot,
  getBvpStats,
  getGameContext,
  lineupPaMultiplier,
  type BvpStats,
  type GameContext,
  type GameWeather,
} from '../mlb/gameContext.js';
import { getEspnMlbOddsCached } from '../mlb/client.js';
import {
  describeParkImpact,
  getParkMultiplier,
  lookupParkFactor,
  type ParkFactor,
} from '../mlb/parkFactors.js';
import {
  computeMlbLast10,
  MlbPlayerNotFoundError,
  MlbStatTypeMismatchError,
  type MlbLast10Result,
} from './mlbLast10Engine.js';
import {
  runMlbMonteCarlo,
  type MonteCarloResult,
} from './mlbMonteCarloEngine.js';
import { computeMomentumExpansionScore } from './mlbMomentumExpansion.js';
import {
  applyBayesianRegression,
  computeRobustBaseline,
  getStabilizationGames,
  type RobustBaselineComponents,
} from './mlbBaselineEngine.js';
import {
  computeFragility,
  type FragilityResult,
} from './mlbFragilityEngine.js';
import {
  computeConfidence,
  type ConfidenceResult,
} from './mlbConfidenceEngine.js';
import {
  applyCalibrationAdjustment,
  computeCalibrationStrength,
  getCalibrationFeedbackCached,
} from './mlbCalibrationFeedback.js';
import {
  computeMarketIntel,
  type EdgeDurability,
  type PublicBiasTag,
} from './marketIntel.js';

// -----------------------------------------------------------------
// Inputs / outputs
// -----------------------------------------------------------------

export type ProjectionInputs = {
  statKey: MlbStatKey;
  playerType: 'hitter' | 'pitcher';
  line: number;
  direction: 'OVER' | 'UNDER';

  // Core distribution from the L10 engine. Always present; everything
  // else is optional (renormalize when missing).
  last10: MlbLast10Result;

  // Long-term baseline: full-season average across however many games
  // have been logged. Drives the "regression to the mean" anchor.
  seasonAverage: number | null;
  seasonGames: number;
  // Per-game stat values, ordered most-recent first. Optional —
  // when absent the engine falls back to the simpler last10/last5/
  // season blend. When present, the L1 robust baseline composes
  // L30/L20/L10/L5/median/trimmedMean per the institutional spec.
  orderedValues?: number[];

  // Per-opponent average (player vs this specific opponent's pitching
  // staff or defense). Most reliable signal we have for matchup.
  opponentAverage: number | null;
  opponentGames: number;

  // Home/away split. is_home === true → use the home avg when the
  // upcoming game is home, etc. Very small weight in v0.
  homeAverage: number | null;
  awayAverage: number | null;
  isHome: boolean | null;     // upcoming game; null = unknown

  // ---------- Game-context layer ----------
  // All optional. When present, the engine applies them as adjustments
  // on top of the player-history baseline. When absent, the engine
  // falls back to the prior behavior (no adjustment).

  // Park factor for the upcoming venue. Multiplier applied directly
  // to the projection for hitters; pitcher stats inherit the inverse
  // (hitter-friendly park → pitcher gives up more).
  parkFactor: ParkFactor | null;

  // Weather at game time. tempF + windSpeedMph + windDirection drive
  // the weather adjustment. roofClosed suppresses all weather effects.
  weather: GameWeather | null;

  // Player's spot in tonight's batting order (1-9). Drives the
  // PA-multiplier on counting stats — leadoff hitters get more cracks.
  lineupSpot: number | null;

  // Batter-vs-pitcher career stats. Used as a small reliability-tiered
  // adjustment. Only meaningful for hitter projections.
  bvp: BvpStats | null;

  // The opposing pitcher (when known). Surfaced in reason codes but
  // not used directly in the formula yet.
  opposingPitcherId: number | null;

  // Game script — implied win probability (0-100) for the player's
  // team, sourced from ESPN's public moneyline odds. >60 = favorite
  // (lower variance, blowout-likely if extreme), <40 = underdog
  // (higher variance, hook risk for pitchers, rest/garbage-time risk
  // for hitters). null when odds aren't posted (early in the day).
  gameScript: number | null;

  // Market-implied probability for THIS prop's direction at THIS line
  // — read from the most-recent market_snapshot for (player, stat,
  // line). 0-100 scale, direction-aware (i.e. for an OVER prop,
  // pass the OVER's implied prob; for UNDER, pass UNDER's).
  // When present, the engine uses this for edge math instead of the
  // 50% v0 baseline. When null, falls back to 50 — same behavior as
  // before this field existed, so callers can opt in incrementally.
  marketImpliedProb: number | null;
};

// Per-stat stddev floors. Evidence-grounded by typical MLB game-to-
// game variance. Iter 5 of the formula loop replaces a structurally-
// wrong `projection * 0.15` global floor that blew up z-scores on
// low-magnitude binary stats (the doubles 95→0% bug). Values are
// conservative — when in doubt, larger floor wins because that
// pulls fake-confident probabilities toward the median.
export const MLB_STDDEV_FLOOR: Record<MlbStatKey, number> = {
  // Hitters — binary-ish (mostly 0 per game with occasional 1/2).
  // Real Bernoulli stddev for p=0.10 is √(p*(1-p))=0.30; multi-event
  // games push real stddev higher.
  home_runs:            0.45,
  doubles:              0.55,
  triples:              0.30,
  stolen_bases:         0.45,
  // Hitters — frequent events (most games 1+).
  hits:                 1.00,
  singles:              0.85,
  total_bases:          1.30,
  runs:                 0.85,
  rbis:                 1.00,
  walks:                0.80,
  strikeouts:           1.00,    // hitter K
  hits_runs_rbis:       1.50,
  hitter_fantasy_score: 4.00,
  // Pitchers — counting stats over multiple innings, larger spread.
  ks:                   2.20,
  earned_runs_allowed:  1.50,
  walks_allowed:        1.00,
  pitcher_outs:         3.00,
  hits_allowed:         1.50,
  innings_pitched:      1.00,
  home_runs_allowed:    0.65,
  pitches_thrown:       12.0,
};

// Stat-type risk per the StatEdge MLB spec. Used as a floor on
// `riskScore` — high-variance stats (HR, SB) are inherently risky
// regardless of how stable the player is at them.
export const STAT_TYPE_RISK: Record<MlbStatKey, number> = {
  hits: 45,
  singles: 50,
  doubles: 70,
  triples: 90,
  home_runs: 85,
  total_bases: 60,
  runs: 55,
  rbis: 60,
  walks: 55,
  strikeouts: 65,                // hitter K
  stolen_bases: 90,
  hits_runs_rbis: 50,
  hitter_fantasy_score: 50,
  ks: 45,                        // pitcher K
  earned_runs_allowed: 65,
  walks_allowed: 60,
  pitcher_outs: 35,
  hits_allowed: 60,
  innings_pitched: 35,
  home_runs_allowed: 80,
  pitches_thrown: 35,
};

export type ProjectionResult = {
  // What we project this stat to be. Renormalized weighted blend of
  // available signals. The "expected value" of the stat for the
  // upcoming game.
  projection: number;
  // ±1σ projection band (matches NBA's rangeLow/rangeHigh convention)
  // so the cross-sport ProjectionBand visualization can render. σ is
  // the L10 stddev (with the variance floor used elsewhere in the
  // engine). Floor low at 0 — counting stats can't be negative.
  rangeLow: number;
  rangeHigh: number;
  // The line the projection is being evaluated against. Echoes the
  // input line UNLESS line raising fired — then this is the raised
  // line and originalLine holds the input. probability + edgePercent +
  // evScore reflect THIS line.
  line: number;
  // 0-100, our model's probability the OVER (or UNDER, depending on
  // direction) hits the line.
  probability: number;
  // 0-100. Higher = more reliable. Driven by sample size + signal
  // agreement (e.g. opponent avg matches L10 avg → high confidence).
  confidence: number;
  // 0-100. Variance / volatility / stat-type risk.
  riskScore: number;
  // 0-100. Trap detection — public-narrative + thin-margin + small-
  // sample + outlier risks combined.
  trapScore: number;
  // Trap label for UI surface.
  trapTier: 'Clean' | 'Mild Trap Risk' | 'Moderate Trap Risk' | 'High Trap Risk' | 'Extreme Trap Risk';
  // 0-100. How well the projection separates from the line, in
  // standard deviations. 0σ → 0; 1σ → 50; 2σ+ → 100.
  projectionDistanceScore: number;
  // edgePercent = modelProbability - implied break-even (default 50).
  edgePercent: number;
  // edgeScore = 0..100, scaled edgePercent for UI sorting.
  edgeScore: number;
  // EV score per the spec formula. Not a dollar EV — a 0-100ish
  // ranker that downstream slate construction will use.
  evScore: number;
  // Whether this pick clears the per-mode eligibility bar. v0
  // implementation only flags Safe-mode eligibility; richer mode-
  // aware eligibility lands with the slate builder in Phase 4.
  qualifiesForCards: {
    safe: boolean;
    balanced: boolean;
  };
  // Why we're projecting what we are — surfaced to users so they
  // know what's driving the number, per the mission's transparency
  // principle. Each entry is human-readable.
  reasonCodes: string[];
  // Inputs we actually used vs renormalization weights (debug).
  weightsUsed: Record<string, number>;

  // Context-layer transparency. Each adjustment is reported as a
  // multiplier so users can see "park boosted +12%, weather -3%, etc."
  // 1.00 = neutral / not applied.
  contextAdjustments: {
    park: number;
    weather: number;
    lineup: number;
    bvp: number;
    gameScript: number;         // ESPN moneyline → implied win prob → adjustment
    pitchArsenal: number;       // scaffold — defaults 1.0 until Statcast
    bullpen: number;            // scaffold — defaults 1.0 until reliever-state tracking
  };

  // The pre-context baseline (so debugging can compare baseline vs
  // adjusted). projection field above is the post-adjustment value.
  baselineProjection: number;

  // Long-term anchor used as inputs. Surfaced on the result so the
  // slate pipeline can compute the L2 momentumExpansionScore (L10 vs
  // season ratio) without re-querying. null when seasonGames < 1.
  seasonAverage: number | null;
  seasonGames: number;
  // L5 / L10 averages (mirrored from inputs.last10) — surfaced for
  // the same momentum composite. last10Average is always present;
  // last5Average is null when fewer than 5 games of data exist.
  last10Average: number;
  last5Average: number | null;
  // L10 hit rate at the queried line in chosen direction (0..100).
  // null when no line was queried (projection-only mode). Surfaced
  // for transparency + powers the volume component of momentumExpansionScore.
  last10HitRate: number | null;
  // L2 momentumExpansionScore — composite of production lift (L5/L10),
  // season lift (L10/season), projection separation, and L10 hit
  // rate. Direction-aware: 50 = neutral, ≥65 = real momentum, ≤35 =
  // anti-momentum. Per the 2026-05-08 Wild Card philosophy memo,
  // this is the primary tiebreaker for Aggressive + Wild Card.
  momentumExpansionScore: number;

  // L1 robust baseline transparency. Components are the raw window
  // averages (season, L30, L20, L10, L5) plus median + trimmed mean
  // that were blended into the baseline. null when the engine fell
  // back to the legacy season/L10/L5 path (test inputs without
  // orderedValues; very short samples).
  robustBaselineComponents: RobustBaselineComponents | null;

  // L5 Fragility Intelligence — separate from probability and trap.
  // "How little must go wrong for the pick to fail." A 75% HR prop
  // and a 75% hits-1.5 prop have identical probabilities but very
  // different fragility profiles. Surfacing both keeps the UI
  // honest. Components feed the UI's fragility breakdown panel.
  fragilityScore: number;          // 0..100
  fragilityTier: 'Solid Floor' | 'Moderate Fragility' | 'Fragile' | 'Very Fragile';
  fragilityComponents: FragilityResult['components'];

  // L10 Confidence Intelligence — six-component composite
  // (sampleQuality / projectionAgreement / matchupClarity /
  // opportunityCertainty / calibrationStrength / dataCompleteness).
  // Already exposed via the legacy `confidence` field; the tier
  // banding + per-component breakdown surface here.
  confidenceTier: 'Weak' | 'Medium' | 'Strong' | 'Elite' | 'Institutional';
  confidenceComponents: ConfidenceResult['components'];

  // ---- Line raising (NBA-style elite-conviction signal) ----
  // When the model has elite conviction (high probability + high
  // confidence + low trap + projection well above line), we test
  // raised lines in 0.5 steps to find the highest line that still
  // clears the keep threshold. Surfaced as an analytical signal —
  // PrizePicks doesn't actually offer alternate lines for most
  // props, so this is "would the model still like this if the line
  // moved" rather than a bookable bet.
  originalLine: number | null;
  originalProbability: number | null;
  lineRaised: boolean;
  lineRaiseReason: string | null;

  // Monte Carlo outcome distribution. 10k draws sampling around the
  // projected value with the L10 stddev. Surfaces floor/ceiling per
  // pick so users see the FULL outcome shape, not just the point
  // estimate. Per the mission's "Quantitative Intelligence" section.
  // null when last10.stddev is degenerate (zero or missing) — we
  // don't fabricate spread.
  monteCarlo: MonteCarloResult | null;

  // ---- Phase 101 — Market Intelligence Engine ----
  // The "sportsbook disagreement" layer. Every leg surfaces explicit
  // market-implied probability, public-bias tags, line-inflation
  // score, sharpness composite, edge durability tier, and a single-
  // sentence "why the market may be wrong" narrative. See
  // ./marketIntel.ts for the full contract.
  marketImpliedProb: number;
  lineInflationScore: number;
  publicBiasTags: PublicBiasTag[];
  sharpnessScore: number;
  edgeDurability: EdgeDurability;
  whyMarketWrong: string | null;
};

// -----------------------------------------------------------------
// Formula
// -----------------------------------------------------------------

// v0 weights. Renormalized to whatever signals are present. Per spec,
// these are tuned later via calibration.
//
// L1 (robustBaseline) replaces the old last10/last5/season triplet
// with a 7-window composite (season/L30/L20/L10/L5/median/trimmedMean)
// computed by mlbBaselineEngine. Total baseline weight stays at 0.70
// to preserve the engine's overall balance — opponent/homeAway
// (matchup signals, Layer 3) keep their existing weights on top.
const BASE_WEIGHTS = {
  robustBaseline: 0.70,
  last10:         0.40,   // legacy fallback when orderedValues is missing
  last5:          0.20,   // legacy fallback
  opponent:       0.20,
  homeAway:       0.10,
  season:         0.10,   // legacy fallback
} as const;

type SignalKey = keyof typeof BASE_WEIGHTS;

// Standard normal CDF approximation (Abramowitz & Stegun 26.2.17).
// Used to convert (projection − line) / stddev into a probability.
// More accurate than the previous coarse-tier approximations and
// lets the engine produce smooth probabilities across the range.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (
    0.319381530 + t * (
      -0.356563782 + t * (
        1.781477937 + t * (
          -1.821255978 + t * 1.330274429
        )
      )
    )
  );
  return z >= 0 ? 1 - p : p;
}

// Empty-input guard. Projecting on zero data should return a neutral,
// low-confidence verdict rather than NaN.
function emptyResult(
  statKey: MlbStatKey,
  line: number,
  direction: 'OVER' | 'UNDER',
): ProjectionResult {
  return {
    projection: 0,
    rangeLow: 0,
    rangeHigh: 0,
    line,
    probability: 50,
    confidence: 0,
    riskScore: 100,
    trapScore: 80,
    trapTier: 'High Trap Risk',
    projectionDistanceScore: 0,
    edgePercent: 0,
    edgeScore: 0,
    evScore: 0,
    qualifiesForCards: { safe: false, balanced: false },
    reasonCodes: ['No game-log data available — cannot project.'],
    weightsUsed: {},
    contextAdjustments: {
      park: 1, weather: 1, lineup: 1, bvp: 1, gameScript: 1, pitchArsenal: 1, bullpen: 1,
    },
    baselineProjection: 0,
    seasonAverage: null,
    seasonGames: 0,
    last10Average: 0,
    last5Average: null,
    last10HitRate: null,
    robustBaselineComponents: null,
    fragilityScore: 50,
    fragilityTier: 'Moderate Fragility',
    fragilityComponents: {
      statRarity: 50,
      marginThinness: 50,
      sampleWeakness: 100,
      volatility: 50,
      lineupUncertainty: null,
    },
    confidenceTier: 'Weak',
    confidenceComponents: {
      sampleQuality: 0, projectionAgreement: 50, matchupClarity: 30,
      opportunityCertainty: 30, calibrationStrength: 50, dataCompleteness: 0,
    },
    momentumExpansionScore: 50,
    monteCarlo: null,
    originalLine: null,
    originalProbability: null,
    lineRaised: false,
    lineRaiseReason: null,
    // Phase 101 — neutral defaults for empty result.
    marketImpliedProb: 50,
    lineInflationScore: 0,
    publicBiasTags: [],
    sharpnessScore: 0,
    edgeDurability: 'fragile',
    whyMarketWrong: null,
  };
}

// ---------------- Line raising (MLB) ----------------
//
// Per-stat absolute cap on how far a line can be raised. Caps are
// stat-aware — we don't raise HR by 5 (every hitter would clear),
// and we don't raise hits by 0.1 (the half-step granularity wouldn't
// cooperate). Numbers chosen to mirror real PrizePicks line ranges:
// the cap is roughly "one full step away from the most aggressive
// line the prop board ever offers."
const MLB_LINE_RAISE_CAPS: Partial<Record<MlbStatKey, number>> = {
  hits:                 1.5,    // 1.5 → 3.0 (3-hit games are rare but real)
  singles:              1.5,
  doubles:              1.0,
  total_bases:          3.0,    // total bases swings widest
  runs:                 1.5,
  rbis:                 1.5,
  walks:                1.0,
  strikeouts:           2.0,
  stolen_bases:         1.0,
  home_runs:            0.5,    // HR boundaries are tight; one extra HR is huge
  hits_runs_rbis:       3.0,
  triples:              0.5,
  hitter_fantasy_score: 8.0,
  // Pitcher stats
  ks:                   3.0,    // K floors are 4-5; extra step gives 7-8
  pitcher_outs:         3.0,    // 18 → 21 outs is one extra inning
  innings_pitched:      1.0,
  hits_allowed:         2.0,
  earned_runs_allowed:  1.5,
  walks_allowed:        1.0,
  home_runs_allowed:    0.5,
  pitches_thrown:       15.0,
};

// Trigger thresholds — original projection must clear all of these
// for line-raising to even be considered. Conservative on purpose;
// raised lines are an analytical bonus, not a primary path.
const MLB_LINE_RAISE_TRIGGER = {
  probability: 70,
  confidence: 70,
  trapScore: 40,         // trap score must be low
  edgeSigmas: 1.25,      // projection must be ≥1.25σ from line
} as const;

// Keep threshold — at each candidate raised line, the new
// probability must clear this for the raise to "stick."
const MLB_LINE_RAISE_KEEP = {
  probability: 60,
} as const;

// Standard normal CDF (Abramowitz & Stegun) — same approximation the
// projection engine uses internally. Duplicated here to keep the
// line-raising code self-contained without exposing the engine's
// private helper.
function lineRaiseNormalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (
    0.319381530 + t * (
      -0.356563782 + t * (
        1.781477937 + t * (
          -1.821255978 + t * 1.330274429
        )
      )
    )
  );
  return z >= 0 ? 1 - p : p;
}

// Test whether the line should be raised given the candidate's
// projection. Returns either the original line + null raise fields,
// or the raised line with diagnostic context. Pure — no DB or async.
export function maybeRaiseMlbLine(opts: {
  statKey: MlbStatKey;
  originalLine: number;
  direction: 'OVER' | 'UNDER';
  probability: number;
  confidence: number;
  trapScore: number;
  projection: number;
  stddev: number;
}): {
  line: number;
  probability: number;
  originalLine: number | null;
  originalProbability: number | null;
  lineRaised: boolean;
  lineRaiseReason: string | null;
} {
  const {
    statKey, originalLine, direction, probability, confidence,
    trapScore, projection, stddev,
  } = opts;

  const cap = MLB_LINE_RAISE_CAPS[statKey];
  // Stats not eligible for raising (or degenerate stddev) → no raise.
  if (cap === undefined || stddev <= 0) {
    return {
      line: originalLine,
      probability,
      originalLine: null,
      originalProbability: null,
      lineRaised: false,
      lineRaiseReason: null,
    };
  }

  // Trigger gates. All must pass on the original projection.
  if (probability < MLB_LINE_RAISE_TRIGGER.probability ||
      confidence < MLB_LINE_RAISE_TRIGGER.confidence ||
      trapScore > MLB_LINE_RAISE_TRIGGER.trapScore) {
    return {
      line: originalLine, probability,
      originalLine: null, originalProbability: null,
      lineRaised: false, lineRaiseReason: null,
    };
  }

  // Edge-in-stddev gate.
  const edgeSigmas =
    direction === 'OVER'
      ? (projection - originalLine) / stddev
      : (originalLine - projection) / stddev;
  if (edgeSigmas < MLB_LINE_RAISE_TRIGGER.edgeSigmas) {
    return {
      line: originalLine, probability,
      originalLine: null, originalProbability: null,
      lineRaised: false, lineRaiseReason: null,
    };
  }

  // Walk the line in 0.5 steps (capped by MLB_LINE_RAISE_CAPS).
  // For OVER picks we walk UP; for UNDER we walk DOWN. Stop at the
  // highest step where the keep threshold still passes.
  const STEP = 0.5;
  const sign = direction === 'OVER' ? 1 : -1;
  let bestLine = originalLine;
  let bestProb = probability;
  for (let delta = STEP; delta <= cap + 1e-9; delta += STEP) {
    const trialLine = originalLine + sign * delta;
    const z = (trialLine - projection) / stddev;
    const overP = (1 - lineRaiseNormalCdf(z)) * 100;
    const trialProb = direction === 'OVER' ? overP : 100 - overP;
    if (trialProb < MLB_LINE_RAISE_KEEP.probability) break;
    bestLine = trialLine;
    bestProb = trialProb;
  }

  if (bestLine === originalLine) {
    return {
      line: originalLine, probability,
      originalLine: null, originalProbability: null,
      lineRaised: false, lineRaiseReason: null,
    };
  }

  return {
    line: bestLine,
    probability: Math.round(bestProb * 10) / 10,
    originalLine,
    originalProbability: probability,
    lineRaised: true,
    lineRaiseReason:
      `Raised from ${originalLine} → ${bestLine} · projection still favors ${direction}.`,
  };
}

// -----------------------------------------------------------------
// Context adjustment math (pure)
// -----------------------------------------------------------------

// Weather → projection multiplier, by stat. Applied only outdoors.
// References:
//   • Hot weather (>85F) modestly boosts offense (~+3%). Cold
//     suppresses (~-3%). Effect strongest on HR/total_bases.
//   • Wind speed × direction (Out vs In) is the dominant HR signal:
//     ≥10mph out → ~+8% HR; ≥10mph in → ~-8% HR.
//   • Walks / strikeouts / pitcher_outs are essentially weather-
//     invariant. Stays neutral.
//
// Returns 1.00 (neutral) when weather is missing, roof is closed,
// or stat isn't weather-sensitive.
export function computeWeatherMultiplier(
  weather: GameWeather | null,
  statKey: MlbStatKey,
  playerType: 'hitter' | 'pitcher',
): number {
  if (!weather) return 1.0;
  if (weather.roofClosed) return 1.0;

  // Map pitcher stats to their hitter-equivalent for the lookup.
  const equivStat: MlbStatKey =
    playerType === 'pitcher'
      ? (statKey === 'home_runs_allowed' ? 'home_runs'
        : statKey === 'hits_allowed'    ? 'hits'
        : statKey === 'earned_runs_allowed' ? 'runs'
        : statKey)
      : statKey;

  // Stats that ignore weather: K, walks, IP, outs, pitches, SB, BB.
  const weatherInsensitive: MlbStatKey[] = [
    'strikeouts', 'walks', 'stolen_bases', 'ks',
    'walks_allowed', 'pitcher_outs', 'innings_pitched', 'pitches_thrown',
  ];
  if (weatherInsensitive.includes(equivStat)) return 1.0;

  let mult = 1.0;

  // Temperature
  if (weather.tempF !== null) {
    if (weather.tempF >= 85) mult *= 1.03;
    else if (weather.tempF >= 75) mult *= 1.015;
    else if (weather.tempF <= 50) mult *= 0.97;
    else if (weather.tempF <= 60) mult *= 0.985;
  }

  // Wind — strongest signal on HR / total_bases.
  if (
    weather.windSpeedMph !== null &&
    weather.windSpeedMph >= 7 &&
    weather.windDirection
  ) {
    const dir = weather.windDirection.toLowerCase();
    const isOut = /out\b/.test(dir);
    const isIn = /in\b/.test(dir);
    const isPowerStat = equivStat === 'home_runs' || equivStat === 'total_bases';
    if (isPowerStat) {
      const strength = Math.min(weather.windSpeedMph, 20) / 20;   // cap at 20 mph
      if (isOut) mult *= 1 + 0.10 * strength;
      else if (isIn) mult *= 1 - 0.10 * strength;
    }
  }

  // For pitchers, we want the inverse direction: hitter-friendly
  // weather → more runs allowed by pitcher. Pitcher's projection
  // (a stat the pitcher GIVES UP) should track UP with hitter boost.
  // So same multiplier applies — no inversion needed.
  return mult;
}

// Lineup spot → counting-stat multiplier. Uses the public PA-by-order
// curve. Only applied to counting stats; rate stats (innings_pitched,
// pitcher_outs) and pitcher stats generally aren't lineup-driven.
export function computeLineupMultiplier(
  lineupSpot: number | null,
  statKey: MlbStatKey,
  playerType: 'hitter' | 'pitcher',
): number {
  if (lineupSpot === null) return 1.0;
  if (playerType === 'pitcher') return 1.0;
  // Rate-style hitter stats don't scale with PA — but most hitter
  // stats here are counting stats. Walks, K, SB scale partially.
  return lineupPaMultiplier(lineupSpot);
}

// BvP → small directional adjustment, weighted by reliability tier.
// At "noise" reliability (under 10 PA), no adjustment. At
// "meaningful" (50+ PA), the BvP rate fully replaces a small slice
// of the baseline.
//
// We compute a BvP rate (per-PA) and compare to the player's overall
// per-PA rate from L10. If the player hits this pitcher better than
// their baseline, multiplier > 1; if they struggle, multiplier < 1.
// Game-script → projection multiplier. Uses ESPN's moneyline-implied
// win probability (0-100) for the player's team:
//
//   gameScript ≥ 65 = heavy favorite (lower variance, blowout risk)
//   gameScript ≤ 35 = heavy underdog (higher variance, hook risk)
//   between = neutral, no adjustment
//
// Adjustments are direction-aware AND stat-aware:
//
// PITCHERS (favorite or underdog):
//   - Heavy favorite: the manager protects them in a blowout WIN —
//     fewer innings late, smaller K count → ~-3% K, -5% outs
//   - Heavy underdog: more likely to give up runs early and get
//     hooked → -8% K, -12% outs, +5% earned-runs-allowed
//
// HITTERS:
//   - Heavy favorite team: more PAs likely if they jump out big
//     → +3% on counting stats (hits/runs/RBI/total_bases)
//   - Heavy underdog team: pinch-hit / rest / garbage-time risk
//     → -3% on counting stats
//   - HR is mostly script-invariant (single-PA event) → tiny effect
//
// Returns 1.00 for null gameScript or stats not script-sensitive.
export function computeGameScriptMultiplier(
  gameScript: number | null,
  statKey: MlbStatKey,
  playerType: 'hitter' | 'pitcher',
): number {
  if (gameScript === null) return 1.0;
  if (gameScript >= 35 && gameScript <= 65) return 1.0;     // neutral band

  const isFavorite = gameScript > 65;
  // How extreme is the script? 65 → 0 (just at threshold), 80 → 1
  // (fully extreme). Same for underdog: 35 → 0, 20 → 1.
  const extremity = Math.min(1, Math.abs(gameScript - 50) / 30);

  if (playerType === 'pitcher') {
    if (statKey === 'ks') {
      const baseSwing = isFavorite ? -0.03 : -0.08;
      return 1 + baseSwing * extremity;
    }
    if (statKey === 'pitcher_outs' || statKey === 'innings_pitched') {
      const baseSwing = isFavorite ? -0.05 : -0.12;
      return 1 + baseSwing * extremity;
    }
    if (statKey === 'earned_runs_allowed') {
      // Underdog pitchers concede more runs in blowouts; favorites
      // give up roughly the same (they're winning either way).
      const baseSwing = isFavorite ? 0 : 0.05;
      return 1 + baseSwing * extremity;
    }
    if (statKey === 'hits_allowed' || statKey === 'walks_allowed' || statKey === 'home_runs_allowed') {
      const baseSwing = isFavorite ? -0.02 : 0.04;
      return 1 + baseSwing * extremity;
    }
    return 1.0;
  }

  // Hitter
  // Counting stats — favored hitters get a bit more PA; underdog
  // hitters dampened by garbage-time / rest risk.
  const countingStats: MlbStatKey[] = [
    'hits', 'singles', 'doubles', 'triples', 'total_bases',
    'runs', 'rbis', 'walks', 'hits_runs_rbis', 'hitter_fantasy_score',
  ];
  if (countingStats.includes(statKey)) {
    const baseSwing = isFavorite ? 0.03 : -0.03;
    return 1 + baseSwing * extremity;
  }
  // HR / SB / K (hitter): mostly script-invariant. Tiny effect.
  return 1.0;
}

export function computeBvpMultiplier(
  bvp: BvpStats | null,
  statKey: MlbStatKey,
  baselineRatePerPa: number | null,
): number {
  if (!bvp) return 1.0;
  if (bvp.reliability === 'noise') return 1.0;
  if (baselineRatePerPa === null || baselineRatePerPa <= 0) return 1.0;

  // Pull the matchup rate per PA for the relevant stat.
  const bvpEvent =
    statKey === 'hits' ? bvp.hits
    : statKey === 'home_runs' ? bvp.homeRuns
    : statKey === 'doubles' ? bvp.doubles
    : statKey === 'triples' ? bvp.triples
    : statKey === 'walks' ? bvp.walks
    : statKey === 'strikeouts' ? bvp.strikeouts
    : statKey === 'total_bases'
      ? bvp.hits + bvp.doubles + bvp.triples * 2 + bvp.homeRuns * 3
      : null;
  if (bvpEvent === null) return 1.0;
  const bvpRate = bvpEvent / bvp.plateAppearances;

  // Reliability shrinkage: how much of the bvp rate vs the baseline
  // rate to actually trust. weak=10%, moderate=25%, meaningful=40%.
  const trust =
    bvp.reliability === 'meaningful' ? 0.40
    : bvp.reliability === 'moderate' ? 0.25
    : 0.10;

  // Blend rates → ratio against baseline.
  const blended = baselineRatePerPa * (1 - trust) + bvpRate * trust;
  const ratio = blended / baselineRatePerPa;
  // Clamp to a reasonable [0.7, 1.4] range — even meaningful BvP
  // shouldn't double or halve a projection on its own.
  return clamp(ratio, 0.7, 1.4);
}

export function computeMlbProjection(inputs: ProjectionInputs): ProjectionResult {
  const { last10, line, direction, statKey } = inputs;

  if (last10.sampleSize === 0) {
    return emptyResult(statKey, line, direction);
  }

  // ----- Renormalized weighted projection -----
  //
  // L1 robustBaseline (institutional 7-window composite) replaces the
  // legacy season/L10/L5 triplet when ordered season values are
  // available. When they're not (e.g. degraded test inputs), fall
  // back to the legacy signals so the engine still produces an answer.
  const signals: Array<{ key: SignalKey; value: number; weight: number }> = [];
  let robustComponents: RobustBaselineComponents | null = null;
  let robustWeights: Record<string, number> = {};
  let bayesian: { sampleStrength: number; anchorWeight: number } | null = null;

  if (inputs.orderedValues && inputs.orderedValues.length > 0) {
    const robust = computeRobustBaseline(inputs.orderedValues);
    robustComponents = robust.components;
    robustWeights = robust.weightsUsed;
    // Apply Bayesian regression toward season average when sample
    // is below the stat-specific stabilization threshold. For full-
    // season players (gamesPlayed ≥ threshold), sampleStrength = 1
    // and the robust value passes through unchanged.
    let robustValue = robust.robust;
    if (inputs.seasonAverage !== null && inputs.seasonGames > 0) {
      const threshold = getStabilizationGames(inputs.statKey);
      const reg = applyBayesianRegression({
        recent: robust.robust,
        anchor: inputs.seasonAverage,
        gamesPlayed: inputs.seasonGames,
        threshold,
      });
      robustValue = reg.blended;
      bayesian = {
        sampleStrength: reg.sampleStrength,
        anchorWeight: reg.anchorWeight,
      };
    }
    signals.push({
      key: 'robustBaseline',
      value: robustValue,
      weight: BASE_WEIGHTS.robustBaseline,
    });
  } else {
    // Legacy fallback — preserves test compatibility for synthetic
    // inputs that don't supply orderedValues.
    signals.push({ key: 'last10', value: last10.last10Average, weight: BASE_WEIGHTS.last10 });
    if (last10.last5Average !== null) {
      signals.push({ key: 'last5', value: last10.last5Average, weight: BASE_WEIGHTS.last5 });
    }
    if (inputs.seasonAverage !== null && inputs.seasonGames >= 5) {
      signals.push({ key: 'season', value: inputs.seasonAverage, weight: BASE_WEIGHTS.season });
    }
  }

  if (inputs.opponentAverage !== null && inputs.opponentGames > 0) {
    // De-weight opponent if very small sample (<3 games) — it's still
    // signal but noisy. Half-weight under 3 games.
    const w = inputs.opponentGames < 3 ? BASE_WEIGHTS.opponent * 0.5 : BASE_WEIGHTS.opponent;
    signals.push({ key: 'opponent', value: inputs.opponentAverage, weight: w });
  }
  if (inputs.isHome !== null) {
    const venueAvg = inputs.isHome ? inputs.homeAverage : inputs.awayAverage;
    if (venueAvg !== null) {
      signals.push({ key: 'homeAway', value: venueAvg, weight: BASE_WEIGHTS.homeAway });
    }
  }

  const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
  const baselineProjection =
    totalWeight === 0
      ? last10.last10Average
      : signals.reduce((s, x) => s + x.value * x.weight, 0) / totalWeight;

  const weightsUsed: Record<string, number> = {};
  for (const s of signals) {
    weightsUsed[s.key] = Math.round((s.weight / totalWeight) * 100) / 100;
  }
  // Surface the robust-baseline internal weights so the UI can show
  // "season=0.18, L30=0.14, ..." breakdowns.
  if (Object.keys(robustWeights).length > 0) {
    for (const [k, v] of Object.entries(robustWeights)) {
      weightsUsed[`robust:${k}`] = v;
    }
  }
  if (bayesian) {
    weightsUsed['bayesian:sample'] = bayesian.sampleStrength;
    weightsUsed['bayesian:anchor'] = bayesian.anchorWeight;
  }

  // ----- Context layer multipliers -----
  // Each is independent and multiplicative. 1.00 = no effect. Park
  // and weather kick in only when we have a venue/weather payload;
  // lineup needs the player's spot tonight; BvP needs the matchup.
  // pitchArsenal + bullpen are intentional scaffold-1.0 until the
  // data lands (Statcast / reliever workload tracking).
  const parkMult = getParkMultiplier(inputs.parkFactor, inputs.statKey, inputs.playerType);
  const weatherMult = computeWeatherMultiplier(inputs.weather, inputs.statKey, inputs.playerType);
  const lineupMult = computeLineupMultiplier(inputs.lineupSpot, inputs.statKey, inputs.playerType);
  // BvP rate: baseline per-PA derived from L10 average ÷ ~4 PA/game.
  const baselineRatePerPa =
    inputs.playerType === 'hitter' && last10.last10Average > 0
      ? last10.last10Average / 4
      : null;
  const bvpMult = computeBvpMultiplier(inputs.bvp, inputs.statKey, baselineRatePerPa);
  const gameScriptMult = computeGameScriptMultiplier(
    inputs.gameScript, inputs.statKey, inputs.playerType,
  );
  const pitchArsenalMult = 1.0;     // scaffold — needs Statcast
  const bullpenMult = 1.0;          // scaffold — needs reliever workload tracking

  // Iter 7 of the formula loop: cap the compound multiplier at
  // [0.65, 1.45] so a perfect-storm context doesn't multiply
  // baseline 2x or compress it to nothing.
  //
  // Evidence: the May 2026 calibration showed the engine overclaims
  // hitter probabilities by 25-65pp across most stats, and even iter
  // 6's 35pp calibration cap leaves residual gaps. Tracing the
  // overclaim to source: 7 multipliers compounding multiplicatively
  // with no cap can stack to 2.0x when context is fully aligned
  // (park 1.20 × weather 1.15 × lineup 1.15 × BvP 1.20 × gameScript
  // 1.05 ≈ 2.00). Doubling baseline gets a player from 0.7 singles
  // baseline to 1.4 projected — easily clears the 0.5 line and
  // produces 88% probability the calibration loop then has to
  // band-aid back down.
  //
  // 1.45 cap matches industry context-stacking discipline: even on
  // a "perfect day" (Coors + tailwind + cleanup spot + good BvP +
  // favorite + plus matchup), a single-game projection rarely
  // exceeds +45% above baseline in actual MLB data. The 0.65 floor
  // is symmetric — a fully-suppressive context (away vs ace + cold
  // wind + 9-spot + bad BvP + heavy underdog) bottoms out at 35%
  // below baseline, not zero.
  //
  // Honest about the limit: this is a coarse cap. A finer fix would
  // be to weight multipliers by signal strength (e.g. BvP needs
  // 30+ PAs to count fully) and re-blend non-multiplicatively. That's
  // larger surgery; for this iteration, the cap closes the worst
  // of the inflation cheaply.
  const rawContextMult =
    parkMult * weatherMult * lineupMult * bvpMult * gameScriptMult
    * pitchArsenalMult * bullpenMult;
  const totalContextMult = Math.max(0.65, Math.min(1.45, rawContextMult));
  const projection = baselineProjection * totalContextMult;

  // ----- Probability via normal approximation -----
  // Iter 5 of the formula loop: per-stat stddev floors that reflect
  // real MLB game-to-game variance.
  //
  // The previous floor was Math.abs(projection) * 0.15 — way too
  // tight for low-magnitude binary-ish stats. For doubles with
  // projection 0.5 the floor was 0.075, but real game-to-game stddev
  // for doubles is ~0.55 (most games 0, occasional 1, rare 2). When
  // the projection nudged above the line via park / weather / matchup
  // multipliers, z-score = (proj - line) / 0.075 blew up to >5,
  // producing fake 95-99% probabilities that the user-shared May
  // 2026 calibration confirmed never materialize: doubles 95→0% in
  // 32 graded rows, singles 88→20%, strikeouts 95→39%.
  //
  // Per-stat floors below match NBA's STD_DEV_FLOOR pattern. Values
  // are evidence-grounded by typical MLB game-to-game variance:
  // binary events (HR, doubles, triples, SB) get ~0.3-0.55 floors
  // so projection swings above the line don't snap probability to
  // the cap. Larger stats (total_bases, hits_runs_rbis, fantasy)
  // get proportionally larger floors.
  const statFloor = MLB_STDDEV_FLOOR[inputs.statKey] ?? Math.max(0.01, Math.abs(projection) * 0.15);
  const stddev = Math.max(last10.stddev, statFloor);
  const z = (projection - line) / stddev;
  const probOver = normalCdf(z) * 100;
  const rawProbability = direction === 'OVER' ? probOver : 100 - probOver;
  // Soft cap to [5, 95]. Even with huge separation, we're not 100%
  // confident on a single game. This is the regression-to-the-mean
  // discipline the mission demands — no fake "lock" probabilities.
  const probability = clamp(rawProbability, 5, 95);

  // ----- Projection distance score (0-100) -----
  const distanceUnits = Math.abs(projection - line) / stddev;
  const projectionDistanceScore = clamp(Math.round(distanceUnits * 50), 0, 100);

  // ----- L5 Fragility -----
  // Separate from probability + trap. "How little must go wrong for
  // this pick to fail." Surfaced alongside probability so users see
  // both: a 75% HR prop and a 75% hits prop look identical on the
  // probability dial but have very different failure modes.
  const fragility = computeFragility({
    statKey: inputs.statKey,
    playerType: inputs.playerType,
    projection,
    line,
    stddev,
    sampleStrength: bayesian?.sampleStrength ?? null,
    // Hitters: confirmed when we have a real lineupSpot from the MLB
    // API (not null). Pitchers: not applicable.
    lineupConfirmed: inputs.playerType === 'pitcher'
      ? null
      : inputs.lineupSpot !== null,
  });

  // ----- Confidence (L10) -----
  // Six-component composite per the institutional MLB Intelligence
  // Engine spec — replaces the legacy 2-component (sample + agreement)
  // calc. Same engine state inputs, just reweighted to spec.
  const l10Anchor = last10.last10Average === 0 ? 1 : Math.abs(last10.last10Average);
  const stabilizationGames = inputs.orderedValues
    ? getStabilizationGames(inputs.statKey)
    : 25;
  const confidenceResult = computeConfidence({
    last10Size: last10.sampleSize,
    seasonGames: inputs.seasonGames,
    stabilizationGames,
    agreementSpread: {
      seasonVsLast10: inputs.seasonAverage !== null && inputs.seasonGames >= 10
        ? Math.abs(inputs.seasonAverage - last10.last10Average) / l10Anchor
        : null,
      opponentVsLast10: inputs.opponentAverage !== null && inputs.opponentGames >= 2
        ? Math.abs(inputs.opponentAverage - last10.last10Average) / l10Anchor
        : null,
      last5VsLast10: last10.last5Average !== null && last10.last10Average > 0
        ? Math.abs(last10.last5Average - last10.last10Average) / l10Anchor
        : null,
    },
    opponentGames: inputs.opponentGames,
    // Handedness signal — we always know SOME side because the stat
    // was resolved against a typed player. Treat as known when
    // opposing pitcher (BvP) is provided OR the player has any
    // matchup history. Conservative.
    handednessKnown: inputs.opposingPitcherId !== null || inputs.opponentGames > 0,
    playerType: inputs.playerType,
    lineupConfirmed: inputs.playerType === 'hitter'
      ? inputs.lineupSpot !== null
      : null,
    gameContextLoaded: inputs.parkFactor !== null
      || inputs.weather !== null
      || inputs.lineupSpot !== null,
    // Calibration loop is data-gated — we'll wire it in once L9 has
    // accumulated enough graded predictions. For now: neutral.
    calibrationScore: null,
    contextLayers: {
      park:       inputs.parkFactor !== null,
      weather:    inputs.weather !== null,
      lineup:     inputs.lineupSpot !== null,
      bvp:        inputs.bvp !== null,
      gameScript: inputs.gameScript !== null,
    },
  });
  const confidence = confidenceResult.confidence;

  // ----- Risk -----
  // Take the bigger of the L10-driven volatility risk and the stat-
  // type floor. HR / SB / triples are inherently risky no matter how
  // stable the player.
  const statTypeFloor = STAT_TYPE_RISK[statKey] ?? 50;
  const riskScore = clamp(
    Math.round(Math.max(last10.riskScore, statTypeFloor * 0.6)),
    0,
    100,
  );

  // ----- Trap score -----
  const trapScore = computeTrapScore(inputs, projection);
  const trapTier = trapTierFromScore(trapScore);

  // ----- Edge -----
  // Use the real market-implied probability when the caller has it
  // (read from market_snapshots at slate-build time). Falls back to
  // 50% only when the prop has no captured market line — that path
  // matches the v0 behavior and is structurally honest about the
  // unknown rather than fabricating a baseline.
  const impliedBreakEven = inputs.marketImpliedProb !== null
    ? inputs.marketImpliedProb
    : 50;
  const edgePercent = round1(probability - impliedBreakEven);
  const edgeScore = clamp(Math.round((edgePercent + 25) * 2), 0, 100);

  // ----- EV score per spec (L7) -----
  // Spec formula:
  //   evScore = edge%*0.34 + projGap*0.22 + confidence*0.18
  //           - trap*0.10 - fragility*0.08 - correlationPenalty*0.08
  //
  // Correlation penalty is applied at the card-construction layer
  // (slate builder weights legs differently when same-game stacks
  // appear), not per-leg, so we hold its weight at 0 here. The
  // remaining six components reweight to spec proportions.
  const evScore = round1(
    edgePercent * 0.34
    + projectionDistanceScore * 0.22
    + confidence * 0.18
    - trapScore * 0.10
    - fragility.fragility * 0.08,
  );

  // ----- Eligibility for cards (v0: simple gates; richer in Phase 4) -----
  const qualifiesSafe =
    confidence >= 60 &&
    riskScore <= 60 &&
    trapScore <= 40 &&
    probability >= 60;
  const qualifiesBalanced =
    confidence >= 50 &&
    trapScore <= 60 &&
    edgePercent >= 5;

  // ----- Reason codes -----
  const reasonCodes = buildReasonCodes(inputs, {
    projection,
    probability,
    confidence,
    riskScore,
    trapScore,
    projectionDistanceScore,
    edgePercent,
  });

  // Context-layer reason codes — appended to whatever buildReasonCodes
  // already added for the player-history side. We do this after main
  // reasons so context shows up at the bottom alphabetically grouped.
  if (inputs.parkFactor) {
    const ratioPct = Math.round((parkMult - 1) * 100);
    if (Math.abs(ratioPct) >= 3) {
      const phrase = describeParkImpact(inputs.parkFactor.name, parkMult);
      if (phrase) reasonCodes.push(`Park: ${phrase}.`);
    }
  }
  if (inputs.weather && !inputs.weather.roofClosed) {
    const w = inputs.weather;
    const parts: string[] = [];
    if (w.tempF !== null) parts.push(`${w.tempF}°F`);
    if (w.windSpeedMph !== null && w.windDirection) {
      parts.push(`${w.windSpeedMph} mph ${w.windDirection.toLowerCase()}`);
    }
    const ratioPct = Math.round((weatherMult - 1) * 100);
    if (Math.abs(ratioPct) >= 2 && parts.length > 0) {
      const sign = ratioPct > 0 ? '+' : '';
      reasonCodes.push(
        `Weather (${parts.join(', ')}): ${sign}${ratioPct}% impact.`,
      );
    }
  } else if (inputs.weather?.roofClosed) {
    reasonCodes.push('Roof closed — weather neutralized.');
  }
  if (inputs.lineupSpot !== null) {
    const ratioPct = Math.round((lineupMult - 1) * 100);
    const sign = ratioPct > 0 ? '+' : '';
    if (Math.abs(ratioPct) >= 2) {
      reasonCodes.push(
        `Batting #${inputs.lineupSpot} → ${sign}${ratioPct}% PA volume vs avg.`,
      );
    }
  }
  if (inputs.bvp) {
    const ratioPct = Math.round((bvpMult - 1) * 100);
    if (inputs.bvp.reliability !== 'noise' && Math.abs(ratioPct) >= 3) {
      const sign = ratioPct > 0 ? '+' : '';
      reasonCodes.push(
        `BvP (${inputs.bvp.plateAppearances} PA, ${inputs.bvp.reliability}): ${sign}${ratioPct}%.`,
      );
    } else if (inputs.bvp.reliability === 'noise') {
      reasonCodes.push(
        `BvP sample (${inputs.bvp.plateAppearances} PA) too small — ignored.`,
      );
    }
  }
  if (inputs.gameScript !== null) {
    const ratioPct = Math.round((gameScriptMult - 1) * 100);
    if (Math.abs(ratioPct) >= 2) {
      const sign = ratioPct > 0 ? '+' : '';
      const role =
        inputs.gameScript > 65 ? 'heavy favorite'
        : inputs.gameScript < 35 ? 'heavy underdog'
        : 'balanced';
      reasonCodes.push(
        `Game script (${inputs.gameScript.toFixed(0)}% implied, ${role}): ${sign}${ratioPct}%.`,
      );
    }
  }

  // Monte Carlo distribution. Uses the L10 stddev as variance proxy —
  // same stddev floor logic as the deterministic prob calc. Returns
  // null when stddev is degenerate (engine handles internally).
  const monteCarlo = runMlbMonteCarlo({
    statKey: inputs.statKey,
    projection,
    stddev: last10.stddev,
    line: inputs.line,
    direction: inputs.direction,
  });

  // Line raising (NBA-style). Re-run after we have probability +
  // confidence + trap to gate on. When triggered, the engine swaps
  // line + probability with the raised values; originalLine +
  // originalProbability preserve what was passed in. Slate builder
  // will use the raised line/prob for ranking — that's the whole
  // point. Confidence and risk are preserved as-is (per NBA
  // precedent — recomputing them at a raised line is a follow-up).
  const raise = maybeRaiseMlbLine({
    statKey: inputs.statKey,
    originalLine: inputs.line,
    direction: inputs.direction,
    probability,
    confidence,
    trapScore,
    projection,
    stddev,
  });
  // After raise: probability reflects the raised line. Re-derive
  // dependent fields (edgePercent, evScore, projectionDistanceScore)
  // from the raised probability so they stay self-consistent.
  let finalProbability = probability;
  let finalEdgePercent = edgePercent;
  let finalEdgeScore = edgeScore;
  let finalEvScore = evScore;
  let finalProjectionDistanceScore = projectionDistanceScore;
  if (raise.lineRaised) {
    // Soft-cap to [5, 95] same as the original probability — even an
    // elite raised line shouldn't fake-claim 100% on a single game.
    finalProbability = clamp(raise.probability, 5, 95);
    finalEdgePercent = round1(finalProbability - 50);
    finalEdgeScore = clamp(Math.round((finalEdgePercent + 25) * 2), 0, 100);
    // Recompute projection distance against the RAISED line — distance
    // shrinks because the line moved closer to the projection.
    const newDistanceUnits = Math.abs(projection - raise.line) / stddev;
    finalProjectionDistanceScore = clamp(Math.round(newDistanceUnits * 50), 0, 100);
    finalEvScore = round1(
      finalEdgePercent * 0.34
      + finalProjectionDistanceScore * 0.22
      + confidence * 0.18
      - trapScore * 0.10
      - fragility.fragility * 0.08,
    );
    reasonCodes.push(`Line raised: ${raise.originalLine} → ${raise.line} (model still favors ${inputs.direction} at the raised line).`);
  }

  return {
    projection: round2(projection),
    // Projection band — same ±1σ convention NBA uses, computed from
    // the variance proxy already in scope. Floors low at 0 since
    // counting stats can't be negative.
    rangeLow: round2(Math.max(0, projection - stddev)),
    rangeHigh: round2(projection + stddev),
    line: raise.lineRaised ? raise.line : inputs.line,
    probability: round1(finalProbability),
    confidence,
    riskScore,
    trapScore: Math.round(trapScore),
    trapTier,
    projectionDistanceScore: finalProjectionDistanceScore,
    edgePercent: finalEdgePercent,
    edgeScore: finalEdgeScore,
    evScore: finalEvScore,
    qualifiesForCards: { safe: qualifiesSafe, balanced: qualifiesBalanced },
    reasonCodes,
    weightsUsed,
    contextAdjustments: {
      park: round2(parkMult),
      weather: round2(weatherMult),
      lineup: round2(lineupMult),
      bvp: round2(bvpMult),
      gameScript: round2(gameScriptMult),
      pitchArsenal: round2(pitchArsenalMult),
      bullpen: round2(bullpenMult),
    },
    baselineProjection: round2(baselineProjection),
    seasonAverage: inputs.seasonAverage !== null ? round2(inputs.seasonAverage) : null,
    seasonGames: inputs.seasonGames,
    last10Average: round2(inputs.last10.last10Average),
    last5Average: inputs.last10.last5Average !== null ? round2(inputs.last10.last5Average) : null,
    last10HitRate: inputs.last10.hitRate?.rate ?? null,
    robustBaselineComponents: robustComponents,
    fragilityScore: fragility.fragility,
    fragilityTier: fragility.tier,
    fragilityComponents: fragility.components,
    confidenceTier: confidenceResult.tier,
    confidenceComponents: confidenceResult.components,
    momentumExpansionScore: computeMomentumExpansionScore({
      direction: inputs.direction,
      last10Average: inputs.last10.last10Average,
      last5Average: inputs.last10.last5Average,
      seasonAverage: inputs.seasonAverage,
      seasonGames: inputs.seasonGames,
      projectionDistanceScore: finalProjectionDistanceScore,
      last10HitRate: inputs.last10.hitRate?.rate ?? null,
    }),
    monteCarlo,
    originalLine: raise.originalLine,
    originalProbability:
      raise.originalProbability !== null ? round1(raise.originalProbability) : null,
    lineRaised: raise.lineRaised,
    lineRaiseReason: raise.lineRaiseReason,
    // Phase 101 market intelligence layer. Pure-function wrap of the
    // already-computed signals — no DB, no extra cost. Surfaces the
    // disagreement engine output alongside the projection.
    ...computeMarketIntel({
      probability: round1(finalProbability),
      edgePercent: finalEdgePercent,
      projection: round2(projection),
      line: raise.line,
      seasonAvg: inputs.seasonAverage ?? 0,
      l5Avg: inputs.last10.last5Average,
      l10Avg: inputs.last10.last10Average,
      fragilityScore: fragility.fragility,
      trapScore: Math.round(trapScore),
      reasonCodes,
      direction: inputs.direction,
      statKey: inputs.statKey,
    }),
  };
}

// -----------------------------------------------------------------
// Helpers (pure)
// -----------------------------------------------------------------

function computeAgreementPenalty(inputs: ProjectionInputs): number {
  // Compare L10, season, opponent (if present). Big spread → penalty.
  const baseline = inputs.last10.last10Average;
  if (baseline === 0) return 0;
  const others: number[] = [];
  if (inputs.seasonAverage !== null && inputs.seasonGames >= 10) {
    others.push(inputs.seasonAverage);
  }
  if (inputs.opponentAverage !== null && inputs.opponentGames >= 2) {
    others.push(inputs.opponentAverage);
  }
  if (others.length === 0) return 0;
  let totalDelta = 0;
  for (const o of others) {
    totalDelta += Math.abs(o - baseline) / Math.max(0.5, Math.abs(baseline));
  }
  const avgDelta = totalDelta / others.length;
  // 0.15 (15% off) → 5 point penalty; 0.40 (40% off) → 30 points.
  return clamp(Math.round((avgDelta - 0.15) * 100), 0, 30);
}

function computeTrapScore(
  inputs: ProjectionInputs,
  projection: number,
): number {
  let trap = 0;

  // Small sample
  if (inputs.last10.sampleSize < 5) trap += 25;
  else if (inputs.last10.sampleSize < 8) trap += 10;

  // Thin line margin (line basically at projection)
  const margin = Math.abs(projection - inputs.line);
  const stddev = Math.max(inputs.last10.stddev, 0.01);
  if (margin / stddev < 0.25) trap += 25;
  else if (margin / stddev < 0.5) trap += 10;

  // Volatility (CV-like)
  const meanForCv = Math.max(0.5, Math.abs(inputs.last10.last10Average));
  const cv = inputs.last10.stddev / meanForCv;
  if (cv >= 0.6) trap += 25;
  else if (cv >= 0.4) trap += 12;

  // Outlier in L5 — last5 average sharply above L10 average could
  // be one big game inflating the trend. We can't tell from averages
  // alone, but L5 ≥ 1.6× L10 is a yellow flag.
  if (inputs.last10.last5Average !== null
    && inputs.last10.last10Average > 0
    && inputs.last10.last5Average / inputs.last10.last10Average >= 1.6) {
    trap += 15;
  }

  return clamp(trap, 0, 100);
}

function trapTierFromScore(s: number): ProjectionResult['trapTier'] {
  if (s <= 20) return 'Clean';
  if (s <= 40) return 'Mild Trap Risk';
  if (s <= 60) return 'Moderate Trap Risk';
  if (s <= 80) return 'High Trap Risk';
  return 'Extreme Trap Risk';
}

function buildReasonCodes(
  inputs: ProjectionInputs,
  out: {
    projection: number;
    probability: number;
    confidence: number;
    riskScore: number;
    trapScore: number;
    projectionDistanceScore: number;
    edgePercent: number;
  },
): string[] {
  const reasons: string[] = [];

  // Sample
  if (inputs.last10.sampleSize < 5) {
    reasons.push(`Only ${inputs.last10.sampleSize} games of data — small-sample risk.`);
  } else if (inputs.last10.sampleSize >= 10) {
    reasons.push(`Strong sample size: ${inputs.last10.sampleSize} games.`);
  }

  // Trend
  if (inputs.last10.trend !== null) {
    const trend = inputs.last10.trend;
    if (Math.abs(trend) >= Math.max(0.5, inputs.last10.last10Average * 0.15)) {
      reasons.push(
        trend > 0
          ? `L5 ${inputs.last10.last5Average?.toFixed(2)} > L10 ${inputs.last10.last10Average.toFixed(2)} — momentum up.`
          : `L5 ${inputs.last10.last5Average?.toFixed(2)} < L10 ${inputs.last10.last10Average.toFixed(2)} — cooling off.`,
      );
    }
  }

  // Opponent
  if (inputs.opponentAverage !== null && inputs.opponentGames >= 2) {
    reasons.push(
      `Vs this opponent: ${inputs.opponentAverage.toFixed(2)} avg over ${inputs.opponentGames} games.`,
    );
  }

  // Venue
  if (inputs.isHome !== null) {
    const venueAvg = inputs.isHome ? inputs.homeAverage : inputs.awayAverage;
    if (venueAvg !== null) {
      reasons.push(
        `${inputs.isHome ? 'Home' : 'Away'} split: ${venueAvg.toFixed(2)} avg.`,
      );
    }
  }

  // Margin / distance
  if (out.projectionDistanceScore >= 70) {
    reasons.push(
      `Projection ${out.projection.toFixed(2)} sits ≥1σ from line ${inputs.line} — strong separation.`,
    );
  } else if (out.projectionDistanceScore < 25) {
    reasons.push(
      `Projection ${out.projection.toFixed(2)} hugs the line — thin margin, fragile pick.`,
    );
  }

  // Trap
  if (out.trapScore >= 60) {
    reasons.push('High trap exposure — interpret with caution.');
  }

  // Stat-type
  if (STAT_TYPE_RISK[inputs.statKey] >= 80) {
    reasons.push(
      `${inputs.statKey} is structurally low-event / high-variance — inherent risk.`,
    );
  }

  return reasons;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// -----------------------------------------------------------------
// DB-backed orchestrator
// -----------------------------------------------------------------

export type ProjectStatArgs = {
  playerId: number;
  statKey: MlbStatKey;
  line: number;
  direction: 'OVER' | 'UNDER';
  // Upcoming opponent (optional — drives opponent-avg signal).
  opponentTeamId?: number;
  // Whether the player will be home for the upcoming game.
  isHome?: boolean;
  // Specific upcoming game. When provided, the orchestrator fetches
  // the game context (venue, weather, lineup, BvP if pitcher known)
  // and feeds it to the engine. Without gamePk the engine still
  // produces a projection — just without the context layer.
  gamePk?: number;
  // Opposing pitcher's player id (used for BvP lookup). Caller must
  // provide this — we don't auto-derive from gamePk yet (boxscore
  // gives us the lineup but tonight's starting pitcher needs
  // probable-pitchers parsing, which is a follow-up).
  opposingPitcherId?: number;
  // Market-implied probability for THIS direction at THIS line, 0-100.
  // When the slate pipeline has a captured market_snapshot for the
  // prop, it computes the de-vigged implied probability for the
  // requested side and passes it here so edge math anchors against
  // real bookmaker conviction instead of the 50/50 v0 baseline.
  // Optional — engine falls back to 50% when not provided.
  marketImpliedProb?: number;
};

export async function projectMlbStat(
  args: ProjectStatArgs,
): Promise<ProjectionResult> {
  const playerType = playerTypeForStat(args.statKey);
  if (!playerType) {
    throw new Error(`Unknown stat key: ${args.statKey}`);
  }

  // L10 distribution. computeMlbLast10 already enforces type-restriction
  // and player-not-found.
  const last10 = await computeMlbLast10({
    playerId: args.playerId,
    statKey: args.statKey,
    line: args.line,
    direction: args.direction,
  });

  // Season + opponent + venue averages from the same game logs.
  const baselines =
    playerType === 'hitter'
      ? await loadHittingBaselines(args.playerId, args.statKey as MlbHitterStatKey, args.opponentTeamId)
      : await loadPitchingBaselines(args.playerId, args.statKey as MlbPitcherStatKey, args.opponentTeamId);

  // Game context (optional). When gamePk is provided, fetch venue +
  // weather + lineup in parallel. Failures degrade silently — the
  // projection still works without context, just at lower fidelity.
  let gameContext: GameContext | null = null;
  let bvp: BvpStats | null = null;
  let lineupSpot: number | null = null;
  let resolvedIsHome: boolean | null = args.isHome ?? null;
  if (args.gamePk) {
    gameContext = await getGameContext(args.gamePk).catch(() => null);
    if (gameContext) {
      const slot = findPlayerLineupSpot(gameContext.lineups, args.playerId);
      if (slot) {
        lineupSpot = slot.battingOrder;
        if (resolvedIsHome === null) resolvedIsHome = slot.isHome;
      }
    }
  }
  // BvP only meaningful for hitter projections vs a known pitcher.
  if (playerType === 'hitter' && args.opposingPitcherId) {
    bvp = await getBvpStats(args.playerId, args.opposingPitcherId).catch(() => null);
  }
  const parkFactor = lookupParkFactor(gameContext?.venueId ?? null);

  // Game-script: pull ESPN moneyline odds for today's games and
  // match by team-abbr key. Cached in-process for 5 min so an N-leg
  // slate doesn't fetch ESPN N times. We need the player's team and
  // the opponent's team to build the matchup key — when we don't
  // have both, gameScript stays null (engine falls back to neutral).
  let gameScript: number | null = null;
  if (args.gamePk && gameContext) {
    try {
      const playerTeamAbbr = await resolvePlayerTeamAbbr(args.playerId);
      const opponentTeamAbbr = await resolveOpponentAbbr(args.gamePk, playerTeamAbbr);
      if (playerTeamAbbr && opponentTeamAbbr) {
        const date = inferGameDateFromContext(gameContext);
        const odds = await getEspnMlbOddsCached(date);
        // ESPN keys odds by `${homeAbbr}-${awayAbbr}`. We don't know
        // which side is home up here cheaply — try both keys.
        const homeKey = `${playerTeamAbbr}-${opponentTeamAbbr}`;
        const awayKey = `${opponentTeamAbbr}-${playerTeamAbbr}`;
        if (odds.has(homeKey)) {
          gameScript = odds.get(homeKey)!.homeImpliedWinProb;
        } else if (odds.has(awayKey)) {
          gameScript = odds.get(awayKey)!.awayImpliedWinProb;
        }
      }
    } catch {
      // Non-fatal — engine falls back to neutral.
    }
  }

  const inputs: ProjectionInputs = {
    statKey: args.statKey,
    playerType,
    line: args.line,
    direction: args.direction,
    last10,
    seasonAverage: baselines.seasonAverage,
    seasonGames: baselines.seasonGames,
    opponentAverage: baselines.opponentAverage,
    opponentGames: baselines.opponentGames,
    homeAverage: baselines.homeAverage,
    awayAverage: baselines.awayAverage,
    orderedValues: baselines.orderedValues,
    isHome: resolvedIsHome,
    parkFactor,
    weather: gameContext?.weather ?? null,
    lineupSpot,
    bvp,
    opposingPitcherId: args.opposingPitcherId ?? null,
    gameScript,
    // marketImpliedProb is wired by the slate pipeline when it has a
    // captured market_snapshot for this prop. The orchestrator passes
    // it through args; callers who don't query market_snapshots leave
    // it null and the engine falls back to the 50% baseline (matches
    // the v0 behavior so this layer is opt-in incrementally).
    marketImpliedProb: args.marketImpliedProb ?? null,
  };

  const projection = computeMlbProjection(inputs);

  // L9 → L6 calibration feedback. Read graded historical buckets and
  // apply a per-bucket adjustment to the predicted probability when
  // the bucket has enough sample. Skip silently when calibration data
  // is unavailable (no DB, fresh install, etc.) — the engine already
  // works without this layer.
  try {
    const report = await getCalibrationFeedbackCached();
    // Pass statKey so the feedback layer can prefer the per-stat
    // bucket when available — per-stat overclaim is the bigger
    // signal in MLB (singles -68pp, doubles -95pp, strikeouts -55pp
    // all dwarf the global -23.5% gap).
    const adj = applyCalibrationAdjustment(projection.probability, report, args.statKey);
    if (adj.shift !== 0) {
      const clampedProb = clamp(adj.adjustedProbability, 5, 95);
      // Re-derive dependent fields from the adjusted probability so
      // the rest of the result stays self-consistent. Edge math
      // uses the same impliedBreakEven the engine used initially —
      // either the caller's marketImpliedProb or the 50% fallback —
      // not a re-hardcoded 50%, which would silently undo the
      // marketImpliedProb wiring in iter 1.
      const impliedBreakEven = args.marketImpliedProb ?? 50;
      const newEdgePercent = round1(clampedProb - impliedBreakEven);
      const newEdgeScore = clamp(Math.round((newEdgePercent + 25) * 2), 0, 100);
      // EV uses the same 6-component spec weights as the engine.
      const newEvScore = round1(
        newEdgePercent * 0.34
        + projection.projectionDistanceScore * 0.22
        + projection.confidence * 0.18
        - projection.trapScore * 0.10
        - projection.fragilityScore * 0.08,
      );
      projection.probability = round1(clampedProb);
      projection.edgePercent = newEdgePercent;
      projection.edgeScore = newEdgeScore;
      projection.evScore = newEvScore;
      if (adj.reason) projection.reasonCodes.push(adj.reason);
    }

    // Wire calibrationStrength into the L10 confidence's calibration
    // component. Currently the engine passes null → neutral 50; once
    // we have history we can do better. Refresh the confidence
    // composite with the real strength.
    const calibrationStrength = computeCalibrationStrength(report);
    if (calibrationStrength !== 50) {
      // Only re-run confidence if calibration provides a non-neutral
      // signal — otherwise the math is identical and the recompute
      // would be wasted work.
      const refreshed = computeConfidence({
        last10Size: last10.sampleSize,
        seasonGames: baselines.seasonGames,
        stabilizationGames: 25,                  // matches engine default
        agreementSpread: {
          seasonVsLast10: baselines.seasonAverage !== null && baselines.seasonGames >= 10
            ? Math.abs(baselines.seasonAverage - last10.last10Average)
                / Math.max(1, Math.abs(last10.last10Average))
            : null,
          opponentVsLast10: baselines.opponentAverage !== null && baselines.opponentGames >= 2
            ? Math.abs(baselines.opponentAverage - last10.last10Average)
                / Math.max(1, Math.abs(last10.last10Average))
            : null,
          last5VsLast10: last10.last5Average !== null && last10.last10Average > 0
            ? Math.abs(last10.last5Average - last10.last10Average)
                / Math.max(1, Math.abs(last10.last10Average))
            : null,
        },
        opponentGames: baselines.opponentGames,
        handednessKnown: args.opposingPitcherId !== undefined || baselines.opponentGames > 0,
        playerType,
        lineupConfirmed: playerType === 'hitter' ? lineupSpot !== null : null,
        gameContextLoaded: parkFactor !== null
          || gameContext?.weather !== null
          || lineupSpot !== null,
        calibrationScore: calibrationStrength,
        contextLayers: {
          park:       parkFactor !== null,
          weather:    gameContext?.weather != null,
          lineup:     lineupSpot !== null,
          bvp:        bvp !== null,
          gameScript: gameScript !== null,
        },
      });
      projection.confidence = refreshed.confidence;
      projection.confidenceTier = refreshed.tier;
      projection.confidenceComponents = refreshed.components;
    }
  } catch {
    // Calibration unavailable — engine still produces a projection
    // without it. No-op is the right behavior; the spec's "static
    // models die" warning applies, but a missing-data crash is worse.
  }

  return projection;
}

// ---------- Game-script helpers ----------

async function resolvePlayerTeamAbbr(playerId: number): Promise<string | null> {
  const { rows } = await getPool().query<{ abbr: string | null }>(
    `SELECT t.abbreviation AS abbr
       FROM mlb_players p
       LEFT JOIN mlb_teams t ON t.id = p.team_id
      WHERE p.id = $1`,
    [playerId],
  );
  return rows[0]?.abbr ?? null;
}

async function resolveOpponentAbbr(
  gamePk: number,
  playerTeamAbbr: string | null,
): Promise<string | null> {
  if (!playerTeamAbbr) return null;
  // Pull both teams from the game; whichever isn't the player's
  // team is the opponent.
  const { rows } = await getPool().query<{
    home_abbr: string | null;
    away_abbr: string | null;
  }>(
    `SELECT ht.abbreviation AS home_abbr, at.abbreviation AS away_abbr
       FROM mlb_games g
       LEFT JOIN mlb_teams ht ON ht.id = g.home_team_id
       LEFT JOIN mlb_teams at ON at.id = g.away_team_id
      WHERE g.id = $1`,
    [gamePk],
  );
  const r = rows[0];
  if (!r) return null;
  if (r.home_abbr === playerTeamAbbr) return r.away_abbr;
  if (r.away_abbr === playerTeamAbbr) return r.home_abbr;
  return null;
}

function inferGameDateFromContext(_gc: GameContext): string | undefined {
  // The current GameContext type doesn't expose game_date directly.
  // Default to today; the orchestrator caller can pass a specific
  // date as a future enhancement when projecting historical games.
  return undefined;
}

// Re-export error classes so route handlers can switch on them.
export { MlbPlayerNotFoundError, MlbStatTypeMismatchError };

// ---------- Baselines ----------

type Baselines = {
  seasonAverage: number | null;
  seasonGames: number;
  opponentAverage: number | null;
  opponentGames: number;
  homeAverage: number | null;
  awayAverage: number | null;
  // Per-game stat values, ordered most-recent first. Powers the L1
  // robust baseline (L30/L20/L10/L5/median/trimmedMean blend).
  orderedValues: number[];
};

async function loadHittingBaselines(
  playerId: number,
  statKey: MlbHitterStatKey,
  opponentTeamId: number | undefined,
): Promise<Baselines> {
  // JOIN mlb_games so we can order by game_date DESC. Ordered
  // values feed the L1 robust baseline; unordered aggregates feed
  // home/away/opponent splits.
  const { rows } = await getPool().query<{
    is_home: boolean | null;
    opponent_team_id: number | null;
    hits: number | null;
    singles: number | null;
    doubles: number | null;
    triples: number | null;
    home_runs: number | null;
    total_bases: number | null;
    runs: number | null;
    rbis: number | null;
    walks: number | null;
    strikeouts: number | null;
    stolen_bases: number | null;
  }>(
    `SELECT s.is_home, s.opponent_team_id,
            s.hits, s.singles, s.doubles, s.triples, s.home_runs, s.total_bases,
            s.runs, s.rbis, s.walks, s.strikeouts, s.stolen_bases
       FROM mlb_hitting_stats s
       JOIN mlb_games g ON g.id = s.game_id
      WHERE s.player_id = $1
      ORDER BY g.game_date DESC`,
    [playerId],
  );

  return reduceBaselines(rows, opponentTeamId, (r) =>
    valueFromHittingRow(statKey, r as HittingRow));
}

async function loadPitchingBaselines(
  playerId: number,
  statKey: MlbPitcherStatKey,
  opponentTeamId: number | undefined,
): Promise<Baselines> {
  const { rows } = await getPool().query<{
    is_home: boolean | null;
    opponent_team_id: number | null;
    outs_recorded: number | null;
    innings_pitched: string | null;
    pitches_thrown: number | null;
    hits_allowed: number | null;
    earned_runs_allowed: number | null;
    walks_allowed: number | null;
    strikeouts: number | null;
    home_runs_allowed: number | null;
  }>(
    `SELECT s.is_home, s.opponent_team_id,
            s.outs_recorded, s.innings_pitched, s.pitches_thrown, s.hits_allowed,
            s.earned_runs_allowed, s.walks_allowed, s.strikeouts, s.home_runs_allowed
       FROM mlb_pitching_stats s
       JOIN mlb_games g ON g.id = s.game_id
      WHERE s.player_id = $1
      ORDER BY g.game_date DESC`,
    [playerId],
  );

  return reduceBaselines(rows, opponentTeamId, (r) =>
    valueFromPitchingRow(statKey, r as unknown as Parameters<typeof valueFromPitchingRow>[1]));
}

function reduceBaselines<R extends { is_home: boolean | null; opponent_team_id: number | null }>(
  rows: R[],
  opponentTeamId: number | undefined,
  toValue: (r: R) => number | null,
): Baselines {
  // rows arrive ordered most-recent first (per the SQL ORDER BY).
  // `all` preserves that order — feeds the L1 robust baseline windows.
  const all: number[] = [];
  const opp: number[] = [];
  const home: number[] = [];
  const away: number[] = [];
  for (const r of rows) {
    const v = toValue(r);
    if (v === null) continue;
    all.push(v);
    if (opponentTeamId !== undefined && r.opponent_team_id === opponentTeamId) {
      opp.push(v);
    }
    if (r.is_home === true) home.push(v);
    else if (r.is_home === false) away.push(v);
  }
  return {
    seasonAverage: all.length > 0 ? avg(all) : null,
    seasonGames: all.length,
    opponentAverage: opp.length > 0 ? avg(opp) : null,
    opponentGames: opp.length,
    homeAverage: home.length > 0 ? avg(home) : null,
    awayAverage: away.length > 0 ? avg(away) : null,
    orderedValues: all,         // most-recent first per the SQL ORDER BY
  };
}

function avg(nums: number[]): number {
  let s = 0;
  for (const n of nums) s += n;
  return s / nums.length;
}
