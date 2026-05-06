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
  oreb?: number;
  dreb?: number;
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

export type ComboKey = 'PRA' | 'PR' | 'PA' | 'RA' | 'STOCKS';

export type SelectedStat =
  | 'points' | 'rebounds' | 'assists'
  | 'PRA' | 'PR' | 'PA' | 'RA' | 'STOCKS';

export type HitProbability = {
  hitOver: number;
  hitUnder: number;
  pOver: number;
  pUnder: number;
  mightHitPct: number;
  lean: 'OVER' | 'UNDER';
};

export type DataFreshness = {
  lastGameDate: string | null;
  daysStale: number | null;
  source?: string;
};

export type AdvancedStats = {
  selectedStat: SelectedStat;
  gamesAnalyzed: number;
  doubleDouble: { count: number; rate: number };
  tripleDouble: { count: number; rate: number };
  consistency: { score: number; label: 'Volatile' | 'Moderate' | 'Consistent' | 'Very Consistent' };
  trend: {
    last5Avg: number;
    last10Avg: number;
    percentChange: number;
    label: 'Trending Up' | 'Trending Down' | 'Stable' | 'Not Enough Data';
  };
  performanceVsTeam: {
    vsTeamAvg: number;
    seasonAvg: number;
    difference: number;
    percentChange: number;
    label: 'Better vs Team' | 'About Average' | 'Worse vs Team' | 'Not Enough Data';
  };
  homeAway: {
    homeAvg: number;
    awayAvg: number;
    difference: number;
    betterLocation: 'Home' | 'Away' | 'Even';
    homeGames: number;
    awayGames: number;
  };
};

export type CompareResponse = {
  team: Team;
  seasons: string[];          // e.g. ["2025-26","2024-25"]
  seasonRange: SeasonRange;
  gamesAnalyzed: number;
  combos: Record<ComboKey, number>;
  advanced: AdvancedStats;
  hitProbability?: HitProbability;
  line?: number;
  statKey?: SelectedStat;
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

export async function getPlayerById(playerId: number): Promise<Player> {
  const res = await fetch(`${API_BASE}/api/player/${playerId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { player: Player };
  return data.player;
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
  selectedStat: SelectedStat = 'PRA',
  hitLine?: { line: number; statKey: SelectedStat },
): Promise<CompareResponse> {
  const params = new URLSearchParams({
    playerId: String(playerId),
    teamId: String(teamId),
    range,
    seasons,
    selectedStat,
  });
  if (hitLine) {
    params.set('line', String(hitLine.line));
    params.set('statKey', hitLine.statKey);
  }
  const res = await fetch(`${API_BASE}/api/compare/player-vs-team?${params.toString()}`);
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

// --- Last 10 Games ---

export type Last10StatId =
  | 'points' | 'rebounds' | 'assists'
  | 'three_pt_made' | 'fg_made' | 'fg_attempted'
  | 'ft_made' | 'ft_attempted' | 'personal_fouls'
  | 'steals' | 'blocks' | 'turnovers'
  | 'offensive_rebounds' | 'defensive_rebounds'
  | 'pra' | 'pr' | 'pa' | 'ra' | 'stocks'
  | 'double_double';

export type Last10NumericReport = {
  selectedStat: Exclude<Last10StatId, 'double_double'>;
  label: string;
  gamesAnalyzed: number;
  average: number;
  high: number;
  low: number;
  values: number[];
  hitCountAboveAverage: number;
  gameLog: PlayerGame[];
};

export type Last10DoubleDoubleReport = {
  selectedStat: 'double_double';
  label: string;
  gamesAnalyzed: number;
  doubleDouble: { count: number; rate: number; values: boolean[] };
  gameLog: PlayerGame[];
};

export type Last10Response = (Last10NumericReport | Last10DoubleDoubleReport) & {
  playerId: number;
  availableStats: Last10StatId[];
  labels: Record<Last10StatId, string>;
};

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
  fgm: number;
  fga: number;
  fg3m: number;
  fg3a: number;
  ftm: number;
  fta: number;
  fgPct: number;
  fg3Pct: number;
  ftPct: number;
  pf: number;
};

export type TeamLast10Response = {
  team: Team;
  gamesAnalyzed: number;
  gameLog: TeamGame[];
};

export async function getPlayerLast10(
  playerId: number,
  selectedStat: Last10StatId,
): Promise<Last10Response> {
  const res = await fetch(
    `${API_BASE}/api/player/${playerId}/last-10?selectedStat=${selectedStat}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as Last10Response;
}

export type TrendingPlayer = Player & {
  ppg: number;
  rpg: number;
  apg: number;
  gamesPlayed: number;
};

export async function getTrendingPlayers(limit = 8): Promise<TrendingPlayer[]> {
  const res = await fetch(`${API_BASE}/api/trending/players?limit=${limit}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { players: TrendingPlayer[] };
  return data.players;
}

export async function getTeamLast10(teamId: number): Promise<TeamLast10Response> {
  const res = await fetch(`${API_BASE}/api/teams/${teamId}/last-10`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as TeamLast10Response;
}

export async function getDataFreshness(): Promise<DataFreshness> {
  const res = await fetch(`${API_BASE}/api/data-freshness`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as DataFreshness;
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
