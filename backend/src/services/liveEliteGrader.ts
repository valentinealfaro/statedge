// Live per-leg grader — Phase 145.
//
// Companion to eliteTicketStore.ts. Where eliteTicketStore.gradeOneLeg()
// only returns a final boolean once a game completes, this service
// returns IN-FLIGHT state too: the player's current stat value, the
// game's status (pre/live/final), and a per-leg verdict that can be
// PENDING / IN_FLIGHT / HIT / MISS / PUSH / ON_PACE_HIT (already
// locked in for OVER legs) / ON_PACE_MISS (locked out for UNDER legs).
//
// Used by the /api/slate/elite/live-state endpoint so the Elite ticket
// page can show a real-time scoreboard of "leg 1: 18 / 22.5 PTS · IN
// FLIGHT", "leg 2: HIT" etc. — making the institutional truth metric
// visible while games are running, not just retrospectively.

import { fetchScoreboard, fetchGameSummary, type EspnPlayerLine } from '../nba/espn.js';
import { getLiveGameFeed, getSchedule, type MlbLiveBoxscorePlayer } from '../mlb/client.js';
import { fetchUfcScoreboard, fetchUfcFightCenter } from '../mma/espn.js';

const MLB_STAT_KEYS = new Set([
  'home_runs', 'total_bases', 'rbis', 'runs', 'hits', 'hits_runs_rbis',
  'walks', 'stolen_bases', 'strikeouts', 'doubles', 'triples', 'ks',
  'pitcher_outs', 'innings_pitched', 'earned_runs_allowed',
  'hits_allowed', 'walks_allowed', 'home_runs_allowed',
]);
const MMA_STAT_KEYS = new Set([
  'sig_strikes', 'rd1_sig_strikes', 'takedowns', 'rd1_takedowns',
  'knockdowns', 'rounds', 'fight_time', 'fantasy_score', 'control_time',
]);

export type LegInput = {
  playerId: number;
  playerName: string;
  statKey: string;
  direction: 'OVER' | 'UNDER';
  line: number;
  // Optional ESPN athlete id — set by callers (cross-sport elite
  // builder, persisted ticket grader) for UFC legs where playerId
  // collapses to 0 because ESPN fighter ids are alphanumeric. The
  // MMA grader prefers this for the scoreboard-id match path before
  // falling back to display-name match.
  espnAthleteId?: string;
};

export type LegLiveVerdict =
  | 'PENDING'        // game hasn't started, or no current value yet
  | 'IN_FLIGHT'      // game is live, current value is between 0 and line
  | 'ON_PACE_HIT'    // game live, OVER leg already cleared (locked in)
  | 'ON_PACE_MISS'   // game live, UNDER leg already locked out
  | 'HIT'            // final, hit
  | 'MISS'           // final, miss
  | 'PUSH'           // final, equal to line
  | 'UNGRADED';      // no honest live signal — e.g. unsupported UFC
                      // stat keys (rd1_*, rounds, fight_time, fantasy_score),
                      // a missing source feed, or a fighter we can't match
                      // on the scoreboard. Frontend hides the pill for
                      // UNGRADED so users never see a fabricated verdict.

export type LegLiveState = {
  playerId: number;
  playerName: string;
  statKey: string;
  direction: 'OVER' | 'UNDER';
  line: number;
  currentValue: number | null;
  gameStatus: 'pre' | 'live' | 'final' | 'unknown';
  verdict: LegLiveVerdict;
};

function legSport(statKey: string): 'mlb' | 'nba' | 'mma' {
  if (MMA_STAT_KEYS.has(statKey)) return 'mma';
  if (MLB_STAT_KEYS.has(statKey)) return 'mlb';
  return 'nba';
}

// Map our NBA stat keys onto the EspnPlayerLine fields. Mirrors the
// helper in eliteTicketStore.ts — keep them in sync.
function nbaStatValue(p: EspnPlayerLine, statKey: string): number | null {
  switch (statKey) {
    case 'points': return p.points;
    case 'rebounds': return p.rebounds;
    case 'assists': return p.assists;
    case 'steals': return p.steals;
    case 'blocks': return p.blocks;
    case 'turnovers': return p.turnovers;
    case 'three_pt_made': {
      const i = p.threePt.indexOf('-');
      return i > 0 ? Number(p.threePt.slice(0, i)) : null;
    }
    case 'fg_made': {
      const i = p.fg.indexOf('-');
      return i > 0 ? Number(p.fg.slice(0, i)) : null;
    }
    case 'ft_made': {
      const i = p.ft.indexOf('-');
      return i > 0 ? Number(p.ft.slice(0, i)) : null;
    }
    case 'pra': return p.points + p.rebounds + p.assists;
    case 'pr': return p.points + p.rebounds;
    case 'pa': return p.points + p.assists;
    case 'ra': return p.rebounds + p.assists;
    case 'stocks': return p.steals + p.blocks;
    default: return null;
  }
}

function verdictForLive(
  current: number,
  line: number,
  direction: 'OVER' | 'UNDER',
  isFinal: boolean,
): LegLiveVerdict {
  if (isFinal) {
    if (current === line) return 'PUSH';
    return direction === 'OVER'
      ? (current > line ? 'HIT' : 'MISS')
      : (current < line ? 'HIT' : 'MISS');
  }
  // In-flight. For OVER legs, once current > line it's locked in
  // (counters only grow). For UNDER legs, once current > line it's
  // locked out.
  if (direction === 'OVER') {
    return current > line ? 'ON_PACE_HIT' : 'IN_FLIGHT';
  }
  return current > line ? 'ON_PACE_MISS' : 'IN_FLIGHT';
}

async function gradeNbaLegLive(leg: LegInput, gameDate: string): Promise<LegLiveState> {
  const fallback: LegLiveState = {
    playerId: leg.playerId,
    playerName: leg.playerName,
    statKey: leg.statKey,
    direction: leg.direction,
    line: leg.line,
    currentValue: null,
    gameStatus: 'unknown',
    verdict: 'PENDING',
  };
  try {
    const scoreboard = await fetchScoreboard(gameDate);
    const games = scoreboard.games;
    if (games.length === 0) return fallback;

    // Walk every game (live + final + pre). For each, fetch summary
    // and look up the player. First match wins. ESPN's NBA scoreboard
    // is small enough that this is fine for a per-poll lookup.
    for (const g of games) {
      const summary = await fetchGameSummary(g.id, 'nba').catch(() => null);
      if (!summary) continue;
      const allPlayers = [
        ...summary.away.starters, ...summary.away.bench,
        ...summary.home.starters, ...summary.home.bench,
      ];
      const match =
        allPlayers.find((p) => Number(p.athleteId) === leg.playerId) ??
        allPlayers.find((p) => p.displayName === leg.playerName);
      if (!match) continue;

      const isFinal = g.status.completed;
      const isLive = g.status.state === 'in';
      const isPre = g.status.state === 'pre';
      const status: LegLiveState['gameStatus'] =
        isFinal ? 'final' : isLive ? 'live' : isPre ? 'pre' : 'unknown';

      // DNP / hasn't subbed in yet → PENDING
      if (match.didNotPlay || match.minutes === 0) {
        return { ...fallback, gameStatus: status, verdict: isFinal ? 'MISS' : 'PENDING' };
      }
      const cur = nbaStatValue(match, leg.statKey);
      if (cur === null) {
        return { ...fallback, gameStatus: status };
      }
      return {
        ...fallback,
        currentValue: cur,
        gameStatus: status,
        verdict: isPre
          ? 'PENDING'
          : verdictForLive(cur, leg.line, leg.direction, isFinal),
      };
    }
    return fallback;
  } catch (err) {
    console.warn('nba live grade failed', (err as Error).message);
    return fallback;
  }
}

// MLB live grader. Walks today's MLB schedule, finds the game
// containing the player, fetches the live feed boxscore, extracts
// the stat value.
async function gradeMlbLegLive(leg: LegInput, gameDate: string): Promise<LegLiveState> {
  const fallback: LegLiveState = {
    playerId: leg.playerId,
    playerName: leg.playerName,
    statKey: leg.statKey,
    direction: leg.direction,
    line: leg.line,
    currentValue: null,
    gameStatus: 'unknown',
    verdict: 'PENDING',
  };
  try {
    const games = await getSchedule(gameDate).catch(() => []);
    if (!games || games.length === 0) return fallback;

    // Race through the schedule; first feed that has this player wins.
    // MLB boxscore.players keys look like "ID123456" — compose the key.
    const playerKey = `ID${leg.playerId}`;
    for (const g of games) {
      const feed = await getLiveGameFeed(g.gamePk).catch(() => null);
      if (!feed) continue;
      const players = {
        ...feed.liveData.boxscore?.teams?.away?.players ?? {},
        ...feed.liveData.boxscore?.teams?.home?.players ?? {},
      };
      const p = players[playerKey] as MlbLiveBoxscorePlayer | undefined;
      if (!p) continue;

      const abstract = feed.gameData.status.abstractGameState; // Preview/Live/Final
      const status: LegLiveState['gameStatus'] =
        abstract === 'Final' ? 'final'
        : abstract === 'Live' ? 'live'
        : abstract === 'Preview' ? 'pre'
        : 'unknown';

      const cur = mlbStatValue(p, leg.statKey);
      if (cur === null) {
        return { ...fallback, gameStatus: status };
      }
      const isFinal = status === 'final';
      const isPre = status === 'pre';
      return {
        ...fallback,
        currentValue: cur,
        gameStatus: status,
        verdict: isPre
          ? 'PENDING'
          : verdictForLive(cur, leg.line, leg.direction, isFinal),
      };
    }
    return fallback;
  } catch (err) {
    console.warn('mlb live grade failed', (err as Error).message);
    return fallback;
  }
}

// Pull a stat value out of the MLB live boxscore player payload.
// Hitting stats live under stats.batting; pitching under stats.pitching.
// Compound keys (e.g. hits_runs_rbis) sum components.
function mlbStatValue(p: MlbLiveBoxscorePlayer, statKey: string): number | null {
  const b = p.stats?.batting ?? {};
  const pi = p.stats?.pitching ?? {};
  const num = (v: unknown): number | null => {
    if (v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  switch (statKey) {
    case 'hits':            return num(b.hits);
    case 'home_runs':       return num(b.homeRuns);
    case 'rbis':            return num(b.rbi);
    case 'runs':            return num(b.runs);
    case 'walks':           return num(b.baseOnBalls);
    case 'doubles':         return num(b.doubles);
    case 'triples':         return num(b.triples);
    case 'stolen_bases':    return num(b.stolenBases);
    case 'strikeouts':      return num(b.strikeOuts);   // hitter Ks
    case 'total_bases': {
      const tb = num(b.totalBases);
      if (tb !== null) return tb;
      // Compute from components if MLB feed didn't surface totalBases.
      const hits = num(b.hits) ?? 0;
      const dbl = num(b.doubles) ?? 0;
      const tpl = num(b.triples) ?? 0;
      const hr = num(b.homeRuns) ?? 0;
      const singles = Math.max(0, hits - dbl - tpl - hr);
      return singles + 2 * dbl + 3 * tpl + 4 * hr;
    }
    case 'hits_runs_rbis': {
      const h = num(b.hits) ?? 0;
      const r = num(b.runs) ?? 0;
      const rb = num(b.rbi) ?? 0;
      return h + r + rb;
    }
    case 'ks':                  return num(pi.strikeOuts);   // pitcher Ks
    case 'pitcher_outs':        return num(pi.outs);
    case 'innings_pitched':     return num(pi.inningsPitched);
    case 'earned_runs_allowed': return num(pi.earnedRuns);
    case 'hits_allowed':        return num(pi.hits);
    case 'walks_allowed':       return num(pi.baseOnBalls);
    case 'home_runs_allowed':   return num(pi.homeRuns);
    default: return null;
  }
}

// MMA live grader — Phase 148o.
//
// Walks today's UFC scoreboard, finds the event + fight that contains
// the fighter (by athlete id when present, else display-name match),
// fetches the fightcenter for live in-fight stats, then maps the
// statKey to the appropriate stat field. Stats supported:
//   - sig_strikes     → competitor.stats.sigStrikesLanded
//   - takedowns       → competitor.stats.takedownsLanded
//   - knockdowns      → competitor.stats.knockdowns
//   - control_time    → competitor.stats.timeInControlSec
// Other UFC stat keys (rd1_*, rounds, fight_time, fantasy_score) need
// either round-by-round data or live fight clock — left UNGRADED for
// honesty.
async function gradeMmaLegLive(leg: LegInput, _gameDate: string): Promise<LegLiveState> {
  const fallback: LegLiveState = {
    playerId: leg.playerId,
    playerName: leg.playerName,
    statKey: leg.statKey,
    direction: leg.direction,
    line: leg.line,
    currentValue: null,
    gameStatus: 'unknown',
    verdict: 'UNGRADED',
  };
  // Stat keys we can grade from this-fight live data.
  const supported = new Set(['sig_strikes', 'takedowns', 'knockdowns', 'control_time']);
  if (!supported.has(leg.statKey)) {
    return fallback;     // honest UNGRADED for unsupported stat keys
  }

  try {
    const events = await fetchUfcScoreboard().catch(() => []);
    if (!events || events.length === 0) return fallback;

    // Prefer the optional alphanumeric ESPN athlete id when the
    // caller has it (fightcenter ids are not numeric, so playerId=0
    // is the typical EliteCandidate coerce for UFC). Falls through
    // to the numeric playerId then to display-name match.
    const playerIdStr = leg.espnAthleteId ?? String(leg.playerId);
    const targetName = mmaNorm(leg.playerName);

    // Find the event + fight + corner containing this fighter. Prefer
    // ESPN athlete id match; fall back to normalized display-name
    // match (which mirrors how /elite cross-sport pairs fighters).
    type Hit = { eventId: string; fightId: string; eventState: 'pre' | 'in' | 'post'; fightState: 'pre' | 'in' | 'post' };
    let hit: Hit | null = null;
    for (const ev of events) {
      for (const f of ev.fights) {
        for (const corner of [f.fighters.red, f.fighters.blue]) {
          if (!corner) continue;
          const idMatch = corner.id && corner.id === playerIdStr;
          const nameMatch = !idMatch && mmaNorm(corner.displayName) === targetName;
          if (idMatch || nameMatch) {
            hit = { eventId: ev.id, fightId: f.id, eventState: ev.state, fightState: f.state };
            break;
          }
        }
        if (hit) break;
      }
      if (hit) break;
    }
    if (!hit) return fallback;

    const status: LegLiveState['gameStatus'] =
      hit.fightState === 'post' ? 'final'
      : hit.fightState === 'in' ? 'live'
      : hit.fightState === 'pre' ? 'pre'
      : 'unknown';

    if (status === 'pre') {
      return { ...fallback, gameStatus: 'pre', verdict: 'PENDING' };
    }

    // Pull this-fight stats.
    const fc = await fetchUfcFightCenter(hit.eventId, hit.fightId);
    const me = fc.red?.id === playerIdStr || mmaNorm(fc.red?.displayName ?? '') === targetName
      ? fc.red
      : fc.blue?.id === playerIdStr || mmaNorm(fc.blue?.displayName ?? '') === targetName
      ? fc.blue
      : null;
    if (!me?.liveStats) {
      return { ...fallback, gameStatus: status };
    }
    const stats = me.liveStats;
    let cur: number | null = null;
    switch (leg.statKey) {
      case 'sig_strikes': cur = stats.sigStrikesLanded; break;
      case 'takedowns':   cur = stats.takedownsLanded; break;
      case 'knockdowns':  cur = stats.knockdowns; break;
      case 'control_time': cur = stats.timeInControlSec; break;
    }
    if (cur === null) {
      return { ...fallback, gameStatus: status };
    }
    return {
      ...fallback,
      currentValue: cur,
      gameStatus: status,
      verdict: verdictForLive(cur, leg.line, leg.direction, status === 'final'),
    };
  } catch (err) {
    console.warn('mma live grade failed', (err as Error).message);
    return fallback;
  }
}

// Diacritic + punctuation strip for fighter-name matching. Mirrors the
// fighterNorm() used in the /elite cross-sport route so UFC slate
// names (admin-pasted) line up with ESPN scoreboard display names.
function mmaNorm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/\./g, '')                // "C. Carpenter" → "c carpenter"
    .replace(/\s+/g, ' ')
    .trim();
}

// Public entry point. Grades every leg in parallel; failures yield a
// PENDING / UNGRADED fallback per-leg rather than failing the whole
// request. Caller passes the game date (YYYY-MM-DD ET) so the response
// is deterministic across midnight rollover.
export async function liveGradeElite(
  legs: LegInput[],
  gameDate: string,
): Promise<LegLiveState[]> {
  return Promise.all(
    legs.map(async (leg) => {
      const sport = legSport(leg.statKey);
      if (sport === 'nba') return gradeNbaLegLive(leg, gameDate);
      if (sport === 'mlb') return gradeMlbLegLive(leg, gameDate);
      // MMA — supported stat keys grade against fightcenter live stats;
      // unsupported ones (rounds, fantasy_score, etc.) stay UNGRADED.
      return gradeMmaLegLive(leg, gameDate);
    }),
  );
}
