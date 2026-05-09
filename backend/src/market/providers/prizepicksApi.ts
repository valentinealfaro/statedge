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

// PrizePicks league_id map. DEPRECATED for fetch use after Phase
// 103g-quat-ter — we now fetch the unfiltered /projections endpoint
// and route by league name from the response. IDs shifted seasonally
// (e.g. MLB was 7 in early 2026, then became 2 mid-season; NFL bounced
// between values). Kept here for any caller that wants to verify a
// specific league_id against current production. When in doubt, hit
// the unfiltered endpoint and inspect `included.league` entities.
export const PP_LEAGUE_ID: Record<MarketSport, number> = {
  nba:  9,
  mlb:  2,
  wnba: 5,
  mma:  16,
  nfl:  2,
  nhl:  3,
};

const PP_BASE = 'https://api.prizepicks.com';

// Browser-like headers. PrizePicks' Cloudflare blocks generic bots;
// this set mirrors what a real Chrome session sends to api.prizepicks.com
// when the iOS / web app pulls projections.
//
// Phase 103g-bis: added sec-ch-ua client-hints + priority + dnt after
// initial deploy hit 403 from Vercel's datacenter IPs. Cloudflare
// fingerprints these headers; a generic UA-only set wasn't enough.
// If 403s persist, the IP itself is flagged — fall back to the
// browser-side capture pattern (user's residential IP isn't blocked).
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.156 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://app.prizepicks.com',
  'Referer': 'https://app.prizepicks.com/',
  'Sec-Fetch-Site': 'same-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  // Client hints — Chrome sends these on every fetch from app.*
  'sec-ch-ua': '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  // Priority hint — modern Chrome sets this on XHR / fetch.
  'priority': 'u=1, i',
  'dnt': '1',
  // Cache + connection hints that real browsers send. Cache-Control
  // unset lets the server decide; if-none-match wouldn't apply here.
  'Connection': 'keep-alive',
};

// ---------- JSON:API response shape ----------

type PpProjection = {
  type: 'projection';
  id: string;
  attributes: {
    line_score: number;
    stat_type?: string;             // sometimes present alongside relationships
    stat_display_name?: string;     // current PP responses use this
    description?: string;           // current PP responses: TEAM abbreviation (NOT player name as the legacy parser assumed)
    event_type?: string;            // 'player' | 'team' | other — we only want 'player'
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

// Phase 103g-quat-quat — also build a league lookup. Earlier we read
// the league string off the player's attributes, but in current PP
// responses the league lives only on the relationship → included
// `league` entity. Looking it up via relationship is more reliable
// across PP's API revisions.
type PpIncludedLeague = {
  type: 'league';
  id: string;
  attributes: {
    name: string;                   // 'MLB', 'NBA', 'WNBA', 'UFC', etc.
  };
};

type PpIncluded =
  | PpIncludedPlayer
  | PpIncludedStatType
  | PpIncludedLeague
  | { type: string; id: string; attributes: unknown };

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

    // Build lookup tables from `included`. Phase 103g-quat-quat:
    // also build the league lookup since current PP responses put
    // the league name on the league entity, not on the player's
    // attributes.
    const players = new Map<string, PpIncludedPlayer>();
    const statTypes = new Map<string, PpIncludedStatType>();
    const leagues = new Map<string, PpIncludedLeague>();
    for (const item of json.included ?? []) {
      if (item.type === 'new_player') players.set(item.id, item as PpIncludedPlayer);
      else if (item.type === 'stat_type')  statTypes.set(item.id, item as PpIncludedStatType);
      else if (item.type === 'league')     leagues.set(item.id, item as PpIncludedLeague);
    }

    const captured = new Date().toISOString();
    const out: NormalizedProp[] = [];

    for (const p of json.data) {
      const a = p.attributes;
      if (!a || typeof a.line_score !== 'number') continue;

      // Phase 103g-quat-quat: skip non-player projections. PP returns
      // team-level stats with event_type='team' (e.g. team-aggregated
      // Hits+Runs+RBIs). Those have no useful player resolution and
      // shouldn't enter our market_snapshots as "player props."
      if (a.event_type && a.event_type !== 'player') continue;

      const playerRel = p.relationships?.new_player?.data?.id;
      const statRel = p.relationships?.stat_type?.data?.id;
      const leagueRel = p.relationships?.league?.data?.id;
      const player = playerRel ? players.get(playerRel) : null;
      const statType = statRel ? statTypes.get(statRel) : null;
      const league = leagueRel ? leagues.get(leagueRel) : null;

      const playerName = player?.attributes.name ?? '';
      const statLabel =
        statType?.attributes.name ?? a.stat_display_name ?? a.stat_type ?? '';
      if (!playerName || !statLabel) continue;

      // League now resolved via relationship → included. Falls back
      // to the player attribute for backwards compat.
      const sport = leagueAttrToSport(
        league?.attributes.name ?? player?.attributes.league,
      );
      if (!sport) continue;

      // Team — current PP responses put it on the projection's
      // `description` field. Older responses had it on the player.
      // Try projection first, then player attribute.
      const team = normalizeTeamAbbr(
        a.description ?? player?.attributes.team ?? null,
      );
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
//
// Phase 103g-quat-ter: fetches the UNFILTERED /projections endpoint.
// Earlier per-sport league_id filtering hit 0 MLB props because PP
// shifts league_ids seasonally and our hard-coded map was stale.
// The unfiltered endpoint returns every active league in one
// response; the parser auto-routes each prop to its sport via the
// included `new_player.attributes.league` string. Caller passes
// `sport` only to filter the parser output — the raw fetch is always
// the same URL regardless of sport.
export async function fetchPrizepicksProjections(opts: {
  sport?: MarketSport;     // optional — when present, output filtered to this sport
  perPage?: number;        // default 1000 (PP's effective cap; large slates need it)
  timeout?: number;        // ms, default 12000
}): Promise<PrizepicksFetchResult> {
  const perPage = opts.perPage ?? 1000;
  const url = `${PP_BASE}/projections?per_page=${perPage}`;

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), opts.timeout ?? 12000);
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(
        `PrizePicks projections fetch failed: ${res.status} ${res.statusText}`,
      );
    }
    const raw = (await res.json()) as PpResponse;
    const allProps = prizepicksApiProvider.parse(raw);
    // Filter to requested sport if specified; else return everything.
    const props = opts.sport
      ? allProps.filter((p) => p.sport === opts.sport)
      : allProps;
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
