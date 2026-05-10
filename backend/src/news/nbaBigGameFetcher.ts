// Fetch DetectionInput[] from today's completed NBA games. Phase 106a.
//
// Mirror of mlbBigGameFetcher.ts for basketball. ESPN scoreboard +
// summary endpoints give us starters + bench with per-player stats
// (points, rebounds, assists, steals, blocks, three-pointers made).
// We map every player-line who actually appeared into a DetectionInput.

import { fetchGameSummary, fetchScoreboard, type EspnPlayerLine } from '../nba/espn.js';
import type { DetectionInput } from './bigGameDetector.js';

export async function fetchNbaBigGameInputs(date: string): Promise<DetectionInput[]> {
  const scoreboard = await safeScoreboard(date);
  const finals = scoreboard.games.filter((g) => g.status.completed);
  if (finals.length === 0) return [];

  const out: DetectionInput[] = [];
  // Sequential — ESPN is fine with bursts but we keep load steady.
  for (const g of finals) {
    try {
      const summary = await fetchGameSummary(g.id, 'nba');
      const allPlayers = [...summary.away.starters, ...summary.away.bench, ...summary.home.starters, ...summary.home.bench];
      for (const p of allPlayers) {
        if (p.didNotPlay || p.minutes === 0) continue;
        const teamAbbr = isOnTeam(p, summary.away) ? summary.away.abbreviation : summary.home.abbreviation;
        out.push({
          sport: 'nba',
          player: {
            id: p.athleteId,
            name: p.displayName,
            team: teamAbbr,
          },
          game: {
            eventId: summary.eventId,
            gameDate: date,
            awayTeam: summary.away.abbreviation,
            homeTeam: summary.home.abbreviation,
            awayScore: summary.totals.away,
            homeScore: summary.totals.home,
            state: 'final',
          },
          stats: {
            points:        p.points,
            rebounds:      p.rebounds,
            assists:       p.assists,
            steals:        p.steals,
            blocks:        p.blocks,
            three_pt_made: parseMade(p.threePt),
            minutes:       p.minutes,
          },
        });
      }
    } catch (err) {
      console.warn(`big-game-nba: summary fetch failed for ${g.id}`, (err as Error).message);
    }
  }
  return out;
}

async function safeScoreboard(date: string): Promise<Awaited<ReturnType<typeof fetchScoreboard>>> {
  try {
    return await fetchScoreboard(date);
  } catch (err) {
    console.warn('big-game-nba: scoreboard fetch failed', (err as Error).message);
    return { date: null, games: [] };
  }
}

// ESPN ships starters + bench keyed per side, but doesn't tag players
// with their team explicitly. We resolve via list identity rather than
// name/jersey (cheaper and exact).
function isOnTeam(p: EspnPlayerLine, side: { starters: EspnPlayerLine[]; bench: EspnPlayerLine[] }): boolean {
  return side.starters.includes(p) || side.bench.includes(p);
}

// ESPN renders 3PM as "5-12" (made-attempted). The first half is the
// made count we want for big-game thresholds (8+ 3PM trigger).
function parseMade(s: string): number {
  if (!s) return 0;
  const dash = s.indexOf('-');
  const made = dash >= 0 ? Number(s.slice(0, dash)) : Number(s);
  return Number.isFinite(made) ? made : 0;
}
