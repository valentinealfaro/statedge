// StatEdge professional projection engine.
//
// Implements the layered model spec'd in STATEDGE Advanced Projection Engine:
// baseline (avg + median + hit-rate-adjusted) → context multipliers
// (minutes / usage / injury / defense / pace / rest / importance / blowout)
// → distribution-based probability → confidence + risk → user-facing lean.
//
// Inputs are graceful: any factor we lack data for collapses to a neutral
// 1.0 multiplier, the relevant confidence sub-score gets reduced, and the
// model emits a `modelNotes` line explaining the gap. The model never
// invents data and never says "guaranteed" — its top-level output is a
// probabilistic *lean* with a confidence + risk envelope.

import type { PlayerGame } from '../nba/client.js';
import { STAT_MAP, type Last10StatId } from './last10.js';
import { computeNbaFragility } from './nbaFragilityEngine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InjuryStatus = 'Out' | 'Day-To-Day' | 'Questionable' | 'Probable' | null;

export type ProjectionInputs = {
  selectedStat: Exclude<Last10StatId, 'double_double'>;
  lineValue: number;
  // Full season game log (most-recent-first), used to slice every window.
  seasonGames: PlayerGame[];
  // ESPN abbreviation of tonight's opponent — used to build the vs-opp window.
  opponentAbbr?: string | null;
  // True if the player is at home tonight; controls home/away window.
  isHome?: boolean | null;
  // ESPN status for tonight's slate ("Out" short-circuits with `noProjection`).
  playerInjuryStatus?: InjuryStatus;
  // Player has a publicly-known minutes restriction.
  playerMinutesRestriction?: boolean;
  // Counts of injured teammates / opposing players — drive usage adjustments.
  highUsageTeammatesOut?: number;
  startingTeammatesOut?: number;
  opponentKeyDefendersOut?: number;
  opponentRimProtectorsOut?: number;
  // Optional opponent defensive rank (1-30) for the *selected stat*.
  opponentDefensiveRankVsStat?: number | null;
  // Pace inputs (possessions/48). All optional — if absent, neutral.
  teamPace?: number | null;
  opponentPace?: number | null;
  leagueAveragePace?: number | null;
  // Rest context.
  restDays?: number | null;
  isBackToBack?: boolean;
  opponentRestDays?: number | null;
  // Game importance flags.
  isPlayoffGame?: boolean;
  isMustWinGame?: boolean;
  isEliminationGame?: boolean;
  isMeaninglessGame?: boolean;
  isStarPlayer?: boolean;
  // 0-100; if absent, defaults to neutral.
  blowoutRiskScore?: number | null;
};

export type ProjectionResult = {
  selectedStat: Last10StatId;
  lineValue: number;
  projection: {
    baseline: number;
    contextAdjusted: number;
    final: number;
    rangeLow: number;
    rangeHigh: number;
  };
  probability: { over: number; under: number };
  confidence: { score: number; label: string };
  risk: { score: number; label: string };
  edge: { score: number; label: string; lean: string };
  // L5 Fragility — separate from probability and risk. Same dimension
  // as MLB Phase 15 brought to NBA so users see "75% prob 3PM 2.5"
  // doesn't read identical to "75% prob PRA 32.5" — failure modes
  // are very different. NBA-specific component swap:
  // minutesUncertainty replaces MLB's lineupUncertainty.
  fragility: {
    score: number;
    tier: 'Solid Floor' | 'Moderate Fragility' | 'Fragile' | 'Very Fragile';
    components: {
      statRarity: number;
      marginThinness: number;
      sampleWeakness: number;
      volatility: number;
      minutesUncertainty: number | null;
    };
  };
  historicalHitRates: {
    season: number | null;
    last10: number | null;
    last5: number | null;
    vsOpponent: number | null;
    homeAway: number | null;
  };
  factorBreakdown: {
    seasonAvg: number | null;
    last10Avg: number | null;
    last5Avg: number | null;
    vsOpponentAvg: number | null;
    homeAwayAvg: number | null;
    seasonMedian: number | null;
    last10Median: number | null;
    blendedStdDev: number;
    projectedMinutes: number | null;
    minutesMultiplier: number;
    usageMultiplier: number;
    injuryMultiplier: number;
    opponentDefenseMultiplier: number;
    paceMultiplier: number;
    restMultiplier: number;
    gameImportanceMultiplier: number;
    blowoutMultiplier: number;
    modelAgreementScore: number;
  };
  modelNotes: string[];
  disclaimer: string;
  // Sentinel for "do not show this projection" (e.g. player is OUT).
  noProjection?: boolean;
};

// ---------------------------------------------------------------------------
// Stat-level configuration
// ---------------------------------------------------------------------------

// Per the spec — minimum std-dev floors prevent fake 99% probabilities
// from tiny samples. Anything not listed defaults to 1.0 (small-counter
// stats like turnovers, steals, blocks).
const STD_DEV_FLOOR: Partial<Record<Last10StatId, number>> = {
  points: 3.5,
  rebounds: 2.0,
  assists: 2.0,
  pra: 5.0,
  pr: 4.0,
  pa: 4.0,
  ra: 4.0,
  stocks: 1.0,
  three_pt_made: 1.0,
  fg_made: 1.5,
  ft_made: 1.5,
  steals: 1.0,
  blocks: 1.0,
  turnovers: 1.0,
  personal_fouls: 1.0,
  offensive_rebounds: 1.0,
  defensive_rebounds: 1.5,
};

// Stats where pace has a strong effect. For free throws / fouls / FG
// attempts we attenuate (per spec).
const PACE_HEAVY_STATS = new Set<Last10StatId>([
  'points', 'rebounds', 'assists',
  'pra', 'pr', 'pa', 'ra',
  'stocks', 'turnovers',
]);

const STAR_PLAYER_DEFAULT_NOT = false;

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = sorted.length;
  return m % 2 === 1 ? sorted[(m - 1) / 2] : (sorted[m / 2 - 1] + sorted[m / 2]) / 2;
}

// Robust mean — drop the most extreme values from each tail before
// averaging. Reduces the influence of outlier games (a 50-point
// explosion or a 4-minute foul-out) on the projection. For samples
// too small to trim (<5), falls back to the arithmetic mean.
function trimmedMean(xs: number[], trimFraction = 0.1): number {
  if (xs.length === 0) return 0;
  if (xs.length < 5) return mean(xs);
  const sorted = [...xs].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * trimFraction);
  const window = trim > 0 ? sorted.slice(trim, sorted.length - trim) : sorted;
  return mean(window);
}

// Bayesian shrinkage — pull an observed mean toward a stronger-signal
// prior. `priorStrength` represents "as if I had observed this many
// games of the prior estimate". When the observed sample (n) is small
// relative to priorStrength, the prior dominates; as n grows, the
// observation takes over.
//
// Used to keep small windows (L5, single-game vs-opp samples) from
// pushing the projection too far when their evidence is thin.
function bayesianShrink(
  observed: number,
  observedN: number,
  prior: number,
  priorStrength: number,
): number {
  if (observedN <= 0) return prior;
  return (observed * observedN + prior * priorStrength) / (observedN + priorStrength);
}

function popStdDev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  const v = xs.reduce((acc, x) => acc + (x - m) * (x - m), 0) / xs.length;
  return Math.sqrt(v);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Abramowitz & Stegun 26.2.17 standard normal CDF.
// Exported so the line-raising helper in slateCombos can re-derive
// probability at alternate lines without re-running the full projection.
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const p = d * t * (
    0.31938153 + t * (
      -0.356563782 + t * (
        1.781477937 + t * (
          -1.821255978 + t * 1.330274429
        )
      )
    )
  );
  return z >= 0 ? 1 - p : p;
}

function hitRateOver(values: number[], line: number): number | null {
  if (values.length === 0) return null;
  return values.filter((v) => v > line).length / values.length;
}

function valuesFor(games: PlayerGame[], stat: Exclude<Last10StatId, 'double_double'>): number[] {
  const get = STAT_MAP[stat];
  return games.map(get);
}

// Robust window score — blends arithmetic mean, trimmed mean, median,
// and a hit-rate-adjusted value. Trimmed mean reduces outlier
// distortion (one 50-point explosion or a 4-minute foul-out can swing
// a small sample); arithmetic mean keeps directional sensitivity;
// median anchors central tendency; hit-rate adjustment shifts the
// estimate toward the side of the line the player has historically
// landed on.
//
// Returns null when the window is empty.
function windowScore(
  values: number[],
  line: number,
): {
  score: number;
  avg: number;
  med: number;
  trimmed: number;
  hitRate: number;
  n: number;
} | null {
  if (values.length === 0) return null;
  const avg = mean(values);
  const med = median(values);
  const trimmed = trimmedMean(values);
  const hitRate = values.filter((v) => v > line).length / values.length;
  const hitRateEdge = hitRate - 0.5;
  const hitRateAdjustment = line * hitRateEdge * 0.10;
  const hitRateAdjustedValue = avg + hitRateAdjustment;
  // Weights total 1.0. Trimmed mean and median together (0.55) carry
  // the bulk of the central-tendency signal so outliers don't drive
  // the score; mean (0.30) keeps the trend-direction weight up; the
  // hit-rate adjustment (0.15) pulls toward whichever side of the
  // line the values have historically landed on.
  const score =
    trimmed * 0.30 +
    avg * 0.30 +
    med * 0.25 +
    hitRateAdjustedValue * 0.15;
  return { score, avg, med, trimmed, hitRate, n: values.length };
}

// ---------------------------------------------------------------------------
// Projection — orchestrator
// ---------------------------------------------------------------------------

export function project(inp: ProjectionInputs): ProjectionResult {
  const notes: string[] = [];
  const stat = inp.selectedStat;
  const line = inp.lineValue;
  const allGames = inp.seasonGames ?? [];

  // Hard short-circuit: player listed as Out — the spec says return
  // "no projection". We still emit a stub object so callers can render
  // a clean placeholder.
  if (inp.playerInjuryStatus === 'Out') {
    return makeNoProjection(stat, line, 'Player is listed as OUT — no projection.');
  }

  if (allGames.length === 0) {
    return makeNoProjection(stat, line, 'No game log available for this player.');
  }

  // -------------------------------------------------------------------------
  // Layer 1 — Baselines per window (season / L10 / L5 / vs-opp / home-away)
  // -------------------------------------------------------------------------
  const seasonValues = valuesFor(allGames, stat);
  const last10 = allGames.slice(0, 10);
  const last10Values = valuesFor(last10, stat);
  const last5 = allGames.slice(0, 5);
  const last5Values = valuesFor(last5, stat);

  const oppGames = inp.opponentAbbr
    ? allGames.filter((g) => g.opponentAbbr === inp.opponentAbbr)
    : [];
  const oppValues = valuesFor(oppGames, stat);

  const homeAwayGames = inp.isHome === null || inp.isHome === undefined
    ? []
    : allGames.filter((g) => g.isHome === inp.isHome);
  const homeAwayValues = valuesFor(homeAwayGames, stat);

  const seasonW = windowScore(seasonValues, line);
  const last10W = windowScore(last10Values, line);
  const last5W = windowScore(last5Values, line);
  const oppW = windowScore(oppValues, line);
  const homeAwayW = windowScore(homeAwayValues, line);

  // Usage/minutes baseline — per-minute production × projected minutes.
  const seasonMin = mean(allGames.map((g) => g.minutes ?? 0));
  const last10Min = mean(last10.map((g) => g.minutes ?? 0));
  const seasonAvg = seasonW?.avg ?? 0;
  const last10Avg = last10W?.avg ?? 0;
  const seasonPerMin = seasonMin > 0 ? seasonAvg / seasonMin : 0;
  const last10PerMin = last10Min > 0 ? last10Avg / last10Min : 0;
  const blendedPerMin = seasonPerMin * 0.45 + last10PerMin * 0.55;

  // Projected minutes — blend, then adjust for injury / B2B / blowout
  // / restriction. Clamp to ±25% of season average.
  let projectedMinutes = seasonMin * 0.35 + last10Min * 0.65;
  if (inp.playerInjuryStatus === 'Questionable') projectedMinutes *= 0.85;
  else if (inp.playerInjuryStatus === 'Day-To-Day') projectedMinutes *= 0.92;
  if (inp.playerMinutesRestriction) projectedMinutes *= 0.70;
  if (inp.isBackToBack) projectedMinutes *= 0.96;
  if ((inp.blowoutRiskScore ?? 0) >= 80) projectedMinutes *= 0.90;
  else if ((inp.blowoutRiskScore ?? 0) >= 65) projectedMinutes *= 0.95;
  if (seasonMin > 0) {
    projectedMinutes = clamp(projectedMinutes, seasonMin * 0.7, seasonMin * 1.25);
  }

  const usageMinutesScore = blendedPerMin * projectedMinutes;

  // -------------------------------------------------------------------------
  // Dynamic weight redistribution
  // -------------------------------------------------------------------------
  // Default weights per spec
  let wSeason = 0.22;
  let wL10 = 0.26;
  let wL5 = 0.18;
  let wOpp = 0.14;
  let wHA = 0.10;
  let wUsage = 0.10;

  // Reduce vs-opp weight by sample-size buckets, redistribute to season/L10/HA.
  const oppN = oppValues.length;
  const oppTargetW = oppN <= 0 ? 0 : oppN <= 2 ? 0.04 : oppN <= 4 ? 0.08 : 0.14;
  const oppShortfall = wOpp - oppTargetW;
  wOpp = oppTargetW;
  // Distribute the shortfall: 50% to L10, 30% to season, 20% to HA.
  wL10 += oppShortfall * 0.5;
  wSeason += oppShortfall * 0.3;
  wHA += oppShortfall * 0.2;
  if (oppN === 0) {
    notes.push('No prior matchups vs this opponent — vs-opp weight redistributed.');
  } else if (oppN <= 2) {
    notes.push(`Only ${oppN} game${oppN === 1 ? '' : 's'} vs this opponent — vs-opp weight reduced.`);
  }

  // Drop H/A weight if we have <5 games on that split.
  if (homeAwayValues.length < 5) {
    const haShortfall = wHA;
    wHA = 0;
    wL10 += haShortfall * 0.6;
    wSeason += haShortfall * 0.4;
    if (inp.isHome !== null && inp.isHome !== undefined) {
      notes.push(`Home/away split sample <5 — weight redistributed.`);
    }
  }

  // Drop minutes/usage weight if minutes data is missing.
  if (seasonMin === 0 || last10Min === 0) {
    const usageShortfall = wUsage;
    wUsage = 0;
    wSeason += usageShortfall * 0.5;
    wL10 += usageShortfall * 0.5;
    notes.push('Minutes data missing — usage weight redistributed.');
  }

  // -------------------------------------------------------------------------
  // Bayesian shrinkage on small-sample windows
  // -------------------------------------------------------------------------
  // Last-5 and vs-opponent are the noisiest windows in the blend
  // (n=5 always for L5; vs-opp can be 1-4 games). Without shrinkage,
  // a single hot streak or a freak matchup game can push the
  // projection by an unrealistic amount. We pull these scores back
  // toward a longer-baseline prior — L5 → L10 (or season fallback),
  // vs-opp → season — using sample-size-aware shrinkage. Larger
  // priorStrength = more pull toward the prior.
  // Helper — true when the shrinkage moves the estimate by enough to
  // be worth telling the user about. Either ≥1.0 in stat units (a
  // single point of points or rebound) OR ≥5% relative — whichever
  // fires first. Below that, the shrinkage is just noise damping.
  const meaningfulShrink = (before: number, after: number): boolean => {
    const abs = Math.abs(after - before);
    return abs >= 1.0 || abs / Math.max(1, Math.abs(before)) >= 0.05;
  };

  let last5Score = last5W?.score ?? null;
  if (last5W) {
    const prior = last10W?.score ?? seasonW?.score ?? null;
    if (prior !== null) {
      const shrunk = bayesianShrink(last5W.score, last5W.n, prior, 8);
      if (meaningfulShrink(last5W.score, shrunk)) {
        notes.push('L5 estimate pulled toward longer-baseline (Bayesian shrinkage).');
      }
      last5Score = shrunk;
    }
  }

  let oppScore = oppW?.score ?? null;
  if (oppW && seasonW) {
    const shrunk = bayesianShrink(oppW.score, oppW.n, seasonW.score, 6);
    if (meaningfulShrink(oppW.score, shrunk)) {
      notes.push(
        oppW.n <= 2
          ? `Vs-opp estimate (only ${oppW.n} game${oppW.n === 1 ? '' : 's'}) shrunk toward season baseline.`
          : 'Vs-opp estimate shrunk toward season baseline.',
      );
    }
    oppScore = shrunk;
  }

  // -------------------------------------------------------------------------
  // Layer 1 — Baseline projection
  // -------------------------------------------------------------------------
  const baselineProjection =
    (seasonW?.score ?? seasonAvg) * wSeason +
    (last10W?.score ?? last10Avg) * wL10 +
    (last5Score ?? last10Avg) * wL5 +
    (oppScore ?? 0) * wOpp +
    (homeAwayW?.score ?? 0) * wHA +
    usageMinutesScore * wUsage;

  // -------------------------------------------------------------------------
  // Layer 2 — Context multipliers
  // -------------------------------------------------------------------------
  const minutesMultiplier = seasonMin > 0
    ? clamp(projectedMinutes / seasonMin, 0.75, 1.25)
    : 1.0;

  // Usage
  let usageMultiplier = 1.0;
  usageMultiplier += (inp.highUsageTeammatesOut ?? 0) * 0.06;
  usageMultiplier += (inp.startingTeammatesOut ?? 0) * 0.03;
  usageMultiplier = clamp(usageMultiplier, 0.80, 1.18);
  if ((inp.highUsageTeammatesOut ?? 0) > 0) {
    notes.push(`${inp.highUsageTeammatesOut} high-usage teammate${inp.highUsageTeammatesOut === 1 ? '' : 's'} out — usage trends up.`);
  }

  // Injury
  let injuryMultiplier = 1.0;
  if (inp.playerInjuryStatus === 'Questionable') {
    injuryMultiplier -= 0.12;
    notes.push('Player listed Questionable — projection reduced.');
  } else if (inp.playerInjuryStatus === 'Day-To-Day') {
    injuryMultiplier -= 0.06;
    notes.push('Player listed Day-To-Day — projection slightly reduced.');
  } else if (inp.playerInjuryStatus === 'Probable') {
    injuryMultiplier -= 0.03;
  }
  if (inp.playerMinutesRestriction) {
    injuryMultiplier -= 0.25;
    notes.push('Minutes restriction reported — projection cut sharply.');
  }
  if ((inp.opponentKeyDefendersOut ?? 0) > 0) injuryMultiplier += 0.04;
  if ((inp.opponentRimProtectorsOut ?? 0) > 0 &&
      (['points', 'rebounds', 'pra', 'pr', 'fg_made'] as Last10StatId[]).includes(stat)) {
    injuryMultiplier += 0.05;
    notes.push("Opponent's rim protector(s) out — interior production projects up.");
  }
  injuryMultiplier = clamp(injuryMultiplier, 0.70, 1.12);

  // Opponent defense — only applied when we know the rank.
  let opponentDefenseMultiplier = 1.0;
  if (inp.opponentDefensiveRankVsStat) {
    opponentDefenseMultiplier = defenseRankMultiplier(inp.opponentDefensiveRankVsStat);
    if (opponentDefenseMultiplier <= 0.95) {
      notes.push(`Opponent ranks top-10 defensively vs ${stat} — projection trimmed.`);
    } else if (opponentDefenseMultiplier >= 1.05) {
      notes.push(`Opponent is bottom-10 defensively vs ${stat} — projection bumped up.`);
    }
  }

  // Pace
  let paceMultiplier = 1.0;
  if (inp.teamPace && inp.opponentPace && inp.leagueAveragePace) {
    const pace = (inp.teamPace + inp.opponentPace) / 2;
    let raw = pace / inp.leagueAveragePace;
    if (!PACE_HEAVY_STATS.has(stat)) {
      // Attenuate the effect on FT / fouls / attempts-only stats.
      raw = 1 + (raw - 1) * 0.4;
    }
    paceMultiplier = clamp(raw, 0.94, 1.06);
  }

  // Rest
  let restMultiplier = 1.0;
  if (inp.isBackToBack) { restMultiplier -= 0.04; notes.push('Back-to-back — small fatigue penalty.'); }
  if (inp.restDays === 0) restMultiplier -= 0.04;
  if ((inp.restDays ?? 0) >= 3) restMultiplier += 0.02;
  if ((inp.opponentRestDays ?? 0) >= (inp.restDays ?? 0) + 2) restMultiplier -= 0.02;
  if ((inp.restDays ?? 0) >= (inp.opponentRestDays ?? 0) + 2) restMultiplier += 0.02;
  restMultiplier = clamp(restMultiplier, 0.94, 1.04);

  // Importance
  let gameImportanceMultiplier = 1.0;
  const isStar = inp.isStarPlayer ?? STAR_PLAYER_DEFAULT_NOT;
  if (inp.isPlayoffGame && isStar) gameImportanceMultiplier += 0.05;
  if (inp.isEliminationGame && isStar) gameImportanceMultiplier += 0.07;
  if (inp.isMustWinGame && isStar) gameImportanceMultiplier += 0.04;
  if (inp.isMeaninglessGame) {
    gameImportanceMultiplier -= 0.08;
    notes.push('Game has no playoff implications — late-game minutes risk.');
  }
  gameImportanceMultiplier = clamp(gameImportanceMultiplier, 0.90, 1.12);

  // Blowout
  let blowoutMultiplier = 1.0;
  const blowout = inp.blowoutRiskScore ?? null;
  if (blowout !== null) {
    if (blowout >= 80) {
      blowoutMultiplier = 0.92;
      notes.push('High blowout risk — fourth-quarter minutes likely thin.');
    } else if (blowout >= 65) {
      blowoutMultiplier = 0.96;
    }
  }

  const contextAdjusted =
    baselineProjection *
    minutesMultiplier *
    usageMultiplier *
    injuryMultiplier *
    opponentDefenseMultiplier *
    paceMultiplier *
    restMultiplier *
    gameImportanceMultiplier *
    blowoutMultiplier;

  // -------------------------------------------------------------------------
  // Layer 3 — Probability
  // -------------------------------------------------------------------------
  const seasonSd = popStdDev(seasonValues);
  const l10Sd = popStdDev(last10Values);
  const l5Sd = popStdDev(last5Values);
  const oppSd = oppValues.length >= 3 ? popStdDev(oppValues) : 0;

  // Blend per spec, redistributing if opp sample is too small.
  let blendedStdDev: number;
  if (oppSd > 0) {
    blendedStdDev = seasonSd * 0.35 + l10Sd * 0.40 + l5Sd * 0.15 + oppSd * 0.10;
  } else {
    blendedStdDev = seasonSd * 0.39 + l10Sd * 0.44 + l5Sd * 0.17;
  }
  const floor = STD_DEV_FLOOR[stat] ?? 1.0;
  blendedStdDev = Math.max(blendedStdDev, floor);

  const z = (line - contextAdjusted) / blendedStdDev;
  const overP = 1 - normalCdf(z);
  const overProbability = Math.round(clamp(overP, 0.01, 0.99) * 100);
  const underProbability = 100 - overProbability;

  // Projected range: ±1 SD around the context-adjusted projection.
  const rangeLow = Math.max(0, contextAdjusted - blendedStdDev);
  const rangeHigh = contextAdjusted + blendedStdDev;

  // -------------------------------------------------------------------------
  // Historical hit rates
  // -------------------------------------------------------------------------
  const historicalHitRates = {
    season: seasonW ? Math.round(seasonW.hitRate * 100) : null,
    last10: last10W ? Math.round(last10W.hitRate * 100) : null,
    last5: last5W ? Math.round(last5W.hitRate * 100) : null,
    vsOpponent: oppW ? Math.round(oppW.hitRate * 100) : null,
    homeAway: homeAwayW ? Math.round(homeAwayW.hitRate * 100) : null,
  };

  // -------------------------------------------------------------------------
  // Model agreement — what % of windows agree on direction vs the line.
  // -------------------------------------------------------------------------
  const directionalScores = [seasonW, last10W, last5W, oppW, homeAwayW]
    .filter((w): w is NonNullable<typeof w> => w !== null);
  const overAgree = directionalScores.filter((w) => w.score > line).length;
  const underAgree = directionalScores.filter((w) => w.score < line).length;
  const dominant = Math.max(overAgree, underAgree);
  const modelAgreementScore = directionalScores.length > 0
    ? Math.round((dominant / directionalScores.length) * 100)
    : 0;

  // -------------------------------------------------------------------------
  // Confidence
  // -------------------------------------------------------------------------
  let dataQualityScore = 0;
  if (seasonValues.length >= 20) dataQualityScore += 25;
  else if (seasonValues.length >= 10) dataQualityScore += 15;
  if (last10Values.length === 10) dataQualityScore += 20;
  else if (last10Values.length >= 5) dataQualityScore += 10;
  if (last5Values.length === 5) dataQualityScore += 15;
  if (oppValues.length >= 5) dataQualityScore += 15;
  else if (oppValues.length >= 3) dataQualityScore += 8;
  if (homeAwayValues.length >= 5) dataQualityScore += 10;
  if (inp.playerInjuryStatus !== undefined) dataQualityScore += 10;
  if (inp.opponentDefensiveRankVsStat || (inp.teamPace && inp.opponentPace)) dataQualityScore += 5;
  dataQualityScore = clamp(dataQualityScore, 0, 100);

  const totalRelevantGames = seasonValues.length + last10Values.length + oppValues.length;
  const sampleSizeScore = clamp((totalRelevantGames / 20) * 100, 0, 100);

  // Consistency = inverse of coefficient-of-variation, scaled.
  const cv = last10Avg > 0 ? l10Sd / last10Avg : 1;
  const consistencyScore = clamp(100 - cv * 100, 0, 100);

  let injuryCertaintyScore = 80;
  if (inp.playerInjuryStatus === undefined || inp.playerInjuryStatus === null) injuryCertaintyScore = 75;
  else if (inp.playerInjuryStatus === 'Probable') injuryCertaintyScore = 90;
  else if (inp.playerInjuryStatus === 'Day-To-Day') injuryCertaintyScore = 60;
  else if (inp.playerInjuryStatus === 'Questionable') injuryCertaintyScore = 45;

  const edgeAbs = Math.abs(contextAdjusted - line);
  const lineDistanceScore = clamp((edgeAbs / blendedStdDev) * 100, 0, 100);

  const confidenceScore = Math.round(
    dataQualityScore * 0.25 +
    sampleSizeScore * 0.20 +
    consistencyScore * 0.20 +
    modelAgreementScore * 0.20 +
    injuryCertaintyScore * 0.10 +
    lineDistanceScore * 0.05,
  );

  // -------------------------------------------------------------------------
  // Risk
  // -------------------------------------------------------------------------
  const volatilityRisk = clamp(cv * 100, 0, 100);
  const injuryRisk = inp.playerInjuryStatus === 'Questionable' ? 70
    : inp.playerInjuryStatus === 'Day-To-Day' ? 50
    : inp.playerMinutesRestriction ? 80
    : 15;
  const sampleRisk = clamp(100 - sampleSizeScore, 0, 100);
  const roleRisk = (inp.highUsageTeammatesOut ?? 0) > 0 || (inp.startingTeammatesOut ?? 0) > 0 ? 35 : 20;
  const blowoutRisk = blowout ?? 30;

  const riskScore = Math.round(
    volatilityRisk * 0.30 +
    injuryRisk * 0.25 +
    sampleRisk * 0.20 +
    roleRisk * 0.15 +
    blowoutRisk * 0.10,
  );

  // -------------------------------------------------------------------------
  // Lean + Edge
  // -------------------------------------------------------------------------
  let lean: string;
  if (overProbability >= 62 && confidenceScore >= 65 && riskScore <= 60) lean = 'Strong Over Lean';
  else if (overProbability >= 57 && confidenceScore >= 55 && riskScore <= 70) lean = 'Slight Over Lean';
  else if (underProbability >= 62 && confidenceScore >= 65 && riskScore <= 60) lean = 'Strong Under Lean';
  else if (underProbability >= 57 && confidenceScore >= 55 && riskScore <= 70) lean = 'Slight Under Lean';
  else lean = 'No Clear Edge';

  const probabilityEdge = Math.abs(overProbability - 50) * 2;
  const projectionEdge = clamp((edgeAbs / blendedStdDev) * 100, 0, 100);
  const historicalHitScore =
    (historicalHitRates.season ?? 50) * 0.25 +
    (historicalHitRates.last10 ?? 50) * 0.30 +
    (historicalHitRates.last5 ?? 50) * 0.20 +
    (historicalHitRates.vsOpponent ?? 50) * 0.15 +
    (historicalHitRates.homeAway ?? 50) * 0.10;

  const edgeScore = Math.round(clamp(
    probabilityEdge * 0.35 +
    projectionEdge * 0.25 +
    historicalHitScore * 0.20 +
    confidenceScore * 0.15 -
    riskScore * 0.05,
    0, 100,
  ));

  // -------------------------------------------------------------------------
  // Auto-generated model notes (extra colour beyond what we already pushed)
  // -------------------------------------------------------------------------
  if (last10W && last10W.score > line) notes.push('Last 10 average is above the line.');
  else if (last10W && last10W.score < line) notes.push('Last 10 average is below the line.');
  if (last5W && last10W && last5W.score > last10W.score + 0.5) {
    notes.push('Last 5 trending up vs last 10 — recent form supports the over.');
  } else if (last5W && last10W && last5W.score < last10W.score - 0.5) {
    notes.push('Last 5 trending down vs last 10 — recent form supports the under.');
  }
  if (oppW && oppW.score > line) notes.push(`Vs ${inp.opponentAbbr}: ${oppW.n}-game avg ${oppW.avg.toFixed(1)} clears the line.`);
  else if (oppW && oppW.score < line) notes.push(`Vs ${inp.opponentAbbr}: ${oppW.n}-game avg ${oppW.avg.toFixed(1)} below the line.`);
  if (Math.abs(contextAdjusted - line) >= 1) {
    notes.push(`Projection (${contextAdjusted.toFixed(1)}) is ${Math.abs(contextAdjusted - line).toFixed(1)} ${contextAdjusted > line ? 'above' : 'below'} the selected line.`);
  } else {
    notes.push('Projection sits within 1.0 of the line — coin-flip territory.');
  }
  if (sampleSizeScore < 50) notes.push('Sample size is light — interpret confidence cautiously.');

  // L5 Fragility — composite of stat rarity, margin thinness, sample
  // weakness, volatility, and minutes uncertainty. Same dimension MLB
  // shipped in Phase 15. Computed here so the result carries it for
  // the UI's "Fragility breakdown" panel.
  const fragilityRaw = computeNbaFragility({
    statKey: stat,
    projection: contextAdjusted,
    line,
    stddev: blendedStdDev,
    last10Size: last10W?.n ?? 0,
    projectedMinutes: seasonMin > 0 ? projectedMinutes : null,
  });
  const fragility = {
    score: fragilityRaw.fragility,
    tier: fragilityRaw.tier,
    components: fragilityRaw.components,
  };

  return {
    selectedStat: stat,
    lineValue: line,
    projection: {
      baseline: round(baselineProjection, 2),
      contextAdjusted: round(contextAdjusted, 2),
      final: round(contextAdjusted, 2),
      rangeLow: round(rangeLow, 2),
      rangeHigh: round(rangeHigh, 2),
    },
    probability: { over: overProbability, under: underProbability },
    confidence: { score: confidenceScore, label: confidenceLabel(confidenceScore) },
    risk: { score: riskScore, label: riskLabel(riskScore) },
    edge: { score: edgeScore, label: edgeLabel(edgeScore), lean },
    fragility,
    historicalHitRates,
    factorBreakdown: {
      seasonAvg: seasonW ? round(seasonW.avg, 2) : null,
      last10Avg: last10W ? round(last10W.avg, 2) : null,
      last5Avg: last5W ? round(last5W.avg, 2) : null,
      vsOpponentAvg: oppW ? round(oppW.avg, 2) : null,
      homeAwayAvg: homeAwayW ? round(homeAwayW.avg, 2) : null,
      seasonMedian: seasonW ? round(seasonW.med, 2) : null,
      last10Median: last10W ? round(last10W.med, 2) : null,
      blendedStdDev: round(blendedStdDev, 2),
      projectedMinutes: seasonMin > 0 ? round(projectedMinutes, 1) : null,
      minutesMultiplier: round(minutesMultiplier, 3),
      usageMultiplier: round(usageMultiplier, 3),
      injuryMultiplier: round(injuryMultiplier, 3),
      opponentDefenseMultiplier: round(opponentDefenseMultiplier, 3),
      paceMultiplier: round(paceMultiplier, 3),
      restMultiplier: round(restMultiplier, 3),
      gameImportanceMultiplier: round(gameImportanceMultiplier, 3),
      blowoutMultiplier: round(blowoutMultiplier, 3),
      modelAgreementScore,
    },
    modelNotes: notes,
    disclaimer: 'StatEdge provides statistical projections and historical analysis only. This is not financial or gambling advice.',
  };
}

// ---------------------------------------------------------------------------
// Sub-helpers
// ---------------------------------------------------------------------------

function defenseRankMultiplier(rank: number): number {
  if (rank <= 5) return 0.94;
  if (rank <= 10) return 0.97;
  if (rank <= 20) return 1.00;
  if (rank <= 25) return 1.04;
  return 1.07;
}

function confidenceLabel(s: number): string {
  if (s >= 75) return 'Very Strong';
  if (s >= 65) return 'Strong';
  if (s >= 50) return 'Moderate';
  if (s >= 35) return 'Weak';
  return 'Very Weak';
}

function riskLabel(s: number): string {
  if (s >= 76) return 'Extreme Risk';
  if (s >= 56) return 'High Risk';
  if (s >= 31) return 'Medium Risk';
  return 'Low Risk';
}

function edgeLabel(s: number): string {
  if (s >= 75) return 'Elite Edge';
  if (s >= 60) return 'Strong Edge';
  if (s >= 40) return 'Moderate Edge';
  return 'Weak Edge';
}

function round(n: number, p: number): number {
  const f = Math.pow(10, p);
  return Math.round(n * f) / f;
}

function makeNoProjection(stat: Last10StatId, line: number, reason: string): ProjectionResult {
  return {
    selectedStat: stat,
    lineValue: line,
    projection: { baseline: 0, contextAdjusted: 0, final: 0, rangeLow: 0, rangeHigh: 0 },
    probability: { over: 50, under: 50 },
    confidence: { score: 0, label: 'Very Weak' },
    risk: { score: 100, label: 'Extreme Risk' },
    edge: { score: 0, label: 'Weak Edge', lean: 'No Clear Edge' },
    fragility: {
      score: 50,
      tier: 'Moderate Fragility',
      components: {
        statRarity: 50, marginThinness: 50, sampleWeakness: 100, volatility: 50,
        minutesUncertainty: 60,
      },
    },
    historicalHitRates: { season: null, last10: null, last5: null, vsOpponent: null, homeAway: null },
    factorBreakdown: {
      seasonAvg: null, last10Avg: null, last5Avg: null, vsOpponentAvg: null, homeAwayAvg: null,
      seasonMedian: null, last10Median: null, blendedStdDev: 0, projectedMinutes: null,
      minutesMultiplier: 1, usageMultiplier: 1, injuryMultiplier: 1,
      opponentDefenseMultiplier: 1, paceMultiplier: 1, restMultiplier: 1,
      gameImportanceMultiplier: 1, blowoutMultiplier: 1, modelAgreementScore: 0,
    },
    modelNotes: [reason],
    disclaimer: 'StatEdge provides statistical projections and historical analysis only. This is not financial or gambling advice.',
    noProjection: true,
  };
}

// Map a slate stat key (matches Last10StatId) for double_double — DD has
// no projection because it's not a continuous stat. Callers should detect
// and handle DD separately.
export function isProjectable(stat: Last10StatId): stat is Exclude<Last10StatId, 'double_double'> {
  return stat !== 'double_double';
}
