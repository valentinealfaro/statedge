// ESPN's public site API. No auth required, CORS enabled, but the schema
// is unofficial — we only project the fields we use and tolerate misses
// gracefully.
//
// Endpoints used:
//   /scoreboard?dates=YYYYMMDD          → today's slate
//   /summary?event=:eventId             → boxscore + injuries + leaders + starters

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';

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
    name: string;       // e.g. STATUS_FINAL, STATUS_SCHEDULED
    detail: string;     // e.g. "5/6 - 7:00 PM EDT"
    completed: boolean;
  };
  away: EspnGameTeam;
  home: EspnGameTeam;
};

// US Eastern calendar date, YYYY-MM-DD. ESPN's "no-date" scoreboard
// lags behind by a day at certain hours (returns yesterday's slate
// even after midnight ET), so we always pass today's ET date
// explicitly when the caller didn't specify one.
function todayEt(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

export async function fetchScoreboard(date?: string): Promise<{
  date: string | null;
  games: EspnScoreboardGame[];
}> {
  // ESPN's `dates` param is YYYYMMDD with no separators. Always pass
  // a date — the no-arg form returns yesterday's slate at certain
  // hours, which is exactly the bug we hit.
  const effectiveDate = date ?? todayEt();
  const url = `${ESPN}/scoreboard?dates=${effectiveDate.replace(/-/g, '')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = await res.json() as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const games: EspnScoreboardGame[] = (j.events ?? []).map((e: any) => {
    const comp = e.competitions?.[0];
    const teams = comp?.competitors ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (c: any): EspnGameTeam => ({
      id: String(c.team?.id ?? ''),
      abbreviation: String(c.team?.abbreviation ?? ''),
      displayName: String(c.team?.displayName ?? ''),
      logo: String(c.team?.logo ?? ''),
      score: String(c.score ?? ''),
      homeAway: c.homeAway === 'home' ? 'home' : 'away',
      record: c.record?.[0]?.summary,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const home = teams.find((t: any) => t.homeAway === 'home');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const away = teams.find((t: any) => t.homeAway === 'away');
    return {
      id: String(e.id),
      date: String(e.date ?? ''),
      status: {
        state: (e.status?.type?.state ?? 'pre') as 'pre' | 'in' | 'post',
        name: String(e.status?.type?.name ?? ''),
        detail: String(e.status?.type?.shortDetail ?? ''),
        completed: !!e.status?.type?.completed,
      },
      away: map(away ?? {}),
      home: map(home ?? {}),
    };
  });

  return { date: j.day?.date ?? null, games };
}

// --- Summary ---

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
  // Stats appear keyed by the team's `keys` array; we project the standard
  // box columns into named fields for the UI.
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
  status: string;       // "Out", "Day-To-Day", "Questionable", "Doubtful"
  athleteId: string;
  displayName: string;
  headshot: string;
  position: string;
  type?: string;        // injury description
};

export type EspnLeader = {
  category: string;     // "points", "rebounds", "assists", "rating"
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

export type EspnQuarterScore = {
  period: number;
  awayPoints: number | null;
  homePoints: number | null;
};

export type EspnWinProbabilityEntry = {
  homeWinPercentage: number;        // 0-100
  awayWinPercentage: number;        // 0-100
  playId?: string;
};

export type EspnLastFiveGame = {
  date: string;
  atVs: 'vs' | '@' | null;
  opponentAbbr: string;
  result: 'W' | 'L' | null;
  score: string;
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
  // Per-quarter scoring (NBA equivalent of MLB linescore). Padded
  // with nulls if a quarter hasn't been played yet.
  quarters: EspnQuarterScore[];
  // Cumulative R/H/E equivalent — just final scores per side.
  totals: { away: number | null; home: number | null };
  // Matchup predictor (current win-prob snapshot pre-game; rolling
  // probability throughout the game once it starts). ESPN ships
  // pre-game projection in `predictor` and per-play history in
  // `winProbability[]` — we surface both.
  predictor: { homeWinPct: number | null; awayWinPct: number | null };
  winProbability: EspnWinProbabilityEntry[];
  // Last 5 games per team (what ESPN shows below the boxscore).
  lastFive: { away: EspnLastFiveGame[]; home: EspnLastFiveGame[] };
};

export async function fetchGameSummary(eventId: string): Promise<EspnGameSummary> {
  const res = await fetch(`${ESPN}/summary?event=${encodeURIComponent(eventId)}`);
  if (!res.ok) throw new Error(`ESPN summary ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = await res.json() as any;

  const competition = j.header?.competitions?.[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const competitors: any[] = competition?.competitors ?? [];

  // Map a stats array (positional, matching the team's `keys` array) into
  // the named fields we render. ESPN keys are stable; if a column moves
  // we'd notice in dev/test.
  const KEY_INDEX = {
    minutes: 0,
    points: 1,
    fg: 2,
    threePt: 3,
    ft: 4,
    rebounds: 5,
    assists: 6,
    turnovers: 7,
    steals: 8,
    blocks: 9,
    // oreb 10, dreb 11
    fouls: 12,
    plusMinus: 13,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projectAthlete = (a: any): EspnPlayerLine => {
    const stats: string[] = a.stats ?? [];
    const num = (i: number) => Number(stats[i] ?? 0) || 0;
    return {
      athleteId: String(a.athlete?.id ?? ''),
      displayName: String(a.athlete?.displayName ?? ''),
      shortName: String(a.athlete?.shortName ?? ''),
      jersey: String(a.athlete?.jersey ?? ''),
      position: String(a.athlete?.position?.abbreviation ?? ''),
      headshot: String(a.athlete?.headshot?.href ?? ''),
      starter: !!a.starter,
      didNotPlay: !!a.didNotPlay,
      reason: a.reason ? String(a.reason) : undefined,
      minutes:   num(KEY_INDEX.minutes),
      points:    num(KEY_INDEX.points),
      rebounds:  num(KEY_INDEX.rebounds),
      assists:   num(KEY_INDEX.assists),
      steals:    num(KEY_INDEX.steals),
      blocks:    num(KEY_INDEX.blocks),
      turnovers: num(KEY_INDEX.turnovers),
      fouls:     num(KEY_INDEX.fouls),
      fg:        String(stats[KEY_INDEX.fg] ?? ''),
      threePt:   String(stats[KEY_INDEX.threePt] ?? ''),
      ft:        String(stats[KEY_INDEX.ft] ?? ''),
      plusMinus: String(stats[KEY_INDEX.plusMinus] ?? ''),
    };
  };

  // ESPN's `boxscore.players` has one entry per team. Each entry has a
  // statistics group with all athletes; starter flag separates them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playerGroups: any[] = j.boxscore?.players ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildPlayers = (teamGroup: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const athletes = (teamGroup?.statistics?.[0]?.athletes ?? []) as any[];
    const projected = athletes.map(projectAthlete);
    return {
      starters: projected.filter((p) => p.starter),
      bench: projected.filter((p) => !p.starter),
    };
  };

  // Injuries are keyed by team in `injuries[]`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const injuriesByTeamId: Record<string, EspnInjury[]> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const block of (j.injuries ?? [])) {
    const teamId = String(block.team?.id ?? '');
    if (!teamId) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    injuriesByTeamId[teamId] = (block.injuries ?? []).map((i: any) => ({
      status: String(i.status ?? ''),
      athleteId: String(i.athlete?.id ?? ''),
      displayName: String(i.athlete?.displayName ?? ''),
      headshot: String(i.athlete?.headshot?.href ?? ''),
      position: String(i.athlete?.position?.abbreviation ?? ''),
      type: i.type?.description ? String(i.type.description) : undefined,
    }));
  }

  // Leaders block (one per team)
  const leadersByTeamId: Record<string, EspnLeader[]> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const block of (j.leaders ?? [])) {
    const teamId = String(block.team?.id ?? '');
    if (!teamId) continue;
    const out: EspnLeader[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const cat of (block.leaders ?? [])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const top = cat.leaders?.[0];
      if (!top) continue;
      out.push({
        category: String(cat.name ?? ''),
        displayName: String(cat.displayName ?? ''),
        athleteId: String(top.athlete?.id ?? ''),
        athleteName: String(top.athlete?.displayName ?? ''),
        athleteHeadshot: String(top.athlete?.headshot?.href ?? ''),
        value: String(top.displayValue ?? ''),
      });
    }
    leadersByTeamId[teamId] = out;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildSide = (c: any): EspnTeamSummary => {
    const teamId = String(c.team?.id ?? '');
    // Match the boxscore players group to this team.
    const group = playerGroups.find((g) => String(g.team?.id ?? '') === teamId);
    const { starters, bench } = buildPlayers(group);
    return {
      id: teamId,
      abbreviation: String(c.team?.abbreviation ?? ''),
      displayName: String(c.team?.displayName ?? ''),
      logo: String(c.team?.logo ?? group?.team?.logo ?? ''),
      score: String(c.score ?? ''),
      homeAway: c.homeAway === 'home' ? 'home' : 'away',
      record: c.record?.[0]?.summary,
      isWinner: !!c.winner,
      starters,
      bench,
      injuries: injuriesByTeamId[teamId] ?? [],
      leaders: leadersByTeamId[teamId] ?? [],
    };
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const home = competitors.find((c: any) => c.homeAway === 'home');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const away = competitors.find((c: any) => c.homeAway === 'away');

  // Per-quarter linescore. ESPN ships `linescores: [{value: 28}, ...]`
  // on each competitor — one entry per period played. Pad to 4 so the
  // table reads like a real NBA boxscore even mid-game.
  const homeLines = (home?.linescores ?? []) as Array<{ value?: number }>;
  const awayLines = (away?.linescores ?? []) as Array<{ value?: number }>;
  const periods = Math.max(4, homeLines.length, awayLines.length);
  const quarters: EspnQuarterScore[] = [];
  for (let i = 0; i < periods; i++) {
    const h = homeLines[i]?.value;
    const a = awayLines[i]?.value;
    quarters.push({
      period: i + 1,
      awayPoints: typeof a === 'number' ? a : null,
      homePoints: typeof h === 'number' ? h : null,
    });
  }

  // Predictor (pre-game / live snapshot of win prob).
  const predictor = (j.predictor ?? {}) as {
    homeTeam?: { gameProjection?: string };
    awayTeam?: { gameProjection?: string };
  };
  const homeProj = Number(predictor.homeTeam?.gameProjection ?? NaN);
  const awayProj = Number(predictor.awayTeam?.gameProjection ?? NaN);

  // Win-probability rolling history (per-play). ESPN ships an array
  // of `{playId, homeWinPercentage, awayWinPercentage}` once the
  // game starts. Empty array pre-game (predictor still has the
  // pre-game snapshot).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wpRaw = (j.winProbability ?? []) as any[];
  const winProbability: EspnWinProbabilityEntry[] = wpRaw.map((w) => ({
    homeWinPercentage: Number(w?.homeWinPercentage ?? 0) * 100,    // ESPN sends 0-1
    awayWinPercentage: 100 - Number(w?.homeWinPercentage ?? 0) * 100,
    playId: w?.playId ? String(w.playId) : undefined,
  }));

  // Last-five games per team (ESPN's recent-form box).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastFiveRaw = (j.lastFiveGames ?? []) as any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildLastFive = (block: any): EspnLastFiveGame[] => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = block?.events ?? [];
    return events.map((e) => {
      // ESPN sometimes ships gameDate or date
      const dateStr = String(e.gameDate ?? e.date ?? '');
      const date = dateStr ? dateStr.slice(0, 10) : '';
      const atVsRaw = String(e.atVs ?? '').toLowerCase();
      const atVs = atVsRaw === 'vs' ? 'vs' : atVsRaw === '@' || atVsRaw === 'at' ? '@' : null;
      return {
        date,
        atVs,
        opponentAbbr: String(e.opponent?.abbreviation ?? e.team?.abbreviation ?? ''),
        result: e.gameResult === 'W' ? 'W' : e.gameResult === 'L' ? 'L' : null,
        score: String(e.score ?? ''),
      };
    });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const homeLastFive = lastFiveRaw.find((b: any) => String(b.team?.id ?? '') === String(home?.team?.id ?? ''));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const awayLastFive = lastFiveRaw.find((b: any) => String(b.team?.id ?? '') === String(away?.team?.id ?? ''));

  return {
    eventId: String(j.header?.id ?? eventId),
    date: String(competition?.date ?? ''),
    state: (j.header?.competitions?.[0]?.status?.type?.state ?? 'pre') as 'pre' | 'in' | 'post',
    statusDetail: String(j.header?.competitions?.[0]?.status?.type?.detail ?? ''),
    venue: j.gameInfo?.venue?.fullName ? String(j.gameInfo.venue.fullName) : undefined,
    attendance: j.gameInfo?.attendance ? Number(j.gameInfo.attendance) : undefined,
    away: buildSide(away ?? {}),
    home: buildSide(home ?? {}),
    quarters,
    totals: {
      away: away?.score !== undefined ? Number(away.score) : null,
      home: home?.score !== undefined ? Number(home.score) : null,
    },
    predictor: {
      homeWinPct: Number.isFinite(homeProj) ? homeProj : null,
      awayWinPct: Number.isFinite(awayProj) ? awayProj : null,
    },
    winProbability,
    lastFive: {
      away: buildLastFive(awayLastFive),
      home: buildLastFive(homeLastFive),
    },
  };
}
