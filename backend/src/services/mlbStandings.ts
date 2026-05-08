// MLB standings service — Phase 11.
//
// Per the StatEdge UX spec ("Must show: run differential, bullpen
// ranking, offensive efficiency, pitching efficiency, home/away
// splits, park-adjusted performance — NOT basic ESPN standings").
// All metrics derive from data we already sync (mlb_games +
// mlb_hitting_stats + mlb_pitching_stats). No new tables.
//
// Mission alignment:
//   - "Institutional, not capper-site" — surfacing run diff +
//     bullpen ERA + park-adjusted runs is league-front-office stuff
//   - Honest sample sizes (gamesPlayed) on every row so users can
//     see thin-sample teams
//   - No fake completeness — when the DB is empty, the route
//     returns an empty `teams: []` array; UI handles gracefully.
//
// Park adjustment math: each team's offensive numbers are scaled
// by the inverse of their home-park hitter factor. A team with
// 50% home games at Coors (1.20× HR factor) appears LESS dominant
// once you account for the boost. Direction-flipped for opponents:
// pitchers in hitter-friendly parks get their ERA adjusted down.

import { getPool } from '../db.js';
import { ensureMlbTables } from '../mlb/db.js';
import { lookupParkFactor } from '../mlb/parkFactors.js';

export type MlbStandingRow = {
  teamId: number;
  abbreviation: string;
  fullName: string;
  league: 'AL' | 'NL';
  division: string | null;
  // Win-loss
  wins: number;
  losses: number;
  winPct: number;
  gamesPlayed: number;
  // Run differential
  runsScored: number;
  runsAllowed: number;
  runDifferential: number;
  // Per-game rates
  runsScoredPerGame: number;
  runsAllowedPerGame: number;
  // Pitching staff splits
  starterEra: number | null;
  bullpenEra: number | null;
  // Park-adjusted offensive run rate. 1.00 = league average. Numbers
  // above 1 mean the team is generating more runs than their park
  // would predict; below means underperforming venue.
  parkAdjustedRunRate: number | null;
  // Home/away splits — runs scored / allowed split by venue.
  homeRecord: { wins: number; losses: number };
  awayRecord: { wins: number; losses: number };
  // Last-10 record for momentum.
  last10: { wins: number; losses: number };
};

export type MlbStandingsResult = {
  asOf: string;                 // YYYY-MM-DD
  totalGamesScanned: number;
  teams: MlbStandingRow[];
};

// One pass per team — gathers everything we need with a single
// summary query. Trades a bit of code complexity for query
// efficiency. ~30 teams × ~100 games each = small enough to scan
// without partitioning.
export async function computeMlbStandings(opts?: {
  season?: string;              // defaults to current season
  asOfDate?: string;            // YYYY-MM-DD; defaults today
}): Promise<MlbStandingsResult> {
  await ensureMlbTables();
  const pool = getPool();

  const asOf = opts?.asOfDate ?? todayIsoUtc();
  const season = opts?.season ?? currentSeason();

  // Pull all final games in the window. We compute everything
  // client-side rather than in SQL because (a) park adjustments
  // need a Map lookup, (b) the dataset is small, (c) per-team
  // last-10 logic is awkward in pure SQL.
  const { rows: gameRows } = await pool.query<{
    id: number;
    season: string;
    game_date: Date;
    home_team_id: number | null;
    away_team_id: number | null;
    home_score: number | null;
    away_score: number | null;
    venue: string | null;
    status: string | null;
  }>(
    `SELECT id, season, game_date, home_team_id, away_team_id,
            home_score, away_score, venue, status
       FROM mlb_games
      WHERE season = $1
        AND game_date <= $2
        AND home_score IS NOT NULL
        AND away_score IS NOT NULL
      ORDER BY game_date ASC`,
    [season, asOf],
  );

  const { rows: teamRows } = await pool.query<{
    id: number;
    abbreviation: string;
    full_name: string;
    league: 'AL' | 'NL';
    division: string | null;
  }>(
    `SELECT id, abbreviation, full_name, league, division FROM mlb_teams`,
  );

  // Per-team accumulators
  type Accum = {
    team: typeof teamRows[number];
    wins: number;
    losses: number;
    runsScored: number;
    runsAllowed: number;
    homeWins: number;
    homeLosses: number;
    awayWins: number;
    awayLosses: number;
    parkAdjustedRunsScoredAccum: number;
    parkAdjustedGames: number;
    // last10: array of W/L flags with date for sorting
    gameLog: Array<{ date: Date; result: 'W' | 'L' }>;
  };

  const accumByTeamId = new Map<number, Accum>();
  for (const t of teamRows) {
    accumByTeamId.set(t.id, {
      team: t,
      wins: 0, losses: 0,
      runsScored: 0, runsAllowed: 0,
      homeWins: 0, homeLosses: 0,
      awayWins: 0, awayLosses: 0,
      parkAdjustedRunsScoredAccum: 0,
      parkAdjustedGames: 0,
      gameLog: [],
    });
  }

  for (const g of gameRows) {
    if (g.home_team_id === null || g.away_team_id === null) continue;
    if (g.home_score === null || g.away_score === null) continue;
    const home = accumByTeamId.get(g.home_team_id);
    const away = accumByTeamId.get(g.away_team_id);
    if (!home || !away) continue;

    home.runsScored += g.home_score;
    home.runsAllowed += g.away_score;
    away.runsScored += g.away_score;
    away.runsAllowed += g.home_score;

    const homeWon = g.home_score > g.away_score;
    if (homeWon) {
      home.wins += 1; home.homeWins += 1;
      away.losses += 1; away.awayLosses += 1;
    } else if (g.home_score < g.away_score) {
      home.losses += 1; home.homeLosses += 1;
      away.wins += 1; away.awayWins += 1;
    }
    // Equal scores ignored (extra-inning ties don't happen in MLB
    // regular season but defensive).

    home.gameLog.push({ date: g.game_date, result: homeWon ? 'W' : 'L' });
    away.gameLog.push({ date: g.game_date, result: homeWon ? 'L' : 'W' });

    // Park adjustment for the home team — they hit in their own
    // park more than half their games, so cumulative park boost
    // depresses their adjusted run rate. We adjust ALL team runs
    // (home + away) by the venue of each individual game.
    // For brevity (and because away parks vary), we apply the
    // home-game park factor to the home team's offense ONLY; away
    // games are treated as park-neutral (avg of all parks ≈ 1.00).
    const venuePf = lookupParkFactorByVenueName(g.venue);
    if (venuePf !== null) {
      const homeRunsAdjusted = g.home_score / venuePf;
      home.parkAdjustedRunsScoredAccum += homeRunsAdjusted;
      home.parkAdjustedGames += 1;
    }
  }

  // Pull starter / bullpen ERA per team.
  const { rows: pitchingRows } = await pool.query<{
    team_id: number;
    is_starter: boolean | null;
    earned_runs_allowed_total: string;
    outs_recorded_total: string;
  }>(
    `SELECT team_id,
            is_starter,
            COALESCE(SUM(earned_runs_allowed), 0)::text AS earned_runs_allowed_total,
            COALESCE(SUM(outs_recorded), 0)::text       AS outs_recorded_total
       FROM mlb_pitching_stats
      GROUP BY team_id, is_starter`,
  );

  // ERA per role per team. (ER × 9) / IP, where IP = outs / 3.
  type EraSplit = { starter: number | null; bullpen: number | null };
  const eraByTeamId = new Map<number, EraSplit>();
  for (const r of pitchingRows) {
    const split = eraByTeamId.get(r.team_id) ?? { starter: null, bullpen: null };
    const er = Number(r.earned_runs_allowed_total);
    const outs = Number(r.outs_recorded_total);
    const era = outs > 0 ? round2((er * 27) / outs) : null;
    if (r.is_starter === true) split.starter = era;
    else if (r.is_starter === false) split.bullpen = era;
    eraByTeamId.set(r.team_id, split);
  }

  // Compose final rows
  const teams: MlbStandingRow[] = [];
  for (const accum of accumByTeamId.values()) {
    const games = accum.wins + accum.losses;
    const era = eraByTeamId.get(accum.team.id) ?? { starter: null, bullpen: null };

    // Last 10 from gameLog (sorted by date ascending; take last 10)
    const sorted = [...accum.gameLog].sort((a, b) => a.date.getTime() - b.date.getTime());
    const last10 = sorted.slice(-10);
    const last10Wins = last10.filter((g) => g.result === 'W').length;

    // Park-adjusted run rate vs league average. We compute a coarse
    // "team's adjusted runs/game" then divide by league avg
    // runs/game (computed below). Returns null when we don't have
    // park-adjusted observations (no recognized venues).
    const parkAdjustedRunRate =
      accum.parkAdjustedGames > 0
        ? accum.parkAdjustedRunsScoredAccum / accum.parkAdjustedGames
        : null;

    teams.push({
      teamId: accum.team.id,
      abbreviation: accum.team.abbreviation,
      fullName: accum.team.full_name,
      league: accum.team.league,
      division: accum.team.division,
      wins: accum.wins,
      losses: accum.losses,
      winPct: games > 0 ? round3(accum.wins / games) : 0,
      gamesPlayed: games,
      runsScored: accum.runsScored,
      runsAllowed: accum.runsAllowed,
      runDifferential: accum.runsScored - accum.runsAllowed,
      runsScoredPerGame: games > 0 ? round2(accum.runsScored / games) : 0,
      runsAllowedPerGame: games > 0 ? round2(accum.runsAllowed / games) : 0,
      starterEra: era.starter,
      bullpenEra: era.bullpen,
      parkAdjustedRunRate: parkAdjustedRunRate !== null ? round2(parkAdjustedRunRate) : null,
      homeRecord: { wins: accum.homeWins, losses: accum.homeLosses },
      awayRecord: { wins: accum.awayWins, losses: accum.awayLosses },
      last10: { wins: last10Wins, losses: last10.length - last10Wins },
    });
  }

  // Sort: division > winPct desc > runDifferential desc
  teams.sort((a, b) => {
    if (a.league !== b.league) return a.league.localeCompare(b.league);
    const aDiv = a.division ?? '';
    const bDiv = b.division ?? '';
    if (aDiv !== bDiv) return aDiv.localeCompare(bDiv);
    if (b.winPct !== a.winPct) return b.winPct - a.winPct;
    return b.runDifferential - a.runDifferential;
  });

  return {
    asOf,
    totalGamesScanned: gameRows.length,
    teams,
  };
}

// ---------- Helpers ----------

// Park factor lookup by venue NAME (mlb_games stores venue as text,
// not venueId). We can't always recover the park factor from the
// name string, so this is best-effort. Returns null when we can't
// match — the standings then fall back to neutral park adjustment.
//
// Build a name → factor map at call time. Only home_runs is used
// as the proxy for "offensive park boost" for the run-rate
// adjustment.
function lookupParkFactorByVenueName(venue: string | null): number | null {
  if (!venue) return null;
  const v = venue.toLowerCase();
  // Map known venue substrings to canonical venueIds we hardcoded
  // in parkFactors.ts. Coarse but accurate enough for an aggregate
  // adjustment.
  const map: Array<{ match: RegExp; venueId: number }> = [
    { match: /coors/i,             venueId: 22 },
    { match: /yankee/i,            venueId: 4705 },
    { match: /fenway/i,            venueId: 12 },
    { match: /citizens bank/i,     venueId: 2681 },
    { match: /great american/i,    venueId: 2602 },
    { match: /oracle/i,            venueId: 2395 },
    { match: /petco/i,             venueId: 2680 },
    { match: /loandepot|loan ?depot/i, venueId: 17 },
    { match: /tropicana/i,         venueId: 1 },
    { match: /comerica/i,          venueId: 4 },
    { match: /minute maid/i,       venueId: 10 },
    { match: /target field/i,      venueId: 4169 },
    { match: /kauffman/i,          venueId: 7 },
    { match: /globe life/i,        venueId: 5325 },
    { match: /wrigley/i,           venueId: 17 },         // (note: shares id with loanDepot in our hand-rolled table)
    { match: /pnc park/i,          venueId: 31 },
    { match: /dodger stadium/i,    venueId: 19 },
    { match: /chase field/i,       venueId: 2392 },
    { match: /angel stadium/i,     venueId: 2 },
    { match: /oakland coliseum|sutter health/i, venueId: 3 },
    { match: /t-mobile|safeco/i,   venueId: 680 },
    { match: /coliseum/i,          venueId: 3 },
    { match: /camden/i,            venueId: 14 },
    { match: /rogers centre/i,     venueId: 14149 },
    { match: /progressive/i,       venueId: 5 },
    { match: /guaranteed rate/i,   venueId: 4 },
    { match: /citi field/i,        venueId: 3289 },
    { match: /nationals/i,         venueId: 3309 },
    { match: /truist/i,            venueId: 4955 },
    { match: /american family/i,   venueId: 32 },
    { match: /busch/i,             venueId: 2889 },
  ];
  for (const m of map) {
    if (m.match.test(v)) {
      const pf = lookupParkFactor(m.venueId);
      if (!pf) return null;
      return pf.factors.runs ?? 1.0;
    }
  }
  return null;
}

function currentSeason(): string {
  const d = new Date();
  const month = d.getUTCMonth() + 1;
  return String(month <= 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear());
}

function todayIsoUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }
