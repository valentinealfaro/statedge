// UFC moneyline odds via The Odds API — Phase 107b.
//
// Pulls h2h moneylines for upcoming UFC events from The Odds API.
// MMA odds change rarely outside the final hours before a card —
// the cache here is intentionally aggressive (12h TTL) to keep us
// inside the 500-credit free-tier budget. A typical UFC card has
// ~12 fights × 1 credit each = ~12 credits per refresh.
//
// Match-up strategy: Odds API events use the bookmaker home_team /
// away_team strings (fighter full names). Frontend joins to the
// ESPN scoreboard by fuzzy fighter-name match (each fighter usually
// appears in only one event in any given week, so collisions are
// rare enough to ignore for now).

import {
  fetchToaEventOdds,
  fetchToaEvents,
} from '../market/providers/theOddsApi.js';
import { deVigPair } from './oddsFormula.js';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let cache: { fetchedAt: number; events: UfcMoneylineEvent[] } | null = null;

export type UfcMoneylineFighter = {
  fighterName: string;
  americanOdds: number;       // -150, +135 etc.
  decimalOdds: number;
  impliedProbability: number; // 0-1, raw book line including juice
  // Phase 130b — fair probability after de-vigging the pair via the
  // proportional method (impliedA / (impliedA + impliedB)). Removes
  // the bookmaker's hold so users see what the book actually thinks
  // before they tilt the line in their favor.
  fairProbability: number;    // 0-1
};
export type UfcMoneylineEvent = {
  toaEventId: string;
  commenceTime: string;       // ISO
  fighterA: UfcMoneylineFighter;
  fighterB: UfcMoneylineFighter;
  bookmaker: string | null;   // which book we picked the consensus from
  // Bookmaker hold across the two-way market, in percentage points
  // (e.g. 4.5 means the two implied probabilities sum to 104.5%).
  // Useful diagnostic for users — sharp lines typically post hold ≤4pp.
  vigPct: number;
};

export async function getUfcMoneylines(opts?: { force?: boolean }): Promise<{
  events: UfcMoneylineEvent[];
  fetchedAt: string;
  fromCache: boolean;
}> {
  if (!opts?.force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return {
      events: cache.events,
      fetchedAt: new Date(cache.fetchedAt).toISOString(),
      fromCache: true,
    };
  }

  // /events is FREE — doesn't charge credits per docs. Use it to get
  // the list of upcoming MMA events before paying for any odds.
  let stubs;
  try {
    const result = await fetchToaEvents('mma');
    stubs = result.data;
  } catch (err) {
    console.warn('toa mma events fetch failed', (err as Error).message);
    return { events: [], fetchedAt: new Date().toISOString(), fromCache: false };
  }

  // Per-event odds fetch costs 1 credit each (1 market × 1 region).
  // Limit to the next 14 days to bound the cost — UFC events 2+ weeks
  // out rarely have odds posted by US books anyway.
  const horizonMs = Date.now() + 14 * 24 * 60 * 60 * 1000;
  const eligible = stubs.filter((e) => new Date(e.commence_time).getTime() < horizonMs);

  const out: UfcMoneylineEvent[] = [];
  for (const stub of eligible) {
    try {
      const result = await fetchToaEventOdds({
        sport: 'mma',
        eventId: stub.id,
        markets: ['h2h'],
      });
      const ev = parseEventOdds(result.data, stub.commence_time);
      if (ev) out.push(ev);
    } catch (err) {
      console.warn(`toa mma event odds failed for ${stub.id}`, (err as Error).message);
    }
  }

  cache = { fetchedAt: Date.now(), events: out };
  return {
    events: out,
    fetchedAt: new Date(cache.fetchedAt).toISOString(),
    fromCache: false,
  };
}

// Pick the best available bookmaker line, preferring DraftKings >
// FanDuel > BetMGM > anything else. Returns null when no h2h market
// exists (some events get listed before US books post odds).
function parseEventOdds(
  raw: { id: string; home_team: string; away_team: string; bookmakers?: Array<{ key: string; title: string; markets?: Array<{ key: string; outcomes: Array<{ name: string; price: number }> }> }> },
  commenceTime: string,
): UfcMoneylineEvent | null {
  const order = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'espnbet'];
  const books = raw.bookmakers ?? [];
  if (books.length === 0) return null;
  const sorted = [...books].sort((a, b) => {
    const ai = order.indexOf(a.key);
    const bi = order.indexOf(b.key);
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
  });

  for (const bk of sorted) {
    const market = (bk.markets ?? []).find((m) => m.key === 'h2h');
    if (!market || market.outcomes.length < 2) continue;
    const outcomeA = market.outcomes.find((o) => o.name === raw.home_team);
    const outcomeB = market.outcomes.find((o) => o.name === raw.away_team);
    if (!outcomeA || !outcomeB) continue;
    const a = makeMoneylineFighter(raw.home_team, outcomeA.price);
    const b = makeMoneylineFighter(raw.away_team, outcomeB.price);
    // De-vig the pair so we expose the fair probabilities the
    // bookmaker would offer with no hold.
    const dv = deVigPair(a.impliedProbability, b.impliedProbability);
    a.fairProbability = dv.fairProbA;
    b.fairProbability = dv.fairProbB;
    return {
      toaEventId: raw.id,
      commenceTime,
      bookmaker: bk.key,
      vigPct: dv.vigPct,
      fighterA: a,
      fighterB: b,
    };
  }
  return null;
}

function makeMoneylineFighter(name: string, americanOdds: number): UfcMoneylineFighter {
  const decimalOdds = americanOdds > 0 ? 1 + americanOdds / 100 : 1 + 100 / Math.abs(americanOdds);
  const implied = americanOdds > 0
    ? 100 / (americanOdds + 100)
    : Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
  return {
    fighterName: name,
    americanOdds,
    decimalOdds,
    impliedProbability: implied,
    // Placeholder — overwritten by parseEventOdds after both fighters
    // are computed and we can de-vig the pair. Kept on the type so
    // every UfcMoneylineFighter shape consistently carries it.
    fairProbability: implied,
  };
}
