// Market Brain types — Phase 103a.
//
// The institutional market intelligence acquisition layer. Every
// provider (paid feed, scrape, admin paste, etc.) implements
// MarketProvider; every output is normalized through this contract
// before persistence. Without normalization, historical intelligence
// becomes corrupted (per the Phase 103 spec).
//
// Sport-agnostic. Same vocabulary works for NBA, MLB, WNBA, NFL.
//
// IMPORTANT: this module is the WIRE FORMAT. Internal engines should
// read from market_snapshots / consensus tables — not call providers
// directly. That separation lets us swap providers freely.

export type MarketSport = 'nba' | 'mlb' | 'wnba' | 'nfl' | 'nhl';

// Bookmaker identity. Case-insensitive on input; canonical lowercase
// on storage. PrizePicks + Underdog are special — they're DFS books,
// not traditional sportsbooks, but they're the most prop-coverage-
// dense source we have today.
export type Bookmaker =
  | 'prizepicks'    // Phase 103a — admin paste source
  | 'underdog'
  | 'fanduel'
  | 'draftkings'
  | 'betmgm'
  | 'caesars'
  | 'hardrock'
  | 'espnbet'
  | 'fanatics'
  | 'bet365';

// Provider source identity. Distinct from Bookmaker — a provider is
// the FEED (e.g. The Odds API) which itself aggregates many books.
export type ProviderSource =
  | 'prizepicks_paste'    // Phase 103a — our admin paste pipeline
  | 'the_odds_api'
  | 'sportsdataio'
  | 'oddsjam'
  | 'opticodds'
  | 'sportsgameodds'
  | 'theurundown';

// One leg of a prop bet, normalized. The ATOMIC unit of market memory.
export type NormalizedProp = {
  // Source provenance. Both the upstream feed and the specific book
  // whose line this represents.
  source: ProviderSource;
  bookmaker: Bookmaker;

  // When did this snapshot fire on our side? UTC ISO. The provider's
  // own update timestamp lives in providerUpdatedAt when available.
  capturedAt: string;
  providerUpdatedAt: string | null;

  // Sport + league. NBA → ('nba', 'NBA'). MLB → ('mlb', 'MLB'). We
  // keep both because some providers distinguish leagues vs
  // confederations and we want to match exactly.
  sport: MarketSport;
  league: string;

  // Game / event identity. providerGameId is the upstream string id
  // (kept for joins back). gameKey is OUR derived key — alphabetized
  // team abbreviations + date — stable across providers.
  providerGameId: string | null;
  gameKey: string | null;
  gameDate: string;          // YYYY-MM-DD (game-day local-ET)

  // Player identity. Resolution to internal_player_id is best-effort
  // and happens via playerResolver. Raw name is always preserved for
  // audit + downstream re-resolution as the resolver improves.
  rawPlayerName: string;
  internalPlayerId: number | string | null;

  team: string | null;       // 3-letter abbr when known
  opponent: string | null;

  // The prop itself.
  rawStatType: string;       // provider's label ("Strikeouts (Hitter)")
  statKey: string;           // normalized ('strikeouts', 'pra', etc.)
  line: number;
  direction: 'OVER' | 'UNDER' | 'BOTH';

  // Pricing. Different providers use different formats (American odds,
  // decimal, fractional, implied %). We store ALL three for direct
  // querying without re-deriving.
  americanOdds: number | null;     // -110, +130
  decimalOdds: number | null;      // 1.91, 2.30
  impliedProbability: number | null; // 0-100

  // PrizePicks side restrictions — their "Demon" (over-only, payout
  // boost) and "Goblin" (under-only, payout reduction) flags. Other
  // books leave these null.
  isDemon: boolean | null;
  isGoblin: boolean | null;
};

// Provider contract. Phase 103a ships with prizepicks_paste only;
// future providers (paid feeds) implement this same interface.
export interface MarketProvider {
  source: ProviderSource;

  // Ingest a raw payload into NormalizedProp[]. Pure-function. Does
  // NOT write to DB — caller decides where to persist.
  parse(input: unknown): NormalizedProp[];
}

// Multi-book consensus shape. Computed across NormalizedProp[] for the
// same player+stat+line. The Phase 103 "Market Consensus Engine."
export type MarketConsensus = {
  internalPlayerId: number | string | null;
  rawPlayerName: string;
  statKey: string;
  gameDate: string;

  // Median line across the book set. When books disagree on the line
  // itself, this surfaces the central tendency.
  consensusLine: number;
  // Range across books — disagreement signal. wide range = real edge
  // candidate per the spec.
  minLine: number;
  maxLine: number;
  lineDisagreement: number;        // maxLine - minLine

  // Same for implied probability (when at least one book quotes price).
  consensusImpliedProb: number | null;
  minImpliedProb: number | null;
  maxImpliedProb: number | null;
  probDisagreement: number | null;

  // How many books did we see for this prop?
  bookCount: number;
  bookmakers: Bookmaker[];

  // Most recent capturedAt across the contributing snapshots.
  freshAt: string;
};
