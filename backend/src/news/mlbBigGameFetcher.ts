// Fetch DetectionInput[] from today's completed MLB games. Phase 104i.
//
// Used by the big-game cron handler. Pulls today's schedule, filters
// to Final games, fetches each game's boxscore, and converts every
// player who logged a stat line into a DetectionInput. The big-game
// detector then decides which (if any) crossed the threshold.
//
// MLB-only for now. NBA + WNBA versions land alongside their boxscore
// shapes — wired in subsequent phases.

import {
  getBoxscore,
  getSchedule,
  inningsPitchedToNumeric,
  type MlbBoxscore,
  type MlbBoxscorePlayer,
  type MlbScheduleGame,
} from '../mlb/client.js';
import type { DetectionInput } from './bigGameDetector.js';

export async function fetchMlbBigGameInputs(date: string): Promise<DetectionInput[]> {
  const games = await safeSchedule(date);
  const finals = games.filter((g) => g.status?.abstractGameState === 'Final');
  if (finals.length === 0) return [];

  const out: DetectionInput[] = [];
  // Sequential rather than Promise.all — MLB Stats API does best with
  // a steady cadence. Boxscore endpoints are small (~50 KB each).
  for (const g of finals) {
    try {
      const box = await getBoxscore(g.gamePk);
      out.push(...inputsFromBoxscore(g, box, date));
    } catch (err) {
      console.warn(`big-game: boxscore fetch failed for gamePk=${g.gamePk}`, (err as Error).message);
    }
  }
  return out;
}

async function safeSchedule(date: string): Promise<MlbScheduleGame[]> {
  try {
    return await getSchedule(date);
  } catch (err) {
    console.warn('big-game: schedule fetch failed', (err as Error).message);
    return [];
  }
}

function inputsFromBoxscore(game: MlbScheduleGame, box: MlbBoxscore, gameDate: string): DetectionInput[] {
  const out: DetectionInput[] = [];
  const sides = [
    { side: 'home' as const, data: box.teams.home },
    { side: 'away' as const, data: box.teams.away },
  ];
  for (const { side, data } of sides) {
    const teamAbbr = data.team?.abbreviation ?? null;
    for (const playerKey of Object.keys(data.players)) {
      const p = data.players[playerKey];
      if (!p) continue;
      const stats = playerStats(p);
      // Skip players who didn't actually appear (no batting + no pitching).
      if (Object.values(stats).every((v) => v === 0 || v === null)) continue;
      out.push({
        sport: 'mlb',
        player: {
          id: p.person.id,
          name: p.person.fullName,
          team: teamAbbr,
        },
        game: {
          eventId: String(game.gamePk),
          gameDate,
          awayTeam: box.teams.away.team?.abbreviation ?? null,
          homeTeam: box.teams.home.team?.abbreviation ?? null,
          awayScore: numOrNull(game.teams.away.score),
          homeScore: numOrNull(game.teams.home.score),
          state: 'final',
        },
        stats,
      });
    }
    void side; // referenced only for clarity; eslint-no-unused-vars guard
  }
  return out;
}

function playerStats(p: MlbBoxscorePlayer): Record<string, number | null> {
  const b = p.stats?.batting;
  const pi = p.stats?.pitching;
  return {
    // Hitter stats
    home_runs:    numOrNull(b?.homeRuns),
    hits:         numOrNull(b?.hits),
    rbis:         numOrNull(b?.rbi),
    total_bases:  numOrNull(b?.totalBases),
    stolen_bases: numOrNull(b?.stolenBases),
    runs:         numOrNull(b?.runs),
    // Pitcher stats
    innings_pitched:     pi?.inningsPitched ? inningsPitchedToNumeric(pi.inningsPitched) : null,
    pitcher_strikeouts:  numOrNull(pi?.strikeOuts),
    earned_runs_allowed: numOrNull(pi?.earnedRuns),
    hits_allowed:        numOrNull(pi?.hits),
  };
}

function numOrNull(v: number | undefined | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
