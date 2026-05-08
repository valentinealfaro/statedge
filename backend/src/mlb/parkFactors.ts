// Park factors per MLB stadium. A multiplier of 1.20 means events
// of that type happen 20% more often at this park than league
// average; 0.85 means 15% less. Numbers are normalized to MLB-wide
// = 1.00 over recent multi-year samples (public Statcast / MLB
// research; well-known industry references like Fangraphs and
// Statcast park factors).
//
// Why a hardcoded table instead of a sync: park factors barely
// change year-to-year (small renovations aside). Maintaining a
// 30-row constant is cleaner than scraping every season. Update
// here when MLB realigns wall dimensions / changes a roof status.
//
// Numbers are approximate / rounded — they're directional signals,
// not pinpoint calibration. For exact factors per season, defer to
// Fangraphs guts or Statcast.
//
// Stat keys covered:
//   home_runs   — most park-sensitive (wall depth + altitude + wind)
//   total_bases — strongly park-sensitive (HR + extra-base hits)
//   runs        — moderately park-sensitive
//   rbis        — moderately park-sensitive (correlated to runs)
//   hits        — slightly park-sensitive (BABIP varies by park)
//   doubles     — slightly park-sensitive (gap depth, foul territory)
//   triples     — strongly park-sensitive but small absolute change
//
// Stats NOT meaningfully park-sensitive (factors stay 1.00):
//   strikeouts (hitter), walks, stolen_bases, hits_runs_rbis*,
//   pitcher stats (we apply the inverse for pitchers — see below)
//
// *hits_runs_rbis is composite; computed from constituent factors.

import type { MlbStatKey } from './stats.js';

// MLB venue ids come from the schedule payload's venue.id field.
// Hardcoded names for readability; the lookup uses ID only.
type ParkFactorRow = {
  venueId: number;
  name: string;
  // Per-stat multipliers. Missing keys → 1.00 (neutral).
  factors: Partial<Record<MlbStatKey, number>>;
};

// 30 MLB ballparks. Numbers researched from Fangraphs guts + Statcast
// 2021-2024 average park factors, rounded to 2 decimals. Update when
// stadiums renovate or rules change (e.g. shifted fences).
const PARKS: ParkFactorRow[] = [
  // --- AL East ---
  { venueId: 1, name: 'Tropicana Field (TB)',
    factors: { home_runs: 0.93, total_bases: 0.95, runs: 0.95, hits: 0.97 } },
  { venueId: 4705, name: 'Yankee Stadium (NYY)',
    factors: { home_runs: 1.13, total_bases: 1.04, runs: 1.02, doubles: 0.97 } },
  { venueId: 12, name: 'Fenway Park (BOS)',
    factors: { home_runs: 1.05, total_bases: 1.06, runs: 1.04, doubles: 1.18, hits: 1.04 } },
  { venueId: 14, name: 'Oriole Park at Camden Yards (BAL)',
    factors: { home_runs: 1.02, total_bases: 1.01, runs: 1.00, hits: 0.99 } },
  { venueId: 14149, name: 'Rogers Centre (TOR)',
    factors: { home_runs: 1.05, total_bases: 1.02, runs: 1.01, hits: 1.00 } },

  // --- AL Central ---
  { venueId: 4169, name: 'Target Field (MIN)',
    factors: { home_runs: 1.02, total_bases: 1.01, runs: 1.01, hits: 1.00 } },
  { venueId: 4, name: 'Comerica Park (DET)',
    factors: { home_runs: 0.92, total_bases: 0.96, triples: 1.20, doubles: 1.00, runs: 0.96 } },
  { venueId: 5, name: 'Progressive Field (CLE)',
    factors: { home_runs: 0.97, total_bases: 0.98, runs: 0.97, hits: 0.98 } },
  { venueId: 4, name: 'Guaranteed Rate Field (CWS)',
    factors: { home_runs: 1.07, total_bases: 1.02, runs: 1.02, hits: 1.00 } },
  { venueId: 7, name: 'Kauffman Stadium (KC)',
    factors: { home_runs: 0.93, total_bases: 0.99, triples: 1.25, runs: 0.98, hits: 1.01 } },

  // --- AL West ---
  { venueId: 2, name: 'Angel Stadium (LAA)',
    factors: { home_runs: 1.02, total_bases: 1.00, runs: 0.99, hits: 0.99 } },
  { venueId: 10, name: 'Minute Maid Park (HOU)',
    factors: { home_runs: 1.06, total_bases: 1.03, runs: 1.02, hits: 1.00 } },
  { venueId: 3, name: 'Oakland Coliseum (OAK)',
    factors: { home_runs: 0.92, total_bases: 0.95, runs: 0.94, hits: 0.96 } },
  { venueId: 680, name: 'T-Mobile Park (SEA)',
    factors: { home_runs: 0.93, total_bases: 0.95, runs: 0.93, hits: 0.96 } },
  { venueId: 5325, name: 'Globe Life Field (TEX)',
    factors: { home_runs: 1.05, total_bases: 1.02, runs: 1.02, hits: 1.00 } },

  // --- NL East ---
  { venueId: 4955, name: 'Truist Park (ATL)',
    factors: { home_runs: 1.02, total_bases: 1.01, runs: 1.01, hits: 1.00 } },
  { venueId: 17, name: 'loanDepot park (MIA)',
    factors: { home_runs: 0.88, total_bases: 0.94, runs: 0.93, hits: 0.96, triples: 1.10 } },
  { venueId: 3289, name: 'Citi Field (NYM)',
    factors: { home_runs: 0.95, total_bases: 0.98, runs: 0.97, hits: 0.99 } },
  { venueId: 2681, name: 'Citizens Bank Park (PHI)',
    factors: { home_runs: 1.10, total_bases: 1.04, runs: 1.04, hits: 1.01 } },
  { venueId: 3309, name: 'Nationals Park (WSH)',
    factors: { home_runs: 1.02, total_bases: 1.01, runs: 1.01, hits: 1.00 } },

  // --- NL Central ---
  { venueId: 17, name: 'Wrigley Field (CHC)',     // wind-dependent — use seasonal avg
    factors: { home_runs: 1.00, total_bases: 1.01, runs: 1.00, hits: 1.01, doubles: 1.06 } },
  { venueId: 2602, name: 'Great American Ball Park (CIN)',
    factors: { home_runs: 1.16, total_bases: 1.05, runs: 1.04, hits: 1.01 } },
  { venueId: 32, name: 'American Family Field (MIL)',
    factors: { home_runs: 1.05, total_bases: 1.01, runs: 1.01, hits: 0.99 } },
  { venueId: 31, name: 'PNC Park (PIT)',
    factors: { home_runs: 0.90, total_bases: 0.97, triples: 1.18, runs: 0.97, hits: 1.00 } },
  { venueId: 2889, name: 'Busch Stadium (STL)',
    factors: { home_runs: 0.97, total_bases: 0.99, runs: 0.98, hits: 1.00 } },

  // --- NL West ---
  { venueId: 22, name: 'Coors Field (COL)',       // altitude — biggest factor in MLB
    factors: { home_runs: 1.20, total_bases: 1.18, runs: 1.18, hits: 1.10, doubles: 1.15, triples: 1.40 } },
  { venueId: 19, name: 'Dodger Stadium (LAD)',
    factors: { home_runs: 1.08, total_bases: 1.00, runs: 0.97, hits: 0.97 } },
  { venueId: 2392, name: 'Chase Field (ARI)',
    factors: { home_runs: 1.05, total_bases: 1.02, runs: 1.02, hits: 1.01, triples: 1.20 } },
  { venueId: 2680, name: 'Petco Park (SD)',       // pitcher's park
    factors: { home_runs: 0.92, total_bases: 0.95, runs: 0.93, hits: 0.96 } },
  { venueId: 2395, name: 'Oracle Park (SF)',      // marine layer suppresses HR
    factors: { home_runs: 0.85, total_bases: 0.92, runs: 0.92, hits: 0.96, triples: 1.30 } },
];

const BY_VENUE = new Map<number, ParkFactorRow>();
for (const p of PARKS) BY_VENUE.set(p.venueId, p);

export type ParkFactor = {
  venueId: number;
  name: string;
  factors: Partial<Record<MlbStatKey, number>>;
};

// Look up the park-factor row for a venue. Returns null when the
// venue id is unknown (international games, spring training stadiums,
// new facilities not yet in the table). Callers should fall back to
// neutral (1.00) on null.
export function lookupParkFactor(venueId: number | null | undefined): ParkFactor | null {
  if (venueId == null) return null;
  return BY_VENUE.get(venueId) ?? null;
}

// Resolve the multiplier to apply to a hitter's projected stat at
// this park. Returns 1.00 when the park has no factor for this stat
// or the venue is unknown. Pitcher stats use the INVERSE of the
// hitter factor (a hitter-friendly park → more runs allowed by the
// pitcher → multiply pitcher run/hit/HR-allowed projections UP).
export function getParkMultiplier(
  parkFactor: ParkFactor | null,
  statKey: MlbStatKey,
  playerType: 'hitter' | 'pitcher',
): number {
  if (!parkFactor) return 1.0;

  // Pitcher stats are derived from hitter equivalents in the same park.
  // earned_runs_allowed inherits from runs; hits_allowed from hits;
  // home_runs_allowed from home_runs. Strikeouts/walks/innings are not
  // park-sensitive.
  if (playerType === 'pitcher') {
    const inverseMap: Partial<Record<MlbStatKey, MlbStatKey>> = {
      earned_runs_allowed: 'runs',
      hits_allowed: 'hits',
      home_runs_allowed: 'home_runs',
    };
    const sourceStat = inverseMap[statKey];
    if (!sourceStat) return 1.0;          // K, walks, IP, outs, pitches → neutral
    return parkFactor.factors[sourceStat] ?? 1.0;
  }

  // Hitter side: composite stats compute from constituents.
  if (statKey === 'hits_runs_rbis') {
    const h = parkFactor.factors.hits ?? 1.0;
    const r = parkFactor.factors.runs ?? 1.0;
    const rb = parkFactor.factors.rbis ?? parkFactor.factors.runs ?? 1.0;
    // Weighted by typical contribution (hits dominate the sum).
    return h * 0.5 + r * 0.25 + rb * 0.25;
  }
  if (statKey === 'hitter_fantasy_score') {
    // Fantasy score is HR-heavy in weighting (HR=10pts, single=3pts) so
    // it skews toward HR park factor.
    const hr = parkFactor.factors.home_runs ?? 1.0;
    const tb = parkFactor.factors.total_bases ?? 1.0;
    const r = parkFactor.factors.runs ?? 1.0;
    return hr * 0.4 + tb * 0.3 + r * 0.3;
  }

  return parkFactor.factors[statKey] ?? 1.0;
}

// Human-readable park-impact phrase for reason codes ("Coors Field
// boosts HR ~20% (1.20×)" / "Petco Park suppresses runs ~7% (0.93×)").
// Returns null when the multiplier is essentially neutral.
export function describeParkImpact(
  parkName: string,
  multiplier: number,
): string | null {
  if (Math.abs(multiplier - 1) < 0.03) return null;     // <3% deviation = neutral
  const pct = Math.round((multiplier - 1) * 100);
  const sign = pct > 0 ? '+' : '';
  return `${parkName}: ${sign}${pct}% (${multiplier.toFixed(2)}×)`;
}
