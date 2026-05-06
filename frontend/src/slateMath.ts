// Frontend mirror of the backend's slate math helpers. Lets us preview a
// hit probability the moment a user types a line, without a server hop.
// Keep these in sync with the backend `comparisonEngine` / `last10` /
// `STAT_MAP` definitions.

import type { PlayerGame } from './api';

export const SLATE_STAT_OPTIONS: string[] = [
  'Points',
  'Rebounds',
  'Assists',
  'Pts+Rebs+Asts',
  'Pts+Rebs',
  'Pts+Asts',
  'Rebs+Asts',
  '3-PT Made',
  'Steals',
  'Blocked Shots',
  'Turnovers',
  'Blks+Stls',
  'FG Made',
  'FG Attempted',
  'Free Throws Made',
  'Free Throws Attempted',
  'Offensive Rebounds',
  'Defensive Rebounds',
  'Personal Fouls',
  'Double-Double',
];

// Mirrors backend STAT_MAP. Returns the per-game numeric value for any
// of the 16 canonical stat labels we offer in the manual-entry grid.
export const STAT_TO_VALUE: Record<string, (g: PlayerGame) => number> = {
  'Points': (g) => g.points,
  'Rebounds': (g) => g.rebounds,
  'Assists': (g) => g.assists,
  'Pts+Rebs+Asts': (g) => g.points + g.rebounds + g.assists,
  'Pts+Rebs': (g) => g.points + g.rebounds,
  'Pts+Asts': (g) => g.points + g.assists,
  'Rebs+Asts': (g) => g.rebounds + g.assists,
  '3-PT Made': (g) => g.fg3m ?? 0,
  'Steals': (g) => g.steals,
  'Blocked Shots': (g) => g.blocks,
  'Turnovers': (g) => g.turnovers,
  'Blks+Stls': (g) => g.blocks + g.steals,
  'FG Made': (g) => g.fgm ?? 0,
  'FG Attempted': (g) => g.fga ?? 0,
  'Free Throws Made': (g) => g.ftm ?? 0,
  'Free Throws Attempted': (g) => g.fta ?? 0,
  'Offensive Rebounds': (g) => g.oreb ?? 0,
  'Defensive Rebounds': (g) => g.dreb ?? 0,
  'Personal Fouls': (g) => g.pf ?? 0,
  'Double-Double': (g) => (isDDGame(g) ? 1 : 0),
};

export function isDDGame(g: PlayerGame): boolean {
  let n = 0;
  if (g.points >= 10) n++;
  if (g.rebounds >= 10) n++;
  if (g.assists >= 10) n++;
  if (g.steals >= 10) n++;
  if (g.blocks >= 10) n++;
  return n >= 2;
}

// Standard normal CDF via Abramowitz & Stegun. Same form as the backend.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function popStdDev(xs: number[], m: number): number {
  if (xs.length === 0) return 0;
  const v = xs.reduce((acc, x) => acc + (x - m) * (x - m), 0) / xs.length;
  return Math.sqrt(v);
}

export type LiveHitProb = {
  mightHitPct: number;
  lean: 'OVER' | 'UNDER';
  hitOver: number;     // historical rate for receipts
};

// Same blend as backend: 50/50 historical-hit-rate + normal-CDF prob.
export function computeHitProbability(values: number[], line: number): LiveHitProb {
  if (values.length === 0) {
    return { mightHitPct: 50, lean: 'OVER', hitOver: 0 };
  }
  const hitOver = values.filter((v) => v > line).length / values.length;
  const hitUnder = values.filter((v) => v < line).length / values.length;
  const m = mean(values);
  const sd = Math.max(popStdDev(values, m), 0.5);
  const z = (line - m) / sd;
  const pOver = 1 - normalCdf(z);
  const pUnder = 1 - pOver;
  const overBlend = (hitOver + pOver) / 2;
  const underBlend = (hitUnder + pUnder) / 2;
  const lean = overBlend >= underBlend ? 'OVER' : 'UNDER';
  const mightHitPct = Math.round(100 * Math.max(overBlend, underBlend));
  return { mightHitPct, lean, hitOver };
}

// Build the sample we should run hit-prob over: last-10 + every season
// game vs the chosen opponent, dedup'd by gameId. Matches the backend's
// resolver so the live preview equals what you see after Build slate.
export function blendedSample(
  gameLog: PlayerGame[],
  opponentAbbr: string | null | undefined,
): PlayerGame[] {
  const last10 = gameLog.slice(0, 10);
  if (!opponentAbbr) return last10;
  const vsOpp = gameLog.filter((g) => g.opponentAbbr === opponentAbbr);
  if (vsOpp.length === 0) return last10;
  const seen = new Set<string>();
  const merged: PlayerGame[] = [];
  for (const g of [...last10, ...vsOpp]) {
    if (seen.has(g.gameId)) continue;
    seen.add(g.gameId);
    merged.push(g);
  }
  return merged;
}

export type SuggestedLine = {
  stat: string;
  line: number;          // typical half-step PP-style line
  mightHitPct: number;   // 0-100
  lean: 'OVER' | 'UNDER';
  hitOver: number;       // 0-1, hit ratio over the blended sample
  sampleSize: number;    // games used in the blend
  avg: number;           // blended-sample avg (for the receipts copy)
  vsOppCount: number;    // # of vs-opp games in the blend (informational)
};

// For a given player + opponent context, scan all 15 numeric stats and
// surface the strongest plays. "Strong" means high mightHitPct over the
// blended L10+vs-opp sample, with a minimum-relevance gate so we don't
// suggest 'Personal Fouls 0.5' just because the player rarely fouls.
//
// Returns up to `topN` candidates sorted strongest-first.
export function suggestStrongLines(
  gameLog: PlayerGame[],
  opponentAbbr: string | null | undefined,
  topN = 3,
): SuggestedLine[] {
  if (gameLog.length === 0) return [];
  const sample = blendedSample(gameLog, opponentAbbr);
  if (sample.length === 0) return [];
  const vsOppCount = opponentAbbr
    ? gameLog.filter((g) => g.opponentAbbr === opponentAbbr).length
    : 0;

  // Per-stat minimum average to even consider — keeps junky 0.5 lines
  // off the suggestion list. Numbers here are deliberately low so we
  // don't filter out viable defensive props for low-usage players.
  const MIN_AVG: Record<string, number> = {
    'Points': 6,
    'Rebounds': 3,
    'Assists': 2,
    'Pts+Rebs+Asts': 12,
    'Pts+Rebs': 9,
    'Pts+Asts': 9,
    'Rebs+Asts': 5,
    '3-PT Made': 1,
    'Steals': 0.7,
    'Blocked Shots': 0.7,
    'Turnovers': 1,
    'Blks+Stls': 1.3,
    'FG Made': 3,
    'Free Throws Made': 1,
    'Personal Fouls': 1.5,
  };

  const candidates: SuggestedLine[] = [];
  for (const stat of SLATE_STAT_OPTIONS) {
    if (stat === 'Double-Double') continue; // no line; surface DD rate elsewhere
    const get = STAT_TO_VALUE[stat];
    const values = sample.map(get);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    if (avg < (MIN_AVG[stat] ?? 0)) continue;

    // Half-step line just below the avg — typical PrizePicks pricing.
    // For very low-avg stats clamp to 0.5 so we never suggest 0.
    const line = Math.max(0.5, Math.floor(avg) + 0.5);

    const hp = computeHitProbability(values, line);
    candidates.push({
      stat,
      line,
      mightHitPct: hp.mightHitPct,
      lean: hp.lean,
      hitOver: hp.hitOver,
      sampleSize: sample.length,
      avg,
      vsOppCount,
    });
  }

  // Sort: strongest first. Tiebreak by lean=OVER (we lean OVER a
  // half-step-below-avg line by design, so an UNDER recommendation at
  // the same pct is suspicious — likely high-variance or trending down).
  candidates.sort((a, b) => {
    if (b.mightHitPct !== a.mightHitPct) return b.mightHitPct - a.mightHitPct;
    if (a.lean !== b.lean) return a.lean === 'OVER' ? -1 : 1;
    return b.avg - a.avg;
  });

  // Drop anything weaker than 60% — at that threshold we're not really
  // giving a "stat edge" anymore, just guessing.
  return candidates.filter((c) => c.mightHitPct >= 60).slice(0, topN);
}
