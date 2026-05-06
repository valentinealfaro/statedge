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

export async function fetchScoreboard(date?: string): Promise<{
  date: string | null;
  games: EspnScoreboardGame[];
}> {
  // ESPN's `dates` param is YYYYMMDD with no separators. Omit to get today.
  const url = date ? `${ESPN}/scoreboard?dates=${date.replace(/-/g, '')}` : `${ESPN}/scoreboard`;
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

  return {
    eventId: String(j.header?.id ?? eventId),
    date: String(competition?.date ?? ''),
    state: (j.header?.competitions?.[0]?.status?.type?.state ?? 'pre') as 'pre' | 'in' | 'post',
    statusDetail: String(j.header?.competitions?.[0]?.status?.type?.detail ?? ''),
    venue: j.gameInfo?.venue?.fullName ? String(j.gameInfo.venue.fullName) : undefined,
    attendance: j.gameInfo?.attendance ? Number(j.gameInfo.attendance) : undefined,
    away: buildSide(away ?? {}),
    home: buildSide(home ?? {}),
  };
}
