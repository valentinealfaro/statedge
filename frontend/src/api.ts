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
  fgPct: number;
  fg3Pct: number;
  ftPct: number;
};

export type CompareResponse = {
  team: Team;
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
  const res = await fetch(`/api/search/players?query=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { results: Player[] };
  return data.results;
}

export async function getTeams(): Promise<Team[]> {
  const res = await fetch('/api/teams');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { teams: Team[] };
  return data.teams;
}

export async function comparePlayerVsTeam(
  playerId: number,
  teamId: number,
  range: 'last5' | 'last10' | 'last20' | 'season',
): Promise<CompareResponse> {
  const res = await fetch(
    `/api/compare/player-vs-team?playerId=${playerId}&teamId=${teamId}&range=${range}`,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body}`);
  }
  return (await res.json()) as CompareResponse;
}
