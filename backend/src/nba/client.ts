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

async function fetchStats(endpoint: string, params: Record<string, string>): Promise<StatsResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}/${endpoint}?${qs}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`NBA stats ${endpoint} ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as StatsResponse;
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

function currentSeason(): string {
  // NBA season label like "2024-25". Season starts in October.
  const now = new Date();
  const y = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= 9 ? y : y - 1;
  const next = (startYear + 1).toString().slice(-2);
  return `${startYear}-${next}`;
}
