// Game-context fetcher. Pulls lineup + weather + venue for a single
// MLB game from statsapi.mlb.com. Drives the projection engine's
// park / weather / lineup adjustments — without this, the engine has
// to fall back to player-history-only.
//
// Three layers, all read-only from the MLB API:
//
//   getGameVenueAndWeather(gamePk)
//     /api/v1/schedule?gamePks={pk}&hydrate=weather,venue
//     → { venueId, venueName, weather: { temp, wind, condition } }
//
//   getGameLineups(gamePk)
//     /api/v1/game/{gamePk}/boxscore
//     → { home: [...], away: [...] }  with batting order (1-9) per player
//
//   getGameContext(gamePk)
//     Combines both above into a single object the projection engine
//     can ingest. Caches per-process for the lifetime of the request.

const BASE = 'https://statsapi.mlb.com/api/v1';
const FETCH_TIMEOUT_MS = 8000;

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MLB API ${path} ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------- Venue + weather ----------

export type GameWeather = {
  // Temperature in F. null when not yet posted (game too far out).
  tempF: number | null;
  // Wind speed in mph. null when not yet posted.
  windSpeedMph: number | null;
  // Wind direction as a compass label ("Out To CF", "In From LF", etc).
  // The MLB API returns these directional descriptions verbatim.
  windDirection: string | null;
  // Catch-all condition string ("Sunny", "Roof Closed", "Cloudy"...).
  condition: string | null;
  // Whether the venue's roof is closed (eliminates weather effects).
  roofClosed: boolean;
};

export type GameVenueWeather = {
  venueId: number | null;
  venueName: string | null;
  weather: GameWeather;
};

type ScheduleResponse = {
  dates: Array<{
    games: Array<{
      gamePk: number;
      venue: { id?: number; name?: string };
      weather?: {
        temp?: string;
        wind?: string;            // e.g. "8 mph, Out To CF"
        condition?: string;       // e.g. "Roof Closed"
      };
    }>;
  }>;
};

// Parse "8 mph, Out To CF" → { speed: 8, direction: "Out To CF" }.
// MLB returns wind as a single descriptive string; we split out the
// speed for math and keep the direction for reason codes.
function parseWind(raw?: string): { speed: number | null; direction: string | null } {
  if (!raw) return { speed: null, direction: null };
  const m = /^(\d+(?:\.\d+)?)\s*mph(?:\s*,\s*(.+))?$/i.exec(raw.trim());
  if (m) {
    return {
      speed: Number(m[1]),
      direction: m[2]?.trim() ?? null,
    };
  }
  return { speed: null, direction: raw.trim() };
}

function parseTemp(raw?: string): number | null {
  if (!raw) return null;
  const n = Number(String(raw).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export async function getGameVenueAndWeather(
  gamePk: number,
): Promise<GameVenueWeather | null> {
  const data = await fetchJson<ScheduleResponse>(
    `/schedule?sportId=1&gamePks=${gamePk}&hydrate=weather,venue`,
  );
  const game = data.dates?.[0]?.games?.[0];
  if (!game) return null;
  const wind = parseWind(game.weather?.wind);
  const condition = game.weather?.condition?.trim() ?? null;
  // Several conditions imply roof closed — both literal "Roof Closed"
  // and "Dome" descriptions. When the roof is closed, weather effects
  // should be suppressed by the engine.
  const roofClosed =
    !!condition && /roof\s*closed|dome/i.test(condition);
  return {
    venueId: game.venue?.id ?? null,
    venueName: game.venue?.name ?? null,
    weather: {
      tempF: parseTemp(game.weather?.temp),
      windSpeedMph: wind.speed,
      windDirection: wind.direction,
      condition,
      roofClosed,
    },
  };
}

// ---------- Lineup / batting order ----------

export type LineupSlot = {
  playerId: number;
  battingOrder: number;     // 1-9
  position: string | null;
  fullName: string | null;
};

export type GameLineups = {
  home: LineupSlot[];
  away: LineupSlot[];
};

type BoxscoreResponse = {
  teams?: {
    home?: BoxscoreTeam;
    away?: BoxscoreTeam;
  };
};

type BoxscoreTeam = {
  battingOrder?: number[];                 // ordered list of 9 player ids
  players?: Record<string, BoxscorePlayer>; // keyed "ID12345" → details
};

type BoxscorePlayer = {
  person?: { id: number; fullName?: string };
  position?: { abbreviation?: string };
  battingOrder?: string;                    // "100", "200", ... "900"
};

function extractLineup(team: BoxscoreTeam | undefined): LineupSlot[] {
  if (!team) return [];
  // Two ways the API surfaces batting order:
  //  1. team.battingOrder = [id, id, ...] in order 1-9 (preferred)
  //  2. each player's battingOrder string ("100" = 1st, "200" = 2nd...)
  // Use #1 when available; fall back to #2 if not.
  const players = team.players ?? {};
  if (Array.isArray(team.battingOrder) && team.battingOrder.length > 0) {
    return team.battingOrder
      .map((id, idx): LineupSlot | null => {
        const p = players[`ID${id}`];
        if (!p?.person) return null;
        return {
          playerId: id,
          battingOrder: idx + 1,
          position: p.position?.abbreviation ?? null,
          fullName: p.person.fullName ?? null,
        };
      })
      .filter((x): x is LineupSlot => x !== null);
  }
  // Fallback: scan players for non-empty battingOrder string.
  const slots: LineupSlot[] = [];
  for (const key in players) {
    const p = players[key]!;
    if (!p.person || !p.battingOrder) continue;
    const orderRaw = Number(p.battingOrder);
    if (!Number.isFinite(orderRaw)) continue;
    // "100" → 1, "200" → 2 … (orderRaw / 100)
    const battingOrder = Math.floor(orderRaw / 100);
    if (battingOrder < 1 || battingOrder > 9) continue;
    slots.push({
      playerId: p.person.id,
      battingOrder,
      position: p.position?.abbreviation ?? null,
      fullName: p.person.fullName ?? null,
    });
  }
  // De-dupe by batting order (the same slot appears for pinch hitters);
  // keep the first one we see.
  const byOrder = new Map<number, LineupSlot>();
  for (const s of slots) {
    if (!byOrder.has(s.battingOrder)) byOrder.set(s.battingOrder, s);
  }
  return [...byOrder.values()].sort((a, b) => a.battingOrder - b.battingOrder);
}

export async function getGameLineups(gamePk: number): Promise<GameLineups | null> {
  const data = await fetchJson<BoxscoreResponse>(`/game/${gamePk}/boxscore`);
  if (!data.teams) return null;
  return {
    home: extractLineup(data.teams.home),
    away: extractLineup(data.teams.away),
  };
}

// ---------- Combined ----------

export type GameContext = {
  gamePk: number;
  venueId: number | null;
  venueName: string | null;
  weather: GameWeather;
  lineups: GameLineups;
};

export async function getGameContext(gamePk: number): Promise<GameContext | null> {
  const [vw, lineups] = await Promise.all([
    getGameVenueAndWeather(gamePk).catch(() => null),
    getGameLineups(gamePk).catch(() => null),
  ]);
  if (!vw && !lineups) return null;
  return {
    gamePk,
    venueId: vw?.venueId ?? null,
    venueName: vw?.venueName ?? null,
    weather: vw?.weather ?? {
      tempF: null,
      windSpeedMph: null,
      windDirection: null,
      condition: null,
      roofClosed: false,
    },
    lineups: lineups ?? { home: [], away: [] },
  };
}

// ---------- Lineup helpers ----------

// Project plate appearances based on batting-order spot. Top of the
// order naturally turns over to ~4.6 PA/game; bottom drops to ~3.6.
// MLB-wide average is ~4.0. Used to scale counting-stat projections
// (hits, runs, RBIs, HR) when we know the player's lineup spot.
//
// Numbers from public lineup-PA research; reasonable for the
// regular season. Postseason / extra-inning skews are ignored.
const PA_BY_ORDER: Record<number, number> = {
  1: 4.65,
  2: 4.55,
  3: 4.40,
  4: 4.25,
  5: 4.10,
  6: 3.95,
  7: 3.80,
  8: 3.70,
  9: 3.60,
};

const LEAGUE_AVG_PA = 4.0;

// Multiplier on counting stats given a lineup spot. 1 = neutral.
// Returns 1.0 when spot is unknown.
export function lineupPaMultiplier(battingOrder: number | null): number {
  if (battingOrder === null) return 1.0;
  const pa = PA_BY_ORDER[battingOrder];
  if (!pa) return 1.0;
  return pa / LEAGUE_AVG_PA;
}

// Find a player's batting order spot in either lineup; null when the
// player isn't in tonight's posted lineup (sat / pinch-hit only / not
// posted yet).
export function findPlayerLineupSpot(
  lineups: GameLineups,
  playerId: number,
): { battingOrder: number; isHome: boolean } | null {
  for (const slot of lineups.home) {
    if (slot.playerId === playerId) return { battingOrder: slot.battingOrder, isHome: true };
  }
  for (const slot of lineups.away) {
    if (slot.playerId === playerId) return { battingOrder: slot.battingOrder, isHome: false };
  }
  return null;
}

// ---------- BvP (batter vs pitcher) ----------

export type BvpStats = {
  plateAppearances: number;
  atBats: number;
  hits: number;
  doubles: number;
  triples: number;
  homeRuns: number;
  walks: number;
  strikeouts: number;
  // Reliability tier per spec. Drives how much weight the engine puts
  // on BvP vs the broader player-history baseline.
  reliability: 'noise' | 'weak' | 'moderate' | 'meaningful';
};

type VsPlayerStatsResponse = {
  stats?: Array<{
    splits?: Array<{
      stat?: {
        plateAppearances?: number | string;
        atBats?: number | string;
        hits?: number | string;
        doubles?: number | string;
        triples?: number | string;
        homeRuns?: number | string;
        baseOnBalls?: number | string;
        strikeOuts?: number | string;
      };
    }>;
  }>;
};

function asInt(v: unknown): number {
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  return 0;
}

function reliabilityFromPa(pa: number): BvpStats['reliability'] {
  if (pa < 10) return 'noise';
  if (pa < 25) return 'weak';
  if (pa < 50) return 'moderate';
  return 'meaningful';
}

// Career hitter-vs-pitcher matchup from the MLB API. Returns null
// when there's no recorded matchup (different leagues, brand-new
// pitcher, etc).
export async function getBvpStats(
  batterId: number,
  pitcherId: number,
): Promise<BvpStats | null> {
  try {
    const data = await fetchJson<VsPlayerStatsResponse>(
      `/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}`,
    );
    const split = data.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return null;
    const pa = asInt(split.plateAppearances);
    if (pa === 0) return null;
    return {
      plateAppearances: pa,
      atBats:           asInt(split.atBats),
      hits:             asInt(split.hits),
      doubles:          asInt(split.doubles),
      triples:          asInt(split.triples),
      homeRuns:         asInt(split.homeRuns),
      walks:            asInt(split.baseOnBalls),
      strikeouts:       asInt(split.strikeOuts),
      reliability:      reliabilityFromPa(pa),
    };
  } catch {
    return null;
  }
}
