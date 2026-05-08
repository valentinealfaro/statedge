// ESPN WNBA fetchers. Same pattern as nba/espn.ts — public site API,
// no auth, free. Endpoints used:
//   /scoreboard?dates=YYYYMMDD          → today's games
//   /teams                              → team directory
//   /standings                          → conference standings
//   /summary?event={eventId}            → game detail (boxscore + leaders + injuries + lastFive)
//
// We deliberately project a smaller surface than the raw ESPN response
// so the route layer doesn't have to know ESPN's schema quirks.

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba';
const ESPN_CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/wnba';

export type WnbaTeam = {
  id: string;
  abbreviation: string;
  displayName: string;
  shortDisplayName: string;
  color: string;
  alternateColor: string;
  logo: string;
};

export async function fetchWnbaTeams(): Promise<WnbaTeam[]> {
  const res = await fetch(`${ESPN}/teams`);
  if (!res.ok) throw new Error(`ESPN WNBA teams ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = await res.json() as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const teamWrappers: any[] = j.sports?.[0]?.leagues?.[0]?.teams ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return teamWrappers.map((tw: any): WnbaTeam => {
    const t = tw.team ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logo: string = (t.logos ?? []).find((l: any) => (l.rel ?? []).includes('default'))?.href
      ?? `https://a.espncdn.com/i/teamlogos/wnba/500/${String(t.abbreviation ?? '').toLowerCase()}.png`;
    return {
      id: String(t.id ?? ''),
      abbreviation: String(t.abbreviation ?? ''),
      displayName: String(t.displayName ?? ''),
      shortDisplayName: String(t.shortDisplayName ?? ''),
      color: String(t.color ?? ''),
      alternateColor: String(t.alternateColor ?? ''),
      logo,
    };
  });
}

// ---------- Standings ----------

export type WnbaStandingRow = {
  teamId: string;
  abbreviation: string;
  displayName: string;
  logo: string;
  conference: 'Eastern' | 'Western' | string;
  wins: number;
  losses: number;
  winPct: number;
  gamesBack: number;
  pointDiff: number;
  ppg: number;
  oppPpg: number;
  homeRecord: string;       // "10-2"
  awayRecord: string;
  l10Wins: number;
  l10Losses: number;
  streak: string;            // "W3" / "L1"
};

// ESPN's standings endpoint requires `?group=conference` for E/W split.
// Schema is grouped by entries[].team plus stats array — we project
// to a clean per-team row.
export async function fetchWnbaStandings(): Promise<WnbaStandingRow[]> {
  const res = await fetch(`${ESPN}/standings?group=conference&type=overall`);
  if (!res.ok) throw new Error(`ESPN WNBA standings ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = await res.json() as any;
  const out: WnbaStandingRow[] = [];

  // Stat lookup by `name` from the array each entry ships.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statByName = (entries: any[], name: string): unknown => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = entries.find((x: any) => x.name === name);
    return s?.value ?? s?.displayValue;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groups: any[] = j.children ?? j.standings?.entries ?? [];
  for (const grp of groups) {
    const conferenceName = String(grp.name ?? grp.id ?? '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries: any[] = grp.standings?.entries ?? grp.entries ?? [];
    for (const e of entries) {
      const team = e.team ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stats: any[] = e.stats ?? [];
      const wins   = Number(statByName(stats, 'wins')   ?? 0) || 0;
      const losses = Number(statByName(stats, 'losses') ?? 0) || 0;
      const ptsFor = Number(statByName(stats, 'avgPointsFor')   ?? statByName(stats, 'pointsFor')   ?? 0) || 0;
      const ptsAgainst = Number(statByName(stats, 'avgPointsAgainst') ?? statByName(stats, 'pointsAgainst') ?? 0) || 0;
      const winPct = wins + losses > 0 ? wins / (wins + losses) : 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const logo: string = (team.logos ?? []).find((l: any) => (l.rel ?? []).includes('default'))?.href
        ?? `https://a.espncdn.com/i/teamlogos/wnba/500/${String(team.abbreviation ?? '').toLowerCase()}.png`;
      out.push({
        teamId: String(team.id ?? ''),
        abbreviation: String(team.abbreviation ?? ''),
        displayName: String(team.displayName ?? ''),
        logo,
        conference: conferenceName.includes('Eastern') ? 'Eastern' : conferenceName.includes('Western') ? 'Western' : conferenceName,
        wins,
        losses,
        winPct,
        gamesBack:  Number(statByName(stats, 'gamesBehind')  ?? 0) || 0,
        pointDiff:  Number(statByName(stats, 'avgPointDifferential') ?? statByName(stats, 'pointDifferential') ?? 0) || 0,
        ppg:        ptsFor,
        oppPpg:     ptsAgainst,
        homeRecord: String(statByName(stats, 'home') ?? '0-0'),
        awayRecord: String(statByName(stats, 'road') ?? '0-0'),
        l10Wins:    Number(statByName(stats, 'lastTenWins')   ?? 0) || 0,
        l10Losses:  Number(statByName(stats, 'lastTenLosses') ?? 0) || 0,
        streak:     String(statByName(stats, 'streak') ?? ''),
      });
    }
  }
  // Sort each conference by win%; the route handler can group again.
  out.sort((a, b) => b.winPct - a.winPct);
  return out;
}

// ---------- Today's games (scoreboard) ----------

export type WnbaScoreboardGame = {
  id: string;
  date: string;
  status: {
    state: 'pre' | 'in' | 'post';
    name: string;
    detail: string;
    completed: boolean;
  };
  away: WnbaScoreboardTeam;
  home: WnbaScoreboardTeam;
};

export type WnbaScoreboardTeam = {
  id: string;
  abbreviation: string;
  displayName: string;
  logo: string;
  score: string;
  homeAway: 'home' | 'away';
  record?: string;
  color?: string;
};

function todayEt(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

export async function fetchWnbaScoreboard(date?: string): Promise<{
  date: string | null;
  games: WnbaScoreboardGame[];
}> {
  const effectiveDate = date ?? todayEt();
  const url = `${ESPN}/scoreboard?dates=${effectiveDate.replace(/-/g, '')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN WNBA scoreboard ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = await res.json() as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const games: WnbaScoreboardGame[] = (j.events ?? []).map((e: any) => {
    const comp = e.competitions?.[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const teams = comp?.competitors ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (c: any): WnbaScoreboardTeam => ({
      id: String(c.team?.id ?? ''),
      abbreviation: String(c.team?.abbreviation ?? ''),
      displayName: String(c.team?.displayName ?? ''),
      logo: String(c.team?.logo ?? ''),
      score: String(c.score ?? ''),
      homeAway: c.homeAway === 'home' ? 'home' : 'away',
      record: c.record?.[0]?.summary,
      color: c.team?.color,
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

// ---------- Game summary (boxscore + leaders + injuries + linescore + winProb) ----------
//
// ESPN's basketball summary schema is identical between NBA and
// WNBA — fetchGameSummary in nba/espn.ts handles all the projection.
// Re-export with the WNBA league slug pre-bound so the route layer
// reads naturally.
import { fetchGameSummary as fetchEspnSummary, type EspnGameSummary } from '../nba/espn.js';

export async function fetchWnbaGameSummary(eventId: string): Promise<EspnGameSummary> {
  return fetchEspnSummary(eventId, 'wnba');
}

// ---------- Player headshot CDN (parity with NBA + MLB Avatar setup) ----------

export function wnbaPlayerHeadshotUrl(athleteId: number | string): string {
  return `https://a.espncdn.com/i/headshots/wnba/players/full/${athleteId}.png`;
}

export function wnbaTeamLogoUrl(abbr: string): string {
  return `https://a.espncdn.com/i/teamlogos/wnba/500/${abbr.toLowerCase()}.png`;
}

// Re-exports for tests / direct CDN URL access.
export const _wnbaCdnHelpers = {
  wnbaPlayerHeadshotUrl,
  wnbaTeamLogoUrl,
  ESPN_CORE,
};
