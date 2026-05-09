// balldontlie.io client. Unlike stats.nba.com, it works from datacenter IPs
// so it's a good live-data source for the deployed backend.
//
// Auth: Authorization: <api_key> header. Free tier is rate-limited
// (~5 req/min), so we cache server-side aggressively.

const BASE = 'https://api.balldontlie.io/v1';

function authHeader(): Record<string, string> | null {
  const key = process.env.BALLDONTLIE_API_KEY;
  if (!key) return null;
  return { Authorization: key };
}

export function isConfigured(): boolean {
  return !!process.env.BALLDONTLIE_API_KEY;
}

async function fetchBdl<T>(path: string, params: Record<string, string | string[]>): Promise<T> {
  const headers = authHeader();
  if (!headers) throw new Error('BALLDONTLIE_API_KEY is not set');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else qs.append(k, v);
  }
  const url = `${BASE}${path}?${qs.toString()}`;
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`balldontlie ${path} ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

export type BdlGame = {
  id: number;
  date: string;
  status: string;        // 'Final' | 'In Progress' | scheduled time string
  period: number;
  time: string | null;
  home_team_score: number;
  visitor_team_score: number;
  home_team: { id: number; abbreviation: string; full_name: string };
  visitor_team: { id: number; abbreviation: string; full_name: string };
};

let scoreboardCache: { at: number; date: string; games: BdlGame[] } | null = null;
const SCOREBOARD_TTL = 60 * 1000; // 60s — live scores want freshness

export async function getScoreboardForDate(date: string): Promise<BdlGame[]> {
  if (
    scoreboardCache &&
    scoreboardCache.date === date &&
    Date.now() - scoreboardCache.at < SCOREBOARD_TTL
  ) {
    return scoreboardCache.games;
  }

  const data = await fetchBdl<{ data: BdlGame[] }>('/games', {
    'dates[]': [date],
    per_page: '100',
  });

  scoreboardCache = { at: Date.now(), date, games: data.data };
  return data.data;
}

export function todayDateUtc(): string {
  // Eastern Time — same canonical sports timezone every league uses.
  // Raw UTC rolls dates over at 7 PM CT during DST, surfacing
  // tomorrow's slate while users still have games tonight.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
