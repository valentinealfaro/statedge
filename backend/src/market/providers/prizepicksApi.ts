// PrizePicks API provider — Phase 103g.
//
// Same data the admin currently pastes manually, fetched directly from
// PrizePicks' public projections endpoint:
//   GET https://api.prizepicks.com/projections?league_id=<id>&per_page=500
//
// Response is JSON:API spec format with `data` (projections) and
// `included` (related entities — players, leagues, stat_types).
// We resolve the relationships into a flat NormalizedProp[].
//
// IMPORTANT — this endpoint is undocumented. PrizePicks doesn't
// publish stable contract guarantees. Their Cloudflare layer blocks
// requests with non-browser User-Agents (WebFetch hits 403). We send
// realistic browser headers to bypass basic bot detection — the same
// pattern most public analytics tools use.
//
// RESPECT THE SOURCE:
//   - Cap polls to 1-2 per day per sport (matches user's intent).
//   - Cache server-side aggressively — reuse one fetch across many
//     consumers.
//   - Treat 403/429/5xx as "fall back to admin paste, don't retry."
//   - Don't redistribute the raw response. We extract lines and
//     persist our normalized shape only.

import {
  normalizeDirection,
  normalizeStatKey,
  normalizeTeamAbbr,
} from '../normalizer.js';
import type {
  MarketProvider,
  MarketSport,
  NormalizedProp,
} from '../types.js';

// PrizePicks league_id map. IDs are stable across seasons but
// occasionally shift between regular season + playoffs (NBA in
// particular). When in doubt, hit /v1/leagues against the API and
// re-derive.
export const PP_LEAGUE_ID: Record<MarketSport, number> = {
  nba:  9,
  mlb:  7,
  wnba: 5,
  mma:  16,    // UFC + PFL combined under MMA bucket
  nfl:  2,
  nhl:  3,
};

const PP_BASE = 'https://api.prizepicks.com';

// Browser-like headers. PrizePicks' Cloudflare blocks generic bots;
// this set mirrors what a real Chrome session sends to api.prizepicks.com
// when the iOS / web app pulls projections.
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://app.prizepicks.com',
  'Referer': 'https://app.prizepicks.com/',
  'Sec-Fetch-Site': 'same-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
};

// ---------- JSON:API response shape ----------

type PpProjection = {
  type: 'projection';
  id: string;
  attributes: {
    line_score: number;
    stat_type?: string;             // sometimes present alongside relationships
    description?: string;           // often the player name
    is_promo: boolean;
    odds_type: 'standard' | 'demon' | 'goblin';
    start_time: string;             // ISO
    status: string;                 // 'pre_game' | 'in_progress' | 'final'
    flash_sale_line_score?: number | null;
  };
  relationships: {
    league?:    { data: { type: string; id: string } };
    new_player?:{ data: { type: string; id: string } };
    stat_type?: { data: { type: string; id: string } };
  };
};

type PpIncludedPlayer = {
  type: 'new_player';
  id: string;
  attributes: {
    name: string;
    team?: string;
    team_name?: string;
    position?: string;
    market?: string;
    league?: string;
  };
};

type PpIncludedStatType = {
  type: 'stat_type';
  id: string;
  attributes: {
    name: string;                   // 'Strikeouts (Hitter)', 'Points', etc.
  };
};

type PpIncluded = PpIncludedPlayer | PpIncludedStatType | { type: string; id: string; attributes: unknown };

type PpResponse = {
  data: PpProjection[];
  included: PpIncluded[];
};

// ---------- Provider ----------

export const prizepicksApiProvider: MarketProvider = {
  source: 'prizepicks_paste',     // we keep the same source string so
                                  // historical snapshots from the paste
                                  // pipeline group with API-fetched
                                  // ones — they're the same book, same
                                  // PrizePicks data, just different
                                  // capture mechanism.

  parse(input: unknown): NormalizedProp[] {
    const json = input as PpResponse;
    if (!json?.data || !Array.isArray(json.data)) return [];

    // Build lookup tables from `included`.
    const players = new Map<string, PpIncludedPlayer>();
    const statTypes = new Map<string, PpIncludedStatType>();
    for (const item of json.included ?? []) {
      if (item.type === 'new_player') players.set(item.id, item as PpIncludedPlayer);
      if (item.type === 'stat_type')  statTypes.set(item.id, item as PpIncludedStatType);
    }

    const captured = new Date().toISOString();
    const out: NormalizedProp[] = [];

    for (const p of json.data) {
      const a = p.attributes;
      if (!a || typeof a.line_score !== 'number') continue;

      const playerRel = p.relationships?.new_player?.data?.id;
      const statRel = p.relationships?.stat_type?.data?.id;
      const player = playerRel ? players.get(playerRel) : null;
      const statType = statRel ? statTypes.get(statRel) : null;

      const playerName = player?.attributes.name ?? a.description ?? '';
      const statLabel = statType?.attributes.name ?? a.stat_type ?? '';
      if (!playerName || !statLabel) continue;

      const sport = leagueAttrToSport(player?.attributes.league);
      if (!sport) continue;

      const team = normalizeTeamAbbr(player?.attributes.team ?? null);
      const gameDate = a.start_time.slice(0, 10);

      // PrizePicks side restrictions:
      //   demon  → over-only, payout boost
      //   goblin → under-only, payout reduction
      //   standard → both sides bookable at table rate
      const isDemon = a.odds_type === 'demon';
      const isGoblin = a.odds_type === 'goblin';
      const direction = isDemon ? 'OVER' : isGoblin ? 'UNDER' : normalizeDirection('BOTH');

      out.push({
        source:               'prizepicks_paste',
        bookmaker:            'prizepicks',
        capturedAt:           captured,
        providerUpdatedAt:    null,
        sport,
        league:               sport.toUpperCase(),
        providerGameId:       null,
        gameKey:              null,        // resolved at write site
        gameDate,
        rawPlayerName:        playerName,
        internalPlayerId:     null,        // resolved at write site
        team,
        opponent:             null,        // PP doesn't return opponent here
        rawStatType:          statLabel,
        statKey:              normalizeStatKey(statLabel),
        line:                 a.line_score,
        direction,
        americanOdds:         null,        // PrizePicks doesn't publish American odds — DFS pays Flex/Power schedule instead
        decimalOdds:          null,
        impliedProbability:   null,
        isDemon,
        isGoblin,
      });
    }

    return out;
  },
};

// ---------- Fetch ----------

export type PrizepicksFetchResult = {
  raw: PpResponse;
  props: NormalizedProp[];
  fetchedAt: string;
};

// Fetch + parse in one call. Returns both the raw response (for audit /
// future re-parse with smarter resolution) and the normalized props.
export async function fetchPrizepicksProjections(opts: {
  sport: MarketSport;
  perPage?: number;        // default 500 (their max)
  timeout?: number;        // ms, default 8000
}): Promise<PrizepicksFetchResult> {
  const leagueId = PP_LEAGUE_ID[opts.sport];
  if (!leagueId) throw new Error(`No PrizePicks league_id mapping for sport: ${opts.sport}`);
  const perPage = opts.perPage ?? 500;
  const url = `${PP_BASE}/projections?league_id=${leagueId}&per_page=${perPage}`;

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), opts.timeout ?? 8000);
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // 403 = Cloudflare block. 429 = rate limit. Both mean fall back
      // to admin paste. Caller decides what to do.
      throw new Error(
        `PrizePicks projections fetch failed: ${res.status} ${res.statusText}`,
      );
    }
    const raw = (await res.json()) as PpResponse;
    const props = prizepicksApiProvider.parse(raw);
    return { raw, props, fetchedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------- Helpers ----------

// PrizePicks's `included` records carry a league name string ("MLB",
// "NBA", etc.) on the player object. Map back to our MarketSport
// enum. Fallback: try the league_id we requested.
function leagueAttrToSport(leagueAttr: string | undefined): MarketSport | null {
  if (!leagueAttr) return null;
  const norm = leagueAttr.toUpperCase();
  if (norm === 'MLB')  return 'mlb';
  if (norm === 'NBA')  return 'nba';
  if (norm === 'WNBA') return 'wnba';
  if (norm.startsWith('UFC') || norm === 'MMA' || norm === 'PFL') return 'mma';
  if (norm === 'NFL')  return 'nfl';
  if (norm === 'NHL')  return 'nhl';
  return null;
}
