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

export type RosterPlayer = Player & {
  ppg: number;
  rpg: number;
  apg: number;
  minutes: number;
  gamesPlayed: number;
};

export async function getTeamRoster(teamId: number): Promise<{
  team: Team;
  players: RosterPlayer[];
}> {
  const res = await fetch(`${API_BASE}/api/teams/${teamId}/roster`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { team: Team; players: RosterPlayer[] };
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

export type ByOpponentRow = {
  opponentAbbr: string;
  gamesPlayed: number;
  avg: number;
  high: number;
  low: number;
};

export type SeasonVsL10Row = {
  stat: 'pts' | 'reb' | 'ast' | 'stl' | 'blk' | 'min' | 'fgPct' | 'fg3Pct' | 'ftPct';
  label: string;
  seasonAvg: number;
  l10Avg: number;
  delta: number;
};

export type Last10Response = (Last10NumericReport | Last10DoubleDoubleReport) & {
  playerId: number;
  availableStats: Last10StatId[];
  labels: Record<Last10StatId, string>;
  byOpponent?: ByOpponentRow[];
  seasonVsL10?: SeasonVsL10Row[];
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

export type TrendingTeam = {
  id: number;
  abbreviation: string;
  city: string;
  name: string;
  fullName: string;
  ppg: number;
  wins: number;
  losses: number;
  gamesPlayed: number;
};

export type RecentGameSide = {
  teamId: number;
  abbreviation: string;
  fullName: string;
  points: number;
  isHome: boolean;
  result: 'W' | 'L' | null;
};

export type RecentGame = {
  gameId: string;
  date: string;
  away: RecentGameSide;
  home: RecentGameSide;
};

export async function getRecentGames(limit = 6): Promise<RecentGame[]> {
  const res = await fetch(`${API_BASE}/api/games/recent?limit=${limit}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { games: RecentGame[] };
  return data.games;
}

export type BoxscorePlayer = {
  playerId: number;
  fullName: string;
  minutes: number;
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
  pf: number;
};

export type BoxscoreSide = {
  teamId: number;
  abbreviation: string;
  fullName: string;
  isHome: boolean;
  result: 'W' | 'L' | null;
  points: number;
  players: BoxscorePlayer[];
};

export type Boxscore = {
  gameId: string;
  date: string;
  away: BoxscoreSide;
  home: BoxscoreSide;
};

export async function getBoxscore(gameId: string): Promise<Boxscore> {
  const res = await fetch(`${API_BASE}/api/games/${gameId}/boxscore`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { boxscore: Boxscore };
  return data.boxscore;
}

export type StandingRow = {
  teamId: number;
  abbreviation: string;
  fullName: string;
  conference: 'East' | 'West';
  wins: number;
  losses: number;
  winPct: number;
  ppg: number;
  l10Wins: number;
  l10Losses: number;
};

export type TopPerformer = {
  playerId: number;
  fullName: string;
  teamAbbreviation: string | null;
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
};

export async function getTopPerformers(limit = 6): Promise<TopPerformer[]> {
  const res = await fetch(`${API_BASE}/api/performers/top?limit=${limit}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { performers: TopPerformer[] };
  return data.performers;
}

// --- Slate (PrizePicks-style prop board with hit probabilities) ---

export type SlateHitProbability = HitProbability;

export type SlateInjury = {
  status: string;        // "Out", "Day-To-Day", "Questionable", etc.
  type?: string;
  date?: string;
};

export type SlateResolvedLine = {
  ppId?: string;
  playerId: number;
  playerName: string;
  ppPlayerName: string;
  team: string | null;
  position: string | null;
  imageUrl: string | null;
  statKey: Last10StatId;
  statLabel: string;
  line: number;
  startTime?: string | null;
  description?: string | null;

  gamesAnalyzed: number;
  last10Avg: number;
  last10Values: number[];

  hitProbability?: SlateHitProbability;
  ddRate?: number;
  injury?: SlateInjury;
  vsOpponent?: {
    opponentAbbr: string;
    gamesPlayed: number;
    avg: number;
  };
  trend?: {
    last5Avg: number;
    deltaVsL10: number;
  };

  // Layered projection-engine output (numeric stats only; double_double
  // stays on hitProbability/ddRate). Mirrors backend ProjectionResult.
  projection?: SlateProjection;
};

export type SlateProjection = {
  selectedStat: Last10StatId;
  lineValue: number;
  projection: {
    baseline: number;
    contextAdjusted: number;
    final: number;
    rangeLow: number;
    rangeHigh: number;
  };
  probability: { over: number; under: number };
  confidence: { score: number; label: string };
  risk: { score: number; label: string };
  edge: { score: number; label: string; lean: string };
  historicalHitRates: {
    season: number | null;
    last10: number | null;
    last5: number | null;
    vsOpponent: number | null;
    homeAway: number | null;
  };
  factorBreakdown: {
    seasonAvg: number | null;
    last10Avg: number | null;
    last5Avg: number | null;
    vsOpponentAvg: number | null;
    homeAwayAvg: number | null;
    seasonMedian: number | null;
    last10Median: number | null;
    blendedStdDev: number;
    projectedMinutes: number | null;
    minutesMultiplier: number;
    usageMultiplier: number;
    injuryMultiplier: number;
    opponentDefenseMultiplier: number;
    paceMultiplier: number;
    restMultiplier: number;
    gameImportanceMultiplier: number;
    blowoutMultiplier: number;
    modelAgreementScore: number;
  };
  modelNotes: string[];
  disclaimer: string;
  noProjection?: boolean;
};

export type SlateUnresolvedLine = {
  rawText: string;
  rawStatLabel: string;
  line: number;
  reason: 'no_player_match' | 'unknown_stat' | 'no_recent_games';
};

export type SlateResponse = {
  lines: SlateResolvedLine[];
  unresolved: SlateUnresolvedLine[];
  source: 'prizepicks_auto' | 'image_upload' | 'manual';
  fetchedAt: string;
};

export type ManualSlateLine = {
  playerName: string;
  statLabel: string;            // canonical or any normalized form
  line: number;
  team?: string;                // optional, just for display
  opponentAbbr?: string | null; // tonight's opponent (drives vs-opp computation)
};

export async function postManualSlate(raw: ManualSlateLine[]): Promise<SlateResponse> {
  const res = await fetch(`${API_BASE}/api/slate/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, source: 'manual' }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? '';
    } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return (await res.json()) as SlateResponse;
}

export async function getSlateAuto(): Promise<SlateResponse> {
  const res = await fetch(`${API_BASE}/api/slate/auto`);
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? '';
    } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return (await res.json()) as SlateResponse;
}

export async function getSlateInsight(line: SlateResolvedLine): Promise<{ insight: string }> {
  const res = await fetch(`${API_BASE}/api/slate/insight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? '';
    } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return (await res.json()) as { insight: string };
}

export async function analyzeSlateLegs(legs: SlateResolvedLine[]): Promise<{ summary: string }> {
  const res = await fetch(`${API_BASE}/api/slate/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ legs }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? '';
    } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return (await res.json()) as { summary: string };
}

export async function postSlateImage(file: File): Promise<SlateResponse> {
  const fd = new FormData();
  fd.append('image', file);
  const res = await fetch(`${API_BASE}/api/slate/parse-image`, {
    method: 'POST',
    body: fd,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? '';
    } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return (await res.json()) as SlateResponse;
}

// --- ESPN today's games + game summary ---

export type EspnGameTeam = {
  id: string;
  abbreviation: string;
  displayName: string;
  logo: string;
  score: string;
  homeAway: 'home' | 'away';
  record?: string;
};

export type EspnScoreboardGame = {
  id: string;
  date: string;
  status: {
    state: 'pre' | 'in' | 'post';
    name: string;
    detail: string;
    completed: boolean;
  };
  away: EspnGameTeam;
  home: EspnGameTeam;
};

export async function getTodayGames(date?: string): Promise<{
  date: string | null;
  games: EspnScoreboardGame[];
}> {
  const url = date
    ? `${API_BASE}/api/games/today?date=${encodeURIComponent(date)}`
    : `${API_BASE}/api/games/today`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { date: string | null; games: EspnScoreboardGame[] };
}

export type EspnPlayerLine = {
  athleteId: string;
  displayName: string;
  shortName: string;
  jersey: string;
  position: string;
  headshot: string;
  starter: boolean;
  didNotPlay: boolean;
  reason?: string;
  minutes: number;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  fouls: number;
  fg: string;
  threePt: string;
  ft: string;
  plusMinus: string;
};

export type EspnInjury = {
  status: string;
  athleteId: string;
  displayName: string;
  headshot: string;
  position: string;
  type?: string;
};

export type EspnLeader = {
  category: string;
  displayName: string;
  athleteId: string;
  athleteName: string;
  athleteHeadshot: string;
  value: string;
};

export type EspnTeamSummary = {
  id: string;
  abbreviation: string;
  displayName: string;
  logo: string;
  score: string;
  homeAway: 'home' | 'away';
  record?: string;
  isWinner?: boolean;
  starters: EspnPlayerLine[];
  bench: EspnPlayerLine[];
  injuries: EspnInjury[];
  leaders: EspnLeader[];
};

export type EspnGameSummary = {
  eventId: string;
  date: string;
  state: 'pre' | 'in' | 'post';
  statusDetail: string;
  venue?: string;
  attendance?: number;
  away: EspnTeamSummary;
  home: EspnTeamSummary;
};

export async function getEspnGameSummary(eventId: string): Promise<EspnGameSummary> {
  const res = await fetch(`${API_BASE}/api/games/espn/${encodeURIComponent(eventId)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { summary: EspnGameSummary };
  return data.summary;
}

export async function getStandings(): Promise<{ east: StandingRow[]; west: StandingRow[] }> {
  const res = await fetch(`${API_BASE}/api/standings`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { east: StandingRow[]; west: StandingRow[] };
}

export async function getTrendingTeams(limit = 8): Promise<TrendingTeam[]> {
  const res = await fetch(`${API_BASE}/api/trending/teams?limit=${limit}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { teams: TrendingTeam[] };
  return data.teams;
}

export async function getTeamLast10(teamId: number): Promise<TeamLast10Response> {
  const res = await fetch(`${API_BASE}/api/teams/${teamId}/last-10`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as TeamLast10Response;
}

export type BackendVersion = {
  commit: string;
  branch: string | null;
  deployedAt: string | null;
  hasGeminiKey: boolean;
  hasDb: boolean;
};

export async function getBackendVersion(): Promise<BackendVersion | null> {
  try {
    const res = await fetch(`${API_BASE}/api/version`);
    if (!res.ok) return null;
    return (await res.json()) as BackendVersion;
  } catch {
    return null;
  }
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
