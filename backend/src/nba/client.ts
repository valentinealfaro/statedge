// Thin client for stats.nba.com — the same endpoints nba_api wraps.
// stats.nba.com is picky about headers; missing them returns 403.

const BASE = 'https://stats.nba.com/stats';

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  'Connection': 'keep-alive',
};

type StatsResponse = {
  resultSets: Array<{
    name: string;
    headers: string[];
    rowSet: unknown[][];
  }>;
};

const FETCH_TIMEOUT_MS = 8000;

export class NbaUpstreamBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NbaUpstreamBlockedError';
  }
}

async function fetchStats(endpoint: string, params: Record<string, string>): Promise<StatsResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}/${endpoint}?${qs}`;
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`NBA stats ${endpoint} ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return (await res.json()) as StatsResponse;
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new NbaUpstreamBlockedError(
        `stats.nba.com timed out after ${FETCH_TIMEOUT_MS}ms — likely blocked from this datacenter IP. Populate the DB via "npm run db:sync-players" and serve from cache.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function rowsToObjects(rs: StatsResponse['resultSets'][number]): Record<string, unknown>[] {
  return rs.rowSet.map((row) => {
    const o: Record<string, unknown> = {};
    rs.headers.forEach((h, i) => (o[h] = row[i]));
    return o;
  });
}

export type NbaPlayer = {
  id: number;
  fullName: string;
  firstName: string;
  lastName: string;
  teamId: number | null;
  teamAbbreviation: string | null;
  isActive: boolean;
};

let cache: { at: number; players: NbaPlayer[] } | null = null;
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function getAllPlayers(): Promise<NbaPlayer[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.players;

  // CommonAllPlayers — full historical roster. IsOnlyCurrentSeason=0 means "all players ever".
  const data = await fetchStats('commonallplayers', {
    LeagueID: '00',
    Season: currentSeason(),
    IsOnlyCurrentSeason: '0',
  });
  const set = data.resultSets.find((r) => r.name === 'CommonAllPlayers');
  if (!set) throw new Error('CommonAllPlayers result set missing');

  const rows = rowsToObjects(set);
  const players: NbaPlayer[] = rows.map((r) => ({
    id: Number(r.PERSON_ID),
    fullName: String(r.DISPLAY_FIRST_LAST ?? ''),
    firstName: String(r.DISPLAY_FIRST_LAST ?? '').split(' ')[0] ?? '',
    lastName: String(r.DISPLAY_FIRST_LAST ?? '').split(' ').slice(1).join(' '),
    teamId: r.TEAM_ID ? Number(r.TEAM_ID) : null,
    teamAbbreviation: (r.TEAM_ABBREVIATION as string) || null,
    isActive: Number(r.ROSTERSTATUS) === 1,
  }));

  cache = { at: Date.now(), players };
  return players;
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export async function searchPlayers(query: string, limit = 20): Promise<NbaPlayer[]> {
  const q = fold(query.trim());
  if (!q) return [];
  const all = await getAllPlayers();
  const matches = all.filter((p) => fold(p.fullName).includes(q));
  matches.sort((a, b) => Number(b.isActive) - Number(a.isActive));
  return matches.slice(0, limit);
}

// Returns season strings like ["2025-26", "2024-25", "2023-24"], newest first.
export function recentSeasons(count: number): string[] {
  const cur = currentSeason();
  const startYear = parseInt(cur.split('-')[0]!, 10);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const sy = startYear - i;
    const next = (sy + 1).toString().slice(-2);
    out.push(`${sy}-${next}`);
  }
  return out;
}

export function currentSeason(): string {
  // NBA season label like "2024-25". Season starts in October.
  const now = new Date();
  const y = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= 9 ? y : y - 1;
  const next = (startYear + 1).toString().slice(-2);
  return `${startYear}-${next}`;
}

export type PlayerGame = {
  gameId: string;
  date: string;            // ISO date
  matchup: string;         // e.g. "LAL vs. DEN" or "LAL @ DEN"
  opponentAbbr: string;
  isHome: boolean;
  result: 'W' | 'L' | null;
  minutes: number;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  fgPct: number;
  fg3Pct: number;
  ftPct: number;
};

const gameLogCache = new Map<string, { at: number; games: PlayerGame[] }>();
const GAMELOG_TTL = 60 * 60 * 1000; // 1 hour

export async function getPlayerGameLog(
  playerId: number,
  season: string = currentSeason(),
): Promise<PlayerGame[]> {
  const key = `${playerId}:${season}`;
  const hit = gameLogCache.get(key);
  if (hit && Date.now() - hit.at < GAMELOG_TTL) return hit.games;

  const data = await fetchStats('playergamelog', {
    PlayerID: String(playerId),
    Season: season,
    SeasonType: 'Regular Season',
  });
  const set = data.resultSets.find((r) => r.name === 'PlayerGameLog');
  if (!set) throw new Error('PlayerGameLog result set missing');

  const rows = rowsToObjects(set);
  const games: PlayerGame[] = rows.map((r) => {
    const matchup = String(r.MATCHUP ?? '');
    const isHome = matchup.includes(' vs. ');
    const opponentAbbr = matchup.split(/ vs\. | @ /)[1] ?? '';
    return {
      gameId: String(r.Game_ID),
      date: parseGameDate(String(r.GAME_DATE)),
      matchup,
      opponentAbbr,
      isHome,
      result: (r.WL as 'W' | 'L') || null,
      minutes: Number(r.MIN ?? 0),
      points: Number(r.PTS ?? 0),
      rebounds: Number(r.REB ?? 0),
      assists: Number(r.AST ?? 0),
      steals: Number(r.STL ?? 0),
      blocks: Number(r.BLK ?? 0),
      turnovers: Number(r.TOV ?? 0),
      fgPct: Number(r.FG_PCT ?? 0),
      fg3Pct: Number(r.FG3_PCT ?? 0),
      ftPct: Number(r.FT_PCT ?? 0),
    };
  });

  gameLogCache.set(key, { at: Date.now(), games });
  return games;
}

function parseGameDate(s: string): string {
  // stats.nba.com returns dates like "MAR 15, 2025"
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toISOString().slice(0, 10);
}

export type TeamGame = {
  gameId: string;
  date: string;
  matchup: string;
  opponentAbbr: string;
  isHome: boolean;
  result: 'W' | 'L' | null;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  fgPct: number;
  fg3Pct: number;
  ftPct: number;
};

const teamLogCache = new Map<string, { at: number; games: TeamGame[] }>();

export async function getTeamGameLog(
  teamId: number,
  season: string = currentSeason(),
): Promise<TeamGame[]> {
  const key = `${teamId}:${season}`;
  const hit = teamLogCache.get(key);
  if (hit && Date.now() - hit.at < GAMELOG_TTL) return hit.games;

  const data = await fetchStats('teamgamelog', {
    TeamID: String(teamId),
    Season: season,
    SeasonType: 'Regular Season',
  });
  const set = data.resultSets.find((r) => r.name === 'TeamGameLog');
  if (!set) throw new Error('TeamGameLog result set missing');

  const rows = rowsToObjects(set);
  const games: TeamGame[] = rows.map((r) => {
    const matchup = String(r.MATCHUP ?? '');
    const isHome = matchup.includes(' vs. ');
    const opponentAbbr = matchup.split(/ vs\. | @ /)[1] ?? '';
    return {
      gameId: String(r.Game_ID),
      date: parseGameDate(String(r.GAME_DATE)),
      matchup,
      opponentAbbr,
      isHome,
      result: (r.WL as 'W' | 'L') || null,
      points: Number(r.PTS ?? 0),
      rebounds: Number(r.REB ?? 0),
      assists: Number(r.AST ?? 0),
      steals: Number(r.STL ?? 0),
      blocks: Number(r.BLK ?? 0),
      turnovers: Number(r.TOV ?? 0),
      fgPct: Number(r.FG_PCT ?? 0),
      fg3Pct: Number(r.FG3_PCT ?? 0),
      ftPct: Number(r.FT_PCT ?? 0),
    };
  });

  teamLogCache.set(key, { at: Date.now(), games });
  return games;
}
