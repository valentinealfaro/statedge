// Thin client for the MLB Stats API (statsapi.mlb.com) — public,
// free, no auth required. Spec: https://statsapi.mlb.com/docs/
//
// Unlike stats.nba.com (which is picky about headers and rate-limits
// aggressively from datacenter IPs), this API is happy to be called
// from anywhere without special headers. Still, we keep calls
// sequential in sync scripts and sleep between players to be polite.
//
// Sport id 1 = MLB. The API supports many sports under different IDs
// (1=MLB, 11=AAA, etc.) but StatEdge only consumes MLB.

const BASE = 'https://statsapi.mlb.com/api/v1';
const SPORT_ID = 1;
const FETCH_TIMEOUT_MS = 10000;

// Legal/compliance: required disclaimer surfaced anywhere we render
// MLB analytics. Sourced from the StatEdge MLB build spec — keep
// verbatim so frontend and reports always show the same wording.
export const MLB_DISCLAIMER =
  'StatEdge provides sports analytics, projections, probability ' +
  'estimates, and historical trend analysis only. StatEdge does not ' +
  'provide gambling advice, financial advice, or guaranteed outcomes. ' +
  'Users are responsible for how they interpret and use the information.';

export class MlbApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'MlbApiError';
  }
}

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
      throw new MlbApiError(`MLB API ${path} ${res.status}: ${body.slice(0, 200)}`, res.status);
    }
    return (await res.json()) as T;
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new MlbApiError(`MLB API ${path} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------- Teams ----------

export type MlbTeam = {
  id: number;
  abbreviation: string;
  name: string;
  teamName: string;
  locationName: string;
  league: { id: number; name: string };
  division: { id: number; name: string };
};

export async function getTeams(): Promise<MlbTeam[]> {
  const data = await fetchJson<{ teams: MlbTeam[] }>(
    `/teams?sportId=${SPORT_ID}&activeStatus=ACTIVE`,
  );
  return data.teams ?? [];
}

// ---------- Players ----------

export type MlbPlayer = {
  id: number;
  fullName: string;
  firstName?: string;
  lastName?: string;
  primaryNumber?: string;
  primaryPosition?: { code: string; abbreviation: string };
  batSide?: { code: 'L' | 'R' | 'S' };
  pitchHand?: { code: 'L' | 'R' };
  active?: boolean;
  currentTeam?: { id: number };
};

// All active players across MLB for a given season. The API's
// `/sports/1/players` endpoint returns the league-wide roster
// snapshot — much faster than walking every team's 40-man.
export async function getAllPlayers(season: number): Promise<MlbPlayer[]> {
  const data = await fetchJson<{ people: MlbPlayer[] }>(
    `/sports/${SPORT_ID}/players?season=${season}`,
  );
  return data.people ?? [];
}

// ---------- Schedule ----------

export type MlbScheduleGame = {
  gamePk: number;
  gameDate: string;          // ISO datetime
  officialDate: string;      // YYYY-MM-DD (use this for game_date)
  status: { abstractGameState: string; detailedState: string };
  teams: {
    home: { team: { id: number }; score?: number };
    away: { team: { id: number }; score?: number };
  };
  venue: { name: string };
  season: string;
};

// Schedule for a single date. Returns { dates: [{ games: [...] }] }
// — flatten before returning so callers don't unwrap.
export async function getSchedule(date: string): Promise<MlbScheduleGame[]> {
  const data = await fetchJson<{
    dates: Array<{ games: MlbScheduleGame[] }>;
  }>(`/schedule?sportId=${SPORT_ID}&date=${date}`);
  const dates = data.dates ?? [];
  return dates.flatMap((d) => d.games ?? []);
}

// Schedule across a date range. Used by the games sync to pull a
// season's worth of game IDs. The API caps response size, so callers
// should chunk by month.
export async function getScheduleRange(
  startDate: string,
  endDate: string,
): Promise<MlbScheduleGame[]> {
  const data = await fetchJson<{
    dates: Array<{ games: MlbScheduleGame[] }>;
  }>(
    `/schedule?sportId=${SPORT_ID}&startDate=${startDate}&endDate=${endDate}`,
  );
  const dates = data.dates ?? [];
  return dates.flatMap((d) => d.games ?? []);
}

// ---------- Game logs (per-player) ----------

export type MlbGameLogEntry = {
  date: string;                                  // YYYY-MM-DD
  gamePk: number;
  team: { id: number };
  opponent: { id: number };
  isHome: boolean;
  isWin?: boolean;
  // Hitting fields (only present when group=hitting):
  plateAppearances?: number;
  atBats?: number;
  hits?: number;
  doubles?: number;
  triples?: number;
  homeRuns?: number;
  totalBases?: number;
  runs?: number;
  rbi?: number;
  baseOnBalls?: number;
  strikeOuts?: number;
  stolenBases?: number;
  caughtStealing?: number;
  hitByPitch?: number;
  // Pitching fields (only present when group=pitching):
  inningsPitched?: string;          // "5.2" = 5 ⅔
  pitchesThrown?: number;
  hitsAllowed?: number;
  runsAllowed?: number;
  earnedRuns?: number;
  baseOnBallsAllowed?: number;
  strikeOutsThrown?: number;
  homeRunsAllowed?: number;
  gamesStarted?: number;
};

type RawGameLogStat = {
  date?: string;
  game?: { gamePk?: number };
  team?: { id?: number };
  opponent?: { id?: number };
  isHome?: boolean;
  stat?: Record<string, unknown>;
};

type RawGameLogResponse = {
  stats?: Array<{
    group?: { displayName?: string };
    splits?: RawGameLogStat[];
  }>;
};

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : undefined;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// Per-player game log for hitting OR pitching in a given season. The
// MLB API returns a stats array with one element per requested group;
// we pass a single group to keep the response lean and the mapping
// simple. Sequential calls only — no parallel-spam (the spec is firm).
export async function getGameLog(
  playerId: number,
  season: number,
  group: 'hitting' | 'pitching',
): Promise<MlbGameLogEntry[]> {
  const data = await fetchJson<RawGameLogResponse>(
    `/people/${playerId}/stats?stats=gameLog&group=${group}&season=${season}`,
  );
  const stats = data.stats ?? [];
  const splits = stats[0]?.splits ?? [];
  return splits.map((s) => mapGameLogSplit(s, group));
}

function mapGameLogSplit(
  s: RawGameLogStat,
  group: 'hitting' | 'pitching',
): MlbGameLogEntry {
  const stat = s.stat ?? {};
  const base: MlbGameLogEntry = {
    date: s.date ?? '',
    gamePk: s.game?.gamePk ?? 0,
    team: { id: s.team?.id ?? 0 },
    opponent: { id: s.opponent?.id ?? 0 },
    isHome: Boolean(s.isHome),
  };
  if (group === 'hitting') {
    return {
      ...base,
      plateAppearances: asInt(stat.plateAppearances),
      atBats:           asInt(stat.atBats),
      hits:             asInt(stat.hits),
      doubles:          asInt(stat.doubles),
      triples:          asInt(stat.triples),
      homeRuns:         asInt(stat.homeRuns),
      totalBases:       asInt(stat.totalBases),
      runs:             asInt(stat.runs),
      rbi:              asInt(stat.rbi),
      baseOnBalls:      asInt(stat.baseOnBalls),
      strikeOuts:       asInt(stat.strikeOuts),
      stolenBases:      asInt(stat.stolenBases),
      caughtStealing:   asInt(stat.caughtStealing),
      hitByPitch:       asInt(stat.hitByPitch),
    };
  }
  // pitching
  return {
    ...base,
    inningsPitched:    asString(stat.inningsPitched),
    pitchesThrown:     asInt(stat.numberOfPitches),
    hitsAllowed:       asInt(stat.hits),
    runsAllowed:       asInt(stat.runs),
    earnedRuns:        asInt(stat.earnedRuns),
    baseOnBallsAllowed:asInt(stat.baseOnBalls),
    strikeOutsThrown:  asInt(stat.strikeOuts),
    homeRunsAllowed:   asInt(stat.homeRuns),
    gamesStarted:      asInt(stat.gamesStarted),
  };
}

// ---------- Helpers ----------

// MLB schedule entries report league/division by ID. We hardcode the
// AL/NL split because the API's `/leagues` endpoint returns a verbose
// shape and the mapping doesn't change. League ids: 103 = AL, 104 = NL.
export function leagueCodeFromId(leagueId: number): 'AL' | 'NL' | null {
  if (leagueId === 103) return 'AL';
  if (leagueId === 104) return 'NL';
  return null;
}

// Convert "5.2" innings (5 ⅔) → numeric for storage. NUMERIC in
// Postgres can hold the exact value; we store as 5.6667 since that's
// the actual fractional innings (.1 = ⅓, .2 = ⅔).
export function inningsPitchedToNumeric(ip?: string): number | null {
  if (!ip) return null;
  const m = /^(\d+)(?:\.(\d))?$/.exec(ip);
  if (!m) return null;
  const whole = Number(m[1]);
  const tenths = Number(m[2] ?? '0');
  if (tenths === 1) return whole + 1 / 3;
  if (tenths === 2) return whole + 2 / 3;
  return whole;
}

// Polite-sleep helper used by sync scripts between sequential player
// calls. The MLB API is generous but we still don't want to hammer.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
