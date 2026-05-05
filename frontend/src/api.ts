// In dev, we proxy via Vite (API_BASE = ''). In prod, set VITE_API_BASE_URL
// to the backend's URL (e.g. https://statedge-backend.vercel.app).
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export type Player = {
  id: number;
  fullName: string;
  teamAbbreviation: string | null;
  isActive: boolean;
};

export type Team = {
  id: number;
  abbreviation: string;
  city: string;
  name: string;
  fullName: string;
  conference: 'East' | 'West';
};

export type StatSummary = {
  avg: number;
  min: number;
  max: number;
  stdDev: number;
  consistency: number;
  trend: 'Trending Up' | 'Trending Down' | 'Stable';
};

export type StatKey = 'points' | 'rebounds' | 'assists' | 'minutes' | 'fgPct' | 'fg3Pct';

export type PlayerGame = {
  gameId: string;
  date: string;
  matchup: string;
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
  fgm?: number;
  fga?: number;
  fg3m?: number;
  fg3a?: number;
  ftm?: number;
  fta?: number;
  fgPct: number;
  fg3Pct: number;
  ftPct: number;
  pf?: number;
};

export type SeasonRange = 'current' | 'last2' | 'last3' | 'last5';

export type CompareResponse = {
  team: Team;
  seasons: string[];          // e.g. ["2025-26","2024-25"]
  seasonRange: SeasonRange;
  report: {
    playerId: number;
    teamId: number;
    range: 'last5' | 'last10' | 'last20' | 'season';
    gamesAgainstTeam: PlayerGame[];
    seasonSampleSize: number;
    vsTeam: Record<StatKey, StatSummary>;
    seasonAverage: Record<StatKey, number>;
    delta: Record<StatKey, number>;
  };
};

export async function searchPlayers(query: string, signal?: AbortSignal): Promise<Player[]> {
  const res = await fetch(`${API_BASE}/api/search/players?query=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { results: Player[] };
  return data.results;
}

export async function getTeams(): Promise<Team[]> {
  const res = await fetch(`${API_BASE}/api/teams`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { teams: Team[] };
  return data.teams;
}

export async function comparePlayerVsTeam(
  playerId: number,
  teamId: number,
  range: 'last5' | 'last10' | 'last20' | 'season',
  seasons: SeasonRange = 'current',
): Promise<CompareResponse> {
  const res = await fetch(
    `${API_BASE}/api/compare/player-vs-team?playerId=${playerId}&teamId=${teamId}&range=${range}&seasons=${seasons}`,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body}`);
  }
  return (await res.json()) as CompareResponse;
}

export type Side<TKey extends string> = {
  summaries: Record<TKey, StatSummary>;
  sampleSize: number;
};

export type PvpResponse = {
  aId: number;
  bId: number;
  seasons: string[];
  seasonRange: SeasonRange;
  report: {
    range: 'last5' | 'last10' | 'last20' | 'season';
    a: Side<StatKey>;
    b: Side<StatKey>;
    delta: Record<StatKey, number>;
  };
};

export type TeamStatKey = 'points' | 'rebounds' | 'assists' | 'fgPct' | 'fg3Pct' | 'turnovers';

export type TvtResponse = {
  a: Team;
  b: Team;
  seasons: string[];
  seasonRange: SeasonRange;
  report: {
    range: 'last5' | 'last10' | 'last20' | 'season';
    a: Side<TeamStatKey>;
    b: Side<TeamStatKey>;
    delta: Record<TeamStatKey, number>;
  };
};

export async function comparePlayerVsPlayer(
  aId: number,
  bId: number,
  range: 'last5' | 'last10' | 'last20' | 'season',
  seasons: SeasonRange = 'current',
): Promise<PvpResponse> {
  const res = await fetch(
    `${API_BASE}/api/compare/player-vs-player?aId=${aId}&bId=${bId}&range=${range}&seasons=${seasons}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as PvpResponse;
}

export async function compareTeamVsTeam(
  aId: number,
  bId: number,
  range: 'last5' | 'last10' | 'last20' | 'season',
  seasons: SeasonRange = 'current',
): Promise<TvtResponse> {
  const res = await fetch(
    `${API_BASE}/api/compare/team-vs-team?aId=${aId}&bId=${bId}&range=${range}&seasons=${seasons}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as TvtResponse;
}

export async function getAiSummary(payload: unknown): Promise<{ summary: string }> {
  const res = await fetch(`${API_BASE}/api/ai/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'AI unavailable');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { summary: string };
}
