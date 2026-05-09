// PrizePicks provider — Phase 103a, the FIRST concrete MarketProvider.
//
// Source: the pipe-format paste the admin already pushes into
// /api/mlb/slate/today and /api/wnba/slate/today every game day.
// We're treating that paste as a proprietary first-party feed.
//
// Format: one prop per line, fields separated by '|':
//   PlayerName|TEAM|stat|line|side
// Optional 6th field: 'demon' or 'goblin' for PrizePicks side
// restrictions. Lines starting with '#' or blank are ignored.
//
// Within weeks, every paste accumulates as time-series data in
// market_snapshots. By the time we wire paid providers, we already
// have proprietary line-history that no API can sell us.
//
// IMPORTANT: this provider is intentionally DUMB. It just parses the
// text and emits NormalizedProp[]. It does NOT resolve player ids,
// hit DB, or know about MLB/WNBA-specific quirks. All those layers
// happen at the call site (admin route handler).

import { normalizeDirection, normalizeStatKey, normalizeTeamAbbr } from '../normalizer.js';
import type {
  MarketProvider,
  MarketSport,
  NormalizedProp,
} from '../types.js';

export type PrizePicksParseInput = {
  text: string;
  sport: MarketSport;
  league: string;
  gameDate: string;          // YYYY-MM-DD (caller's canonical ET date)
  capturedAt?: string;       // override timestamp (testing); defaults to NOW
};

function nowIso(): string {
  return new Date().toISOString();
}

export const prizepicksProvider: MarketProvider = {
  source: 'prizepicks_paste',

  parse(input: unknown): NormalizedProp[] {
    const i = input as PrizePicksParseInput;
    if (!i || typeof i.text !== 'string') return [];
    const captured = i.capturedAt ?? nowIso();
    const lines = i.text.split(/\r?\n/);
    const out: NormalizedProp[] = [];
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('|').map((p) => p.trim());
      if (parts.length < 5) continue;
      const playerName = parts[0]!;
      const team       = parts[1] ?? '';
      const statRaw    = parts[2] ?? '';
      const lineRaw    = parts[3] ?? '';
      const sideRaw    = parts[4] ?? 'BOTH';
      const flagRaw    = (parts[5] ?? '').toLowerCase();
      const lineNum    = Number(lineRaw);
      if (!playerName || !statRaw || !Number.isFinite(lineNum)) continue;
      out.push({
        source:               'prizepicks_paste',
        bookmaker:            'prizepicks',
        capturedAt:           captured,
        providerUpdatedAt:    null,
        sport:                i.sport,
        league:               i.league,
        providerGameId:       null,
        gameKey:              null,
        gameDate:             i.gameDate,
        rawPlayerName:        playerName,
        internalPlayerId:     null,           // resolved at call site
        team:                 normalizeTeamAbbr(team),
        opponent:             null,
        rawStatType:          statRaw,
        statKey:              normalizeStatKey(statRaw),
        line:                 lineNum,
        direction:            normalizeDirection(sideRaw),
        // PrizePicks doesn't publish raw odds the same way books do.
        // Their payouts are driven by Flex / Power schedules, not
        // per-leg American odds. Future work: derive an "implied
        // probability" from the standard 0.55 break-even that
        // Power-play 2-leg pays at and surface that here.
        americanOdds:         null,
        decimalOdds:          null,
        impliedProbability:   null,
        isDemon:              flagRaw === 'demon',
        isGoblin:             flagRaw === 'goblin',
      });
    }
    return out;
  },
};
