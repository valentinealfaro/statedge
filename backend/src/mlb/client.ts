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

// "Today's" date in Eastern Time — the canonical sports timezone.
// Using raw UTC (`new Date().toISOString().slice(0,10)`) rolls the
// date over at 7 PM CT during DST, which surfaces tomorrow's slate
// while users still have games TONIGHT. ET keeps the rollover at
// midnight Eastern, matching every league's schedule + ESPN + every
// sportsbook + how users intuitively think about "tonight's games."
function todayEt(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

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
  // batSide / pitchHand codes from the MLB API. 'L' / 'R' for left /
  // right; 'S' for switch-hitters (and the rare switch-pitcher).
  // Typed as `string` because the upstream sometimes ships codes
  // outside this set — the upserter coerces unknowns to NULL rather
  // than crashing on the CHECK constraint.
  batSide?: { code: string };
  pitchHand?: { code: string };
  active?: boolean;
  currentTeam?: { id: number };
};

// All players across MLB for a given season. The fast path is the
// league-wide `/sports/1/players` endpoint, but it OMITS players on
// the IL — discovered when Nick Lodolo (CIN, on IL 2026-05-08) was
// missing from a fresh sync even though PrizePicks was actively
// posting lines for him. To cover IL + 40-man-only players we also
// walk each team's 40-man roster and merge by playerId.
//
// Cost: 1 league call + 30 team calls (sequential to be polite to
// statsapi). Adds ~3-5s to the sync at most.
export async function getAllPlayers(season: number): Promise<MlbPlayer[]> {
  const leagueData = await fetchJson<{ people: MlbPlayer[] }>(
    `/sports/${SPORT_ID}/players?season=${season}`,
  );
  const leaguePlayers = leagueData.people ?? [];

  // Pull 40-man rosters per team. Each entry has a `person` ref —
  // hydrate it into a full MlbPlayer-shaped record by re-fetching
  // /people/{id} where needed. To keep the call count sane we only
  // re-fetch IDs that aren't already in the league snapshot.
  const teams = await fetchJson<{ teams: Array<{ id: number }> }>(
    `/teams?sportId=${SPORT_ID}`,
  );
  const seen = new Set<number>(leaguePlayers.map((p) => p.id));
  const extraIds: number[] = [];
  const teamIdByPersonId = new Map<number, number>();
  for (const t of teams.teams ?? []) {
    try {
      const roster = await fetchJson<{
        roster: Array<{ person: { id: number; fullName: string } }>;
      }>(`/teams/${t.id}/roster?rosterType=40Man`);
      for (const r of roster.roster ?? []) {
        if (!seen.has(r.person.id)) {
          extraIds.push(r.person.id);
          teamIdByPersonId.set(r.person.id, t.id);
          seen.add(r.person.id);
        }
      }
    } catch {
      // Roster fetch failed for one team — keep going. The league
      // snapshot already covered most players.
    }
  }

  // Hydrate each missing ID via /people/{id}?hydrate=currentTeam to
  // get the full shape (position, bats/throws, currentTeam) the
  // upserter expects. Sequential to avoid hammering statsapi.
  const extras: MlbPlayer[] = [];
  for (const id of extraIds) {
    try {
      const data = await fetchJson<{ people: MlbPlayer[] }>(
        `/people/${id}?hydrate=currentTeam`,
      );
      const person = data.people?.[0];
      if (person) {
        // /people response sometimes omits currentTeam if the player
        // has no MLB games this season; backfill from our roster scan.
        if (!person.currentTeam && teamIdByPersonId.has(id)) {
          person.currentTeam = { id: teamIdByPersonId.get(id)! };
        }
        extras.push(person);
      }
    } catch {
      // Skip individual hydration failures — they're rare and don't
      // block the bulk sync.
    }
  }

  return [...leaguePlayers, ...extras];
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

// ---------- Today's games + probable pitchers ----------

export type MlbProbablePitcher = {
  id: number;
  fullName: string;
  // Season stats embedded via hydrate. All optional — pitcher may
  // not have stats yet (rookie, just promoted, etc.).
  era: number | null;
  wins: number | null;
  losses: number | null;
  inningsPitched: number | null;
  strikeouts: number | null;
  walks: number | null;
  whip: number | null;
  hitsAllowed: number | null;
  homeRunsAllowed: number | null;
  earnedRuns: number | null;
  battersFaced: number | null;
};

export type MlbTodayGame = {
  gamePk: number;
  gameDate: string;                 // ISO datetime
  officialDate: string;             // YYYY-MM-DD
  status: {
    abstractGameState: string;       // 'Preview' | 'Live' | 'Final'
    detailedState: string;           // human label
    inProgress: boolean;
  };
  home: {
    id: number;
    abbreviation: string;
    name: string;
    score: number | null;
    record: string | null;            // "12-8" overall
    homeRecord: string | null;        // "10-8 Home"
    awayRecord: string | null;        // (always null on home side)
  };
  away: {
    id: number;
    abbreviation: string;
    name: string;
    score: number | null;
    record: string | null;
    homeRecord: string | null;
    awayRecord: string | null;        // "6-13 Away"
  };
  venue: string | null;
  weather: {
    condition: string | null;        // "Sunny" / "Cloudy" / "Rain"
    temp: string | null;             // "69" (degrees F)
    wind: string | null;             // "5 mph, In From RF"
  } | null;
  probablePitchers: {
    home: MlbProbablePitcher | null;
    away: MlbProbablePitcher | null;
  };
};

// Raw shape from `/schedule?sportId=1&date=&hydrate=probablePitcher,team,linescore`.
// hydrate=probablePitcher(stats(group=[pitching],type=[season])) gives
// us season ERA / W-L / etc. inline. Single API call per slate day.
type RawScheduleResponse = {
  dates: Array<{
    games: RawScheduleGame[];
  }>;
};

type RawScheduleGame = {
  gamePk: number;
  gameDate: string;
  officialDate: string;
  status: {
    abstractGameState?: string;
    detailedState?: string;
    inProgress?: boolean;
  };
  teams: {
    home: RawScheduleTeam;
    away: RawScheduleTeam;
  };
  venue?: { name?: string };
  weather?: {
    condition?: string;
    temp?: string;       // degrees F as string
    wind?: string;
  };
};

type RawScheduleTeam = {
  team: {
    id: number;
    abbreviation?: string;
    name?: string;
  };
  score?: number;
  // Record going INTO the game. We use this only as a fallback when
  // the parallel /standings call fails. Primary source for both
  // overall + home/away splits is /standings.
  leagueRecord?: { wins?: number; losses?: number };
  probablePitcher?: RawProbablePitcher;
};

type RawProbablePitcher = {
  id: number;
  fullName: string;
  // When hydrated with stats, MLB returns a `stats` array with a
  // single season-pitching split. Field names are camelCase numerics
  // typed as either number or string (pg-style).
  stats?: Array<{
    type?: { displayName?: string };
    group?: { displayName?: string };
    splits?: Array<{
      stat?: Record<string, unknown>;
    }>;
  }>;
};

// Coercers for the probable-pitcher hydrate (separate from the
// gameLog asInt/asString above which return number|undefined).
// These return null on failure so they fit the `number | null`
// fields on MlbProbablePitcher cleanly.
function asIntOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

function asNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Pull the season pitching split from the probable-pitcher stats
// payload. The hydrate returns multiple stat groups (career, season,
// etc) — we want type=season + group=pitching.
function extractProbablePitcher(p: RawProbablePitcher | undefined): MlbProbablePitcher | null {
  if (!p) return null;
  const seasonSplit = p.stats?.find((s) =>
    (s.type?.displayName ?? '').toLowerCase().includes('season')
    && (s.group?.displayName ?? '').toLowerCase().includes('pitching'),
  )?.splits?.[0]?.stat;
  return {
    id: p.id,
    fullName: p.fullName,
    era: seasonSplit ? asNumberOrNull(seasonSplit.era) : null,
    wins: seasonSplit ? asIntOrNull(seasonSplit.wins) : null,
    losses: seasonSplit ? asIntOrNull(seasonSplit.losses) : null,
    inningsPitched: seasonSplit ? asNumberOrNull(inningsPitchedToNumeric(String(seasonSplit.inningsPitched ?? '0'))) : null,
    strikeouts: seasonSplit ? asIntOrNull(seasonSplit.strikeOuts) : null,
    walks: seasonSplit ? asIntOrNull(seasonSplit.baseOnBalls) : null,
    whip: seasonSplit ? asNumberOrNull(seasonSplit.whip) : null,
    hitsAllowed: seasonSplit ? asIntOrNull(seasonSplit.hits) : null,
    homeRunsAllowed: seasonSplit ? asIntOrNull(seasonSplit.homeRuns) : null,
    earnedRuns: seasonSplit ? asIntOrNull(seasonSplit.earnedRuns) : null,
    battersFaced: seasonSplit ? asIntOrNull(seasonSplit.battersFaced) : null,
  };
}

function buildRecord(t: RawScheduleTeam): string | null {
  const w = t.leagueRecord?.wins;
  const l = t.leagueRecord?.losses;
  if (w === undefined || l === undefined) return null;
  return `${w}-${l}`;
}

// Fetch /standings and build a per-team-id map of overall + home +
// away records. The /schedule endpoint's leagueRecord is the record
// COMING INTO the game (off-by-one for today's games once they start)
// and team(record) hydrate doesn't reliably expose splitRecords. The
// /standings endpoint is the canonical source for both.
type RawStandingsResponse = {
  records?: Array<{
    teamRecords?: Array<{
      team?: { id?: number };
      leagueRecord?: { wins?: number; losses?: number };
      records?: {
        splitRecords?: Array<{ wins?: number; losses?: number; type?: string }>;
      };
    }>;
  }>;
};

type TeamRecordSet = {
  overall: string | null;
  home: string | null;
  away: string | null;
};

async function getStandingsRecordsByTeamId(season: number): Promise<Map<number, TeamRecordSet>> {
  // 103 = AL, 104 = NL. Single call covers all 30 teams.
  const data = await fetchJson<RawStandingsResponse>(
    `/standings?leagueId=103,104&season=${season}`,
  );
  const out = new Map<number, TeamRecordSet>();
  for (const division of data.records ?? []) {
    for (const tr of division.teamRecords ?? []) {
      const id = tr.team?.id;
      if (id === undefined) continue;
      const overallW = tr.leagueRecord?.wins;
      const overallL = tr.leagueRecord?.losses;
      const splits = tr.records?.splitRecords ?? [];
      const homeSplit = splits.find((s) => (s.type ?? '').toLowerCase() === 'home');
      const awaySplit = splits.find((s) => (s.type ?? '').toLowerCase() === 'away');
      out.set(id, {
        overall: overallW !== undefined && overallL !== undefined ? `${overallW}-${overallL}` : null,
        home: homeSplit && homeSplit.wins !== undefined && homeSplit.losses !== undefined
          ? `${homeSplit.wins}-${homeSplit.losses}` : null,
        away: awaySplit && awaySplit.wins !== undefined && awaySplit.losses !== undefined
          ? `${awaySplit.wins}-${awaySplit.losses}` : null,
      });
    }
  }
  return out;
}

// Get every game on a given date (defaults to today). Hydrates
// probable pitchers + season stats + weather in one /schedule call,
// fetches /standings in parallel for accurate overall + home/away
// split records (the /schedule endpoint's leagueRecord is the record
// going INTO the game, which is off-by-one once games start).
export async function getTodaysMlbGames(date?: string): Promise<MlbTodayGame[]> {
  const targetDate = date ?? todayEt();
  const season = Number(targetDate.slice(0, 4));
  const hydrate = 'probablePitcher(stats(group=[pitching],type=[season])),team,linescore,weather';

  // Fan-out: schedule + standings in parallel. Standings is non-fatal
  // — if it fails, splits become null but the page still renders.
  const [data, standings] = await Promise.all([
    fetchJson<RawScheduleResponse>(
      `/schedule?sportId=${SPORT_ID}&date=${targetDate}&hydrate=${encodeURIComponent(hydrate)}`,
    ),
    getStandingsRecordsByTeamId(season).catch((err) => {
      console.warn('mlb standings fetch failed (records will lack splits):', (err as Error).message);
      return new Map<number, TeamRecordSet>();
    }),
  ]);

  const dates = data.dates ?? [];
  const games = dates.flatMap((d) => d.games ?? []);

  // Pick the right record per side: overall from standings (current
  // season), splits from standings. Fall back to leagueRecord on the
  // schedule game when standings is unavailable.
  const recordFor = (id: number, fallback: string | null): TeamRecordSet => {
    const s = standings.get(id);
    if (s) return s;
    return { overall: fallback, home: null, away: null };
  };

  const resolved: MlbTodayGame[] = games.map((g): MlbTodayGame => {
    const homeR = recordFor(g.teams.home.team.id, buildRecord(g.teams.home));
    const awayR = recordFor(g.teams.away.team.id, buildRecord(g.teams.away));
    return {
    gamePk: g.gamePk,
    gameDate: g.gameDate,
    officialDate: g.officialDate,
    status: {
      abstractGameState: g.status?.abstractGameState ?? 'Unknown',
      detailedState: g.status?.detailedState ?? 'Unknown',
      inProgress: Boolean(g.status?.inProgress),
    },
    home: {
      id: g.teams.home.team.id,
      abbreviation: g.teams.home.team.abbreviation ?? '?',
      name: g.teams.home.team.name ?? '',
      score: g.teams.home.score ?? null,
      record: homeR.overall,
      homeRecord: homeR.home,
      awayRecord: null,
    },
    away: {
      id: g.teams.away.team.id,
      abbreviation: g.teams.away.team.abbreviation ?? '?',
      name: g.teams.away.team.name ?? '',
      score: g.teams.away.score ?? null,
      record: awayR.overall,
      homeRecord: null,
      awayRecord: awayR.away,
    },
    venue: g.venue?.name ?? null,
    weather: g.weather && (g.weather.condition || g.weather.temp || g.weather.wind)
      ? {
          condition: g.weather.condition ?? null,
          temp: g.weather.temp ?? null,
          wind: g.weather.wind ?? null,
        }
      : null,
    probablePitchers: {
      home: extractProbablePitcher(g.teams.home.probablePitcher),
      away: extractProbablePitcher(g.teams.away.probablePitcher),
    },
    };
  });

  // The probablePitcher hydrate sometimes ships an empty stats array
  // (especially for recently-promoted starters whose season stats
  // haven't propagated to the schedule endpoint cache). Fall back to
  // a direct /people/:id/stats call per pitcher with missing data.
  // Parallel + best-effort — a fetch failure leaves the original
  // null values rather than crashing the whole rail.
  const fallbackTargets: Array<{ side: 'home' | 'away'; gameIdx: number; id: number; fullName: string }> = [];
  resolved.forEach((g, idx) => {
    const a = g.probablePitchers.away;
    const h = g.probablePitchers.home;
    const isEmpty = (p: typeof a): boolean =>
      !!p && p.era === null && p.wins === null && p.losses === null;
    if (a && isEmpty(a)) fallbackTargets.push({ side: 'away', gameIdx: idx, id: a.id, fullName: a.fullName });
    if (h && isEmpty(h)) fallbackTargets.push({ side: 'home', gameIdx: idx, id: h.id, fullName: h.fullName });
  });

  if (fallbackTargets.length > 0) {
    await Promise.allSettled(
      fallbackTargets.map(async (t) => {
        try {
          const stats = await getPitcherSeasonStats(t.id, season);
          if (!stats) return;
          // Patch the original probable-pitcher entry with the freshly
          // fetched season stats. Keep the name from the schedule
          // hydrate (the /stats endpoint omits it).
          const game = resolved[t.gameIdx]!;
          const target = t.side === 'home' ? game.probablePitchers.home : game.probablePitchers.away;
          if (target) {
            target.era = stats.era;
            target.wins = stats.wins;
            target.losses = stats.losses;
            target.inningsPitched = stats.inningsPitched;
            target.strikeouts = stats.strikeouts;
            target.walks = stats.walks;
            target.whip = stats.whip;
            target.hitsAllowed = stats.hitsAllowed;
            target.homeRunsAllowed = stats.homeRunsAllowed;
            target.earnedRuns = stats.earnedRuns;
            target.battersFaced = stats.battersFaced;
          }
        } catch {
          /* best-effort — original null stats stay */
        }
      }),
    );
  }

  return resolved;
}

// ---------- Per-pitcher season stats (ad-hoc) ----------

// Pull a single pitcher's season-pitching stats. Useful when a
// probable-pitcher entry didn't have stats hydrated (rare) or when
// the slate engine wants opposing-pitcher context for projection
// adjustments. One call to /people/{id}/stats with season group.
export async function getPitcherSeasonStats(
  playerId: number,
  season?: number,
): Promise<MlbProbablePitcher | null> {
  const seasonValue = season ?? new Date().getUTCFullYear();
  const data = await fetchJson<{
    stats?: Array<{
      type?: { displayName?: string };
      group?: { displayName?: string };
      splits?: Array<{ stat?: Record<string, unknown> }>;
    }>;
    people?: Array<{ fullName?: string }>;
  }>(
    `/people/${playerId}/stats?stats=season&group=pitching&season=${seasonValue}`,
  );
  const seasonSplit = data.stats?.[0]?.splits?.[0]?.stat;
  if (!seasonSplit) return null;
  // We don't have the player's name from this endpoint — return id +
  // stats; caller can resolve name from mlb_players if needed.
  return {
    id: playerId,
    fullName: '',     // caller fills in
    era: asNumberOrNull(seasonSplit.era),
    wins: asIntOrNull(seasonSplit.wins),
    losses: asIntOrNull(seasonSplit.losses),
    inningsPitched: asNumberOrNull(inningsPitchedToNumeric(String(seasonSplit.inningsPitched ?? '0'))),
    strikeouts: asIntOrNull(seasonSplit.strikeOuts),
    walks: asIntOrNull(seasonSplit.baseOnBalls),
    whip: asNumberOrNull(seasonSplit.whip),
    hitsAllowed: asIntOrNull(seasonSplit.hits),
    homeRunsAllowed: asIntOrNull(seasonSplit.homeRuns),
    earnedRuns: asIntOrNull(seasonSplit.earnedRuns),
    battersFaced: asIntOrNull(seasonSplit.battersFaced),
  };
}

// ---------- ESPN moneyline odds (public scoreboard JSON) ----------

// ESPN's MLB scoreboard exposes per-game moneyline odds when the
// market is up (DraftKings is the default provider). Same public
// endpoint we already use for NBA — no scraping, no API key.
//
// Mission framing: we ingest odds as an INSTITUTIONAL signal
// (implied win probability for game-script context), not as a
// betting recommendation. The frontend renders the implied prob
// with the raw odds on hover.

const ESPN_MLB_BASE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb';

export type EspnMlbOdds = {
  // Raw moneyline odds — American format. Negative = favorite (e.g.
  // -136 means bet $136 to win $100). Positive = underdog (+113 means
  // bet $100 to win $113).
  homeMl: number | null;
  awayMl: number | null;
  // Implied win probability (0-100) derived from ML odds. Standard
  // moneyline formula. Reflects sportsbook consensus, not our model.
  homeImpliedWinProb: number | null;
  awayImpliedWinProb: number | null;
  provider: string | null;            // "DraftKings" usually
};

type RawEspnEvent = {
  id: string;
  competitions?: Array<{
    competitors?: Array<{
      homeAway?: 'home' | 'away';
      team?: { abbreviation?: string };
    }>;
    odds?: Array<{
      provider?: { name?: string };
      homeTeamOdds?: { moneyLine?: number };
      awayTeamOdds?: { moneyLine?: number };
      details?: string;
    }>;
  }>;
  // Cross-reference to MLB Stats API gamePk via the score-link.
  // ESPN doesn't ship gamePk directly but the abbreviations + date
  // are enough to match against the MLB Stats response.
};

// Convert American moneyline odds → implied win probability (0-100).
// Standard formula: positive odds → 100 / (odds + 100); negative
// odds → -odds / (-odds + 100). Returns null when odds aren't set.
export function moneylineToImpliedProb(odds: number | null): number | null {
  if (odds === null || !Number.isFinite(odds)) return null;
  if (odds > 0) return Math.round((100 / (odds + 100)) * 1000) / 10;
  if (odds < 0) return Math.round((-odds / (-odds + 100)) * 1000) / 10;
  return null;
}

// Pull ESPN's MLB scoreboard for the given date. Returns a map keyed
// by `${homeAbbr}-${awayAbbr}` so the caller can merge by team match
// (we don't have gamePk in ESPN's response). Keyless when odds are
// missing for a game (early-week, market not yet open, etc).
export async function getEspnMlbOddsByMatchup(
  date?: string,
): Promise<Map<string, EspnMlbOdds>> {
  const targetDate = date ?? todayEt();
  // ESPN expects YYYYMMDD without dashes for the dates query.
  const compactDate = targetDate.replace(/-/g, '');
  const url = `${ESPN_MLB_BASE}/scoreboard?dates=${compactDate}`;
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return new Map();        // graceful fallback
    const data = (await res.json()) as { events?: RawEspnEvent[] };
    const result = new Map<string, EspnMlbOdds>();
    for (const event of data.events ?? []) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find((c) => c.homeAway === 'home');
      const away = comp.competitors?.find((c) => c.homeAway === 'away');
      const homeAbbr = home?.team?.abbreviation;
      const awayAbbr = away?.team?.abbreviation;
      if (!homeAbbr || !awayAbbr) continue;
      const odds = comp.odds?.[0];
      const homeMl = typeof odds?.homeTeamOdds?.moneyLine === 'number'
        ? odds.homeTeamOdds.moneyLine
        : null;
      const awayMl = typeof odds?.awayTeamOdds?.moneyLine === 'number'
        ? odds.awayTeamOdds.moneyLine
        : null;
      result.set(`${homeAbbr}-${awayAbbr}`, {
        homeMl,
        awayMl,
        homeImpliedWinProb: moneylineToImpliedProb(homeMl),
        awayImpliedWinProb: moneylineToImpliedProb(awayMl),
        provider: odds?.provider?.name ?? null,
      });
    }
    return result;
  } catch {
    return new Map();
  } finally {
    clearTimeout(timeoutId);
  }
}

// In-process cache for ESPN odds. The slate pipeline calls
// `projectMlbStat` for each leg sequentially; without caching we'd
// fetch the ESPN scoreboard N times for an N-leg slate. 5-minute
// TTL is plenty since odds barely move and the slate flow finishes
// in seconds. Keyed by date string ("2026-05-08").
const oddsCache = new Map<string, { fetchedAt: number; data: Map<string, EspnMlbOdds> }>();
const ODDS_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getEspnMlbOddsCached(
  date?: string,
): Promise<Map<string, EspnMlbOdds>> {
  const key = date ?? todayEt();
  const cached = oddsCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ODDS_CACHE_TTL_MS) {
    return cached.data;
  }
  const fresh = await getEspnMlbOddsByMatchup(date);
  oddsCache.set(key, { fetchedAt: Date.now(), data: fresh });
  return fresh;
}

// Re-export internals so the test file can probe the parser
// without going through the network.
export const _mlbInternals = {
  extractProbablePitcher,
  moneylineToImpliedProb,
  asIntOrNull,
  asNumberOrNull,
};

// Days in a calendar month (1-indexed: 1=Jan...12=Dec). Leap-year
// aware. Critical for the schedule sync — passing "2026-04-31" to
// the MLB API silently drops the request, so we walk month-by-month
// using the actual last day. Years like 2024 (leap) return 29 for Feb.
export function daysInMonth(year: number, month1Indexed: number): number {
  // JS Date months are 0-indexed but day=0 means "day before the 1st",
  // which lands on the previous month's last day. So passing the
  // 1-indexed month directly lines up: Date.UTC(2026, 4, 0) = April 30.
  return new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate();
}

// ---------- Game preview (Phase B): lineups + injuries ----------
//
// The boxscore endpoint returns lineups (battingOrder = ordered list
// of player IDs) plus the per-player object with name + position +
// season stats baked in. Pre-game it's typically empty until ~2 hours
// before first pitch, when MLB posts the official lineups.

export type MlbBoxscoreBatting = {
  atBats?: number;
  hits?: number;
  runs?: number;
  rbi?: number;
  baseOnBalls?: number;
  strikeOuts?: number;
  doubles?: number;
  triples?: number;
  homeRuns?: number;
  totalBases?: number;
  stolenBases?: number;
  hitByPitch?: number;
};

export type MlbBoxscorePitching = {
  inningsPitched?: string;
  strikeOuts?: number;
  hits?: number;
  earnedRuns?: number;
  baseOnBalls?: number;
  homeRuns?: number;
  outs?: number;
};

export type MlbBoxscorePlayer = {
  person: { id: number; fullName: string };
  position: { code: string; abbreviation: string; type?: string };
  battingOrder?: string;            // "100","200" etc, hundreds = batting order
  status: { code: string; description: string };
  seasonStats?: {
    batting?: { avg?: string; homeRuns?: number; rbi?: number; ops?: string };
    pitching?: { era?: string; wins?: number; losses?: number; strikeOuts?: number };
  };
  stats?: {
    batting?: MlbBoxscoreBatting;
    pitching?: MlbBoxscorePitching;
  };
};

export type MlbBoxscoreSide = {
  team: { id: number; name: string; abbreviation?: string };
  battingOrder?: number[];
  players: Record<string, MlbBoxscorePlayer>;
};

export type MlbBoxscore = {
  teams: { home: MlbBoxscoreSide; away: MlbBoxscoreSide };
};

export async function getBoxscore(gamePk: number): Promise<MlbBoxscore> {
  return fetchJson<MlbBoxscore>(`/game/${gamePk}/boxscore`);
}

export type MlbRosterEntry = {
  person: { id: number; fullName: string };
  position: { abbreviation?: string; name?: string };
  status: { code?: string; description?: string };
};

// Players currently on the team's IL. The MLB Stats API exposes
// /teams/:id/roster?rosterType=injuredList — the older "injuryList"
// alias was deprecated; per the docs `injuredList` is the canonical
// roster code in 2024+. Returns [] silently if the endpoint changes.
export async function getTeamInjuredList(teamId: number): Promise<MlbRosterEntry[]> {
  try {
    const data = await fetchJson<{ roster?: MlbRosterEntry[] }>(
      `/teams/${teamId}/roster?rosterType=injuredList`,
    );
    return data.roster ?? [];
  } catch {
    return [];
  }
}

// ---------- Live game feed (Phase C: play-by-play) ----------
//
// The /api/v1.1/game/:gamePk/feed/live endpoint is the canonical live
// game feed. It's huge (~2 MB) — we slim it down to just the plays
// list + current state in the route handler. We only call it when
// the game is in-progress; pre-game and final fall through to the
// lighter endpoints we already use.

export type MlbLivePlayResult = {
  type?: string;
  event?: string;
  eventType?: string;
  description?: string;
  rbi?: number;
  awayScore?: number;
  homeScore?: number;
};

export type MlbLivePlayAbout = {
  atBatIndex?: number;
  halfInning?: 'top' | 'bottom';
  isTopInning?: boolean;
  inning?: number;
  startTime?: string;
  endTime?: string;
  isComplete?: boolean;
  isScoringPlay?: boolean;
};

export type MlbLivePlay = {
  result: MlbLivePlayResult;
  about: MlbLivePlayAbout;
  matchup?: {
    batter?: { id: number; fullName: string };
    pitcher?: { id: number; fullName: string };
    batSide?: { code: string };
    pitchHand?: { code: string };
    splits?: { menOnBase?: string };
  };
  count?: { balls?: number; strikes?: number; outs?: number };
};

export type MlbLiveBoxscorePlayerStats = {
  batting?: {
    atBats?: number;
    runs?: number;
    hits?: number;
    doubles?: number;
    triples?: number;
    homeRuns?: number;
    rbi?: number;
    baseOnBalls?: number;
    strikeOuts?: number;
    stolenBases?: number;
    totalBases?: number;
    hitByPitch?: number;
  };
  pitching?: {
    inningsPitched?: string;
    hits?: number;
    runs?: number;
    earnedRuns?: number;
    baseOnBalls?: number;
    strikeOuts?: number;
    homeRuns?: number;
    outs?: number;
  };
};

export type MlbLiveBoxscorePlayer = {
  person: { id: number; fullName: string };
  stats?: MlbLiveBoxscorePlayerStats;
};

export type MlbLiveFeed = {
  gameData: {
    status: { codedGameState: string; detailedState: string; abstractGameState: string };
    teams: { away: { abbreviation?: string }; home: { abbreviation?: string } };
  };
  liveData: {
    plays: {
      allPlays: MlbLivePlay[];
      currentPlay?: MlbLivePlay;
      scoringPlays?: number[];     // indices into allPlays
    };
    linescore?: {
      currentInning?: number;
      currentInningOrdinal?: string;
      inningHalf?: 'Top' | 'Bottom';
      isTopInning?: boolean;
      balls?: number;
      strikes?: number;
      outs?: number;
      offense?: {
        first?: { fullName?: string };
        second?: { fullName?: string };
        third?: { fullName?: string };
        batter?: { fullName?: string };
        pitcher?: { fullName?: string };
      };
      teams?: {
        home?: { runs?: number; hits?: number; errors?: number; leftOnBase?: number };
        away?: { runs?: number; hits?: number; errors?: number; leftOnBase?: number };
      };
      innings?: Array<{
        num?: number;
        ordinalNum?: string;
        home?: { runs?: number; hits?: number; errors?: number; leftOnBase?: number };
        away?: { runs?: number; hits?: number; errors?: number; leftOnBase?: number };
      }>;
    };
    boxscore?: {
      teams: {
        away: { players: Record<string, MlbLiveBoxscorePlayer> };
        home: { players: Record<string, MlbLiveBoxscorePlayer> };
      };
    };
  };
};

// Win-probability snapshots — one entry per at-bat. MLB exposes
// these at /api/v1/game/{gamePk}/winProbability separately from
// feed/live so the live route can fetch in parallel without
// inflating the 2MB feed payload.
export type MlbWinProbabilityEntry = {
  atBatIndex: number;
  inning: number;
  halfInning: 'top' | 'bottom';
  homeWinProbability: number;          // 0-100
  awayWinProbability: number;          // 0-100
  homeTeamWinProbabilityAdded: number; // delta added by this play
};

type RawWinProbabilityEntry = {
  atBatIndex?: number;
  about?: {
    inning?: number;
    halfInning?: string;
  };
  homeTeamWinProbability?: number;
  awayTeamWinProbability?: number;
  homeTeamWinProbabilityAdded?: number;
};

export async function getWinProbabilityHistory(
  gamePk: number,
): Promise<MlbWinProbabilityEntry[]> {
  try {
    const data = await fetchJson<RawWinProbabilityEntry[]>(
      `/game/${gamePk}/winProbability`,
    );
    if (!Array.isArray(data)) return [];
    return data
      .filter((d) => d.atBatIndex !== undefined && d.about?.inning !== undefined)
      .map((d) => ({
        atBatIndex: d.atBatIndex!,
        inning: d.about!.inning!,
        halfInning: (d.about?.halfInning ?? 'top') as 'top' | 'bottom',
        homeWinProbability: d.homeTeamWinProbability ?? 50,
        awayWinProbability: d.awayTeamWinProbability ?? 50,
        homeTeamWinProbabilityAdded: d.homeTeamWinProbabilityAdded ?? 0,
      }));
  } catch {
    return [];
  }
}

// statsapi.mlb.com hosts the live feed under /api/v1.1 (different
// version than the rest). We hit it with a one-off URL since our
// fetchJson helper assumes /api/v1.
export async function getLiveGameFeed(gamePk: number): Promise<MlbLiveFeed> {
  const url = `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      throw new MlbApiError(`MLB live feed ${gamePk} ${res.status}`, res.status);
    }
    return (await res.json()) as MlbLiveFeed;
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new MlbApiError(`MLB live feed ${gamePk} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
