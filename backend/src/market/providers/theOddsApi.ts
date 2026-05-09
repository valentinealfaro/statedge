// The Odds API provider — Phase 103e.
//
// Free tier: 500 credits/month.
// Cost formula: credits = [unique markets returned] × [regions specified].
//
// IMPORTANT: every fetch consumes credits — no free reads. The free tier
// can be drained in minutes by an infinite loop. This module:
//   1. Reads ODDS_API_KEY from env (never logs it).
//   2. Reads ODDS_API_MONTHLY_CREDITS as a soft cap and refuses fetches
//      once the running total in the current calendar month meets it.
//   3. Tracks usage from the `x-requests-remaining` / `x-requests-used`
//      response headers The Odds API returns on every request.
//
// Currently invoked ONLY by admin-gated test endpoints. No automated
// polling. Phase 103e ships the foundation; later phases (103f
// scheduled snapshots, 103g consensus) build on top.

import {
  assertBudgetAvailable,
  recordSpend,
} from '../creditBudget.js';
import {
  americanFromDecimal,
  decimalFromAmerican,
  impliedFromAmerican,
  normalizeDirection,
  normalizeStatKey,
  normalizeTeamAbbr,
} from '../normalizer.js';
import type {
  Bookmaker,
  MarketProvider,
  MarketSport,
  NormalizedProp,
} from '../types.js';

// Suppress unused-import linter — these are exported for callers + may
// be referenced once we add team-abbr resolution.
void normalizeTeamAbbr;

const BASE = 'https://api.the-odds-api.com/v4';

// Sport-key map: their sport_key → our MarketSport enum.
const SPORT_KEY: Record<string, MarketSport> = {
  basketball_nba:           'nba',
  baseball_mlb:             'mlb',
  basketball_wnba:          'wnba',
  mma_mixed_martial_arts:   'mma',
  // Game-level markets exist for many more sports; props only on the
  // big four. Add new keys here as we wire new sports.
};

// Reverse — needed for /v4/sports/{key} URL construction.
export const TOA_SPORT_KEY: Record<MarketSport, string> = {
  nba:  'basketball_nba',
  mlb:  'baseball_mlb',
  wnba: 'basketball_wnba',
  mma:  'mma_mixed_martial_arts',
  nfl:  'americanfootball_nfl',
  nhl:  'icehockey_nhl',
} as const;

// Bookmaker key map. The Odds API uses lowercase bookmaker keys; ours
// are also lowercase but with subtle differences (espnbet vs espn_bet).
const BOOKMAKER_KEY: Record<string, Bookmaker> = {
  fanduel:     'fanduel',
  draftkings:  'draftkings',
  betmgm:      'betmgm',
  caesars:     'caesars',
  hardrockbet: 'hardrock',
  espnbet:     'espnbet',
  fanaticssportsbook: 'fanatics',
  bet365:      'bet365',
};

// ---------- Types matching The Odds API v4 event-odds response ----------

type ToaEventOdds = {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;        // ISO
  home_team: string;
  away_team: string;
  bookmakers: ToaBookmaker[];
};

type ToaBookmaker = {
  key: string;
  title: string;
  last_update: string;          // ISO
  markets: ToaMarket[];
};

type ToaMarket = {
  key: string;                  // 'player_points', 'h2h', etc.
  last_update?: string;
  outcomes: ToaOutcome[];
};

type ToaOutcome = {
  name: string;                 // 'Over' | 'Under' | team name
  description?: string;         // player name (player props only)
  price: number;                // American odds
  point?: number;               // line (props only)
};

// ---------- Provider ----------

export const theOddsApiProvider: MarketProvider = {
  source: 'the_odds_api',

  parse(input: unknown): NormalizedProp[] {
    // Caller passes either a single event-odds object or an array. Both
    // accepted so we can replay batched fetches.
    const events: ToaEventOdds[] = Array.isArray(input)
      ? (input as ToaEventOdds[])
      : [input as ToaEventOdds];
    const out: NormalizedProp[] = [];
    const captured = new Date().toISOString();

    for (const ev of events) {
      const sport = SPORT_KEY[ev.sport_key];
      if (!sport) continue;     // unsupported sport
      const gameDate = ev.commence_time.slice(0, 10);   // YYYY-MM-DD UTC
      const gameKey = stableGameKey(ev.away_team, ev.home_team);

      for (const bm of ev.bookmakers) {
        const bookmaker = BOOKMAKER_KEY[bm.key];
        if (!bookmaker) continue;     // unknown book — drop, don't guess
        for (const market of bm.markets) {
          // Player-prop markets always emit pairs of OVER/UNDER outcomes
          // for the same player+line. Game-level markets (h2h, spreads,
          // totals) we skip in this first pass — Phase 103e is props-
          // focused. Add game-level later when we need them.
          if (!market.key.startsWith('player_') && !market.key.startsWith('batter_') && !market.key.startsWith('pitcher_')) {
            continue;
          }

          for (const o of market.outcomes) {
            const playerName = o.description ?? o.name;
            // outcome.name = 'Over' | 'Under' for props.
            const direction = normalizeDirection(o.name);
            if (direction === 'BOTH' && o.point === undefined) continue;
            if (o.point === undefined) continue;

            const american = o.price;
            const decimal = decimalFromAmerican(american);
            const implied = impliedFromAmerican(american);

            out.push({
              source:               'the_odds_api',
              bookmaker,
              capturedAt:           captured,
              providerUpdatedAt:    market.last_update ?? bm.last_update ?? null,
              sport,
              league:               sport.toUpperCase(),
              providerGameId:       ev.id,
              gameKey,
              gameDate,
              rawPlayerName:        playerName,
              internalPlayerId:     null,                 // resolved later
              team:                 null,                 // TOA doesn't include team in player props
              opponent:             null,
              rawStatType:          market.key,
              statKey:              normalizeStatKey(market.key),
              line:                 o.point,
              direction,
              americanOdds:         american,
              decimalOdds:          decimal,
              impliedProbability:   implied,
              isDemon:              null,
              isGoblin:             null,
            });
          }
        }
      }
    }

    return out;
  },
};

// Stable game key — alphabetized away/home abbrev tuple. Same shape
// our internal market_snapshots.game_key uses. Builders can JOIN on
// this across providers without resolving the upstream ID first.
function stableGameKey(away: string, home: string): string | null {
  const a = teamAbbrFromName(away);
  const h = teamAbbrFromName(home);
  if (!a || !h) return null;
  return [a, h].sort().join('-');
}

// Best-effort team-name → abbr. The Odds API returns full team names
// ("Boston Celtics"); we want abbrs ("BOS"). Production wants a real
// table; for Phase 103e we live with null when unknown.
function teamAbbrFromName(name: string): string | null {
  // Quick heuristic — last token of name often reveals the city's
  // first 3 letters... no, that's brittle. Just return null and let
  // the snapshot writer fall back to the full name in raw_player_name.
  void name;
  return null;
}

// ---------- Fetch helpers ----------
//
// Two endpoints we use on the free tier:
//   GET /v4/sports                                   (no credits — list keys)
//   GET /v4/sports/{key}/events                      (no credits — list events)
//   GET /v4/sports/{key}/events/{eventId}/odds       (1 credit per market×region)
//
// The /odds endpoint with `markets=` accepts a comma-separated list.
// Cost = N markets × N regions, returned in `x-requests-used` header.

export type ToaQuotaInfo = {
  requestsRemaining: number | null;
  requestsUsed: number | null;
  costThisRequest: number | null;
};

export type ToaFetchResult<T> = {
  data: T;
  quota: ToaQuotaInfo;
};

function readQuota(headers: Headers): ToaQuotaInfo {
  const rem = headers.get('x-requests-remaining');
  const used = headers.get('x-requests-used');
  const cost = headers.get('x-requests-last');
  return {
    requestsRemaining: rem ? Number(rem) : null,
    requestsUsed:      used ? Number(used) : null,
    costThisRequest:   cost ? Number(cost) : null,
  };
}

// Required env. Throws (rather than return null) so calling code can
// distinguish "no key" from "no data" cleanly.
function requireKey(): string {
  const key = process.env.ODDS_API_KEY;
  if (!key) {
    throw new Error('ODDS_API_KEY env var not set — provider unavailable');
  }
  return key;
}

// List events for a sport. Free — does not consume credits. Used to
// discover game IDs for the events/{id}/odds calls that DO cost.
export async function fetchToaEvents(sport: MarketSport): Promise<ToaFetchResult<ToaEventStub[]>> {
  const sportKey = TOA_SPORT_KEY[sport];
  if (!sportKey) throw new Error(`Sport ${sport} has no Odds API key mapping`);
  const key = requireKey();
  const url = `${BASE}/sports/${encodeURIComponent(sportKey)}/events?apiKey=${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  const quota = readQuota(res.headers);
  if (!res.ok) {
    throw new Error(`The Odds API events fetch failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const data = (await res.json()) as ToaEventStub[];
  return { data, quota };
}

export type ToaEventStub = {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
};

// Fetch event odds for player-prop markets. CONSUMES CREDITS.
// Cost = |markets| × |regions|. Default 1 region (us) keeps cost low.
//
// Budget guard fires BEFORE the network request — if estimated cost
// would push us over ODDS_API_MONTHLY_CREDITS, throws without spending.
// After the fetch, the actual cost (from x-requests-last header) is
// recorded in provider_credit_usage.
export async function fetchToaEventOdds(opts: {
  sport: MarketSport;
  eventId: string;
  markets: string[];        // e.g. ['player_points', 'player_rebounds']
  regions?: string;         // default 'us'
  oddsFormat?: 'american' | 'decimal';
}): Promise<ToaFetchResult<ToaEventOdds>> {
  const sportKey = TOA_SPORT_KEY[opts.sport];
  if (!sportKey) throw new Error(`Sport ${opts.sport} has no Odds API key mapping`);
  const key = requireKey();
  const regionCount = (opts.regions ?? 'us').split(',').filter(Boolean).length;
  const estimatedCost = opts.markets.length * regionCount;
  await assertBudgetAvailable('the_odds_api', 'ODDS_API_MONTHLY_CREDITS', estimatedCost);

  const params = new URLSearchParams({
    apiKey: key,
    regions: opts.regions ?? 'us',
    markets: opts.markets.join(','),
    oddsFormat: opts.oddsFormat ?? 'american',
  });
  const url = `${BASE}/sports/${encodeURIComponent(sportKey)}/events/${encodeURIComponent(opts.eventId)}/odds?${params.toString()}`;
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  const quota = readQuota(res.headers);
  if (!res.ok) {
    throw new Error(`The Odds API event-odds fetch failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const data = (await res.json()) as ToaEventOdds;
  // Record actual cost from response header. Falls back to estimated
  // cost if the header isn't present (rare but defensive).
  const actualCost = quota.costThisRequest ?? estimatedCost;
  await recordSpend('the_odds_api', actualCost);
  return { data, quota };
}

// ---------- Historical odds (Phase 103f) ----------
//
// CRITICAL: historical odds cost 10× live. Cost = 10 × markets × regions.
// The free tier likely doesn't include historical (paid plans only).
// The same budget guard applies — assertBudgetAvailable fires before
// the network request with the inflated estimate.

export type ToaHistoricalEventOdds = ToaEventOdds & {
  // Historical responses include the snapshot timestamp. Live responses
  // don't (they implicitly mean "now").
  timestamp?: string;
};

// Fetch historical event odds at a specific timestamp.
//
// Endpoint: /v4/historical/sports/{key}/events/{eventId}/odds
// Cost: 10 × markets × regions per request.
//
// `date` is an ISO 8601 timestamp. The Odds API returns the snapshot
// closest to that timestamp (rounded down to nearest 5-min interval).
export async function fetchToaHistoricalEventOdds(opts: {
  sport: MarketSport;
  eventId: string;
  date: string;             // ISO timestamp
  markets: string[];
  regions?: string;
  oddsFormat?: 'american' | 'decimal';
}): Promise<ToaFetchResult<ToaHistoricalEventOdds>> {
  const sportKey = TOA_SPORT_KEY[opts.sport];
  if (!sportKey) throw new Error(`Sport ${opts.sport} has no Odds API key mapping`);
  const key = requireKey();
  const regionCount = (opts.regions ?? 'us').split(',').filter(Boolean).length;
  const estimatedCost = 10 * opts.markets.length * regionCount;
  await assertBudgetAvailable('the_odds_api', 'ODDS_API_MONTHLY_CREDITS', estimatedCost);

  const params = new URLSearchParams({
    apiKey: key,
    regions: opts.regions ?? 'us',
    markets: opts.markets.join(','),
    oddsFormat: opts.oddsFormat ?? 'american',
    date: opts.date,
  });
  const url = `${BASE}/historical/sports/${encodeURIComponent(sportKey)}/events/${encodeURIComponent(opts.eventId)}/odds?${params.toString()}`;
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  const quota = readQuota(res.headers);
  if (!res.ok) {
    throw new Error(`The Odds API historical event-odds fetch failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  // Historical wraps the event in a `data` envelope with timestamp.
  const json = (await res.json()) as { timestamp: string; data: ToaEventOdds };
  await recordSpend('the_odds_api', quota.costThisRequest ?? estimatedCost);
  return {
    data: { ...json.data, timestamp: json.timestamp },
    quota,
  };
}

// List historical events for a sport on a specific date. Used to discover
// event IDs for backfill. Cost: 1 credit per request (returns events
// snapshot at the given date).
export async function fetchToaHistoricalEvents(opts: {
  sport: MarketSport;
  date: string;             // ISO timestamp
}): Promise<ToaFetchResult<ToaEventStub[]>> {
  const sportKey = TOA_SPORT_KEY[opts.sport];
  if (!sportKey) throw new Error(`Sport ${opts.sport} has no Odds API key mapping`);
  const key = requireKey();
  await assertBudgetAvailable('the_odds_api', 'ODDS_API_MONTHLY_CREDITS', 1);

  const url = `${BASE}/historical/sports/${encodeURIComponent(sportKey)}/events?apiKey=${encodeURIComponent(key)}&date=${encodeURIComponent(opts.date)}`;
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  const quota = readQuota(res.headers);
  if (!res.ok) {
    throw new Error(`The Odds API historical events fetch failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as { timestamp: string; data: ToaEventStub[] };
  await recordSpend('the_odds_api', quota.costThisRequest ?? 1);
  return { data: json.data, quota };
}

// Re-export the americanFromDecimal converter for callers that want
// to compute prices without re-importing from normalizer.ts.
export { americanFromDecimal };
