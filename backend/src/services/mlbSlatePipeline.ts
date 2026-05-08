// MLB slate pipeline. Takes raw MLB prop lines (player + stat + line +
// direction + optional game context), runs each through the
// projection engine, and returns enriched lines ready for the slate
// builder. The boundary between "ingestion" and "construction" stays
// clean here — pipeline knows about projections, builder knows about
// cards.
//
// Mission discipline: this is a small, focused layer. PrizePicks
// scraping, OCR, and Gemini parsing are NBA-specific and not ported
// here yet — for v1, the admin pastes lines as JSON. The engine
// works the same way regardless of input source.

import {
  projectMlbStat,
  type ProjectionResult,
} from './mlbProjectionEngine.js';
import { statMeta, type MlbStatKey } from '../mlb/stats.js';
import { getPool } from '../db.js';

// ---------- Inputs ----------

// What the slate UI / API ingests. Minimal — just enough to identify
// the player, stat, and what's bookable. Game context (gamePk +
// opposing pitcher) is optional but unlocks park / weather / lineup /
// BvP layers when supplied.
export type RawMlbLine = {
  playerId: number;
  playerName?: string;          // optional display label; we re-resolve from DB
  statKey: MlbStatKey;
  line: number;
  // 'over' = Demon (over-only line), 'under' = Goblin, 'both' = standard.
  // Mirrors PrizePicks's side-restriction model; default 'both'.
  direction?: 'over' | 'under' | 'both';
  // Tonight's game context — when known, the projection layers up.
  gamePk?: number;
  opponentTeamId?: number;
  isHome?: boolean;
  opposingPitcherId?: number;
};

// ---------- Outputs ----------

// One projected leg. The slate builder ranks / filters / combines
// these into Combos. Every leg carries the full ProjectionResult so
// the builder can interrogate edge / risk / trap / context per leg
// without re-running anything.
export type ResolvedMlbLine = {
  playerId: number;
  playerName: string;
  position: string | null;
  team: { id: number | null; abbr: string | null };
  isPitcher: boolean;
  statKey: MlbStatKey;
  statLabel: string;
  line: number;
  // 'over' = Demon-restricted, 'under' = Goblin-restricted, 'both' = standard.
  bookableSide: 'over' | 'under' | 'both';
  // Direction the model leans. Drives which side we'd actually pick
  // for this line if we were composing a card.
  modelDirection: 'OVER' | 'UNDER';
  projection: ProjectionResult;
  // Game-context surface for UI. When gamePk wasn't provided these
  // are null — pipeline doesn't fabricate context.
  gamePk: number | null;
  venueName: string | null;
};

export type UnresolvedMlbLine = {
  raw: RawMlbLine;
  reason: string;
};

export type MlbSlateResolveResult = {
  lines: ResolvedMlbLine[];
  unresolved: UnresolvedMlbLine[];
};

// ---------- Pipeline ----------

// Resolve a list of raw lines into projected legs. Runs sequentially
// (not in parallel) to keep MLB API rate-limit pressure low when
// gamePk is provided — every gamePk triggers schedule + boxscore
// fetches. For 20-30 lines per slate this is fine; we can shard
// later if it becomes a bottleneck.
export async function resolveMlbSlate(
  raws: RawMlbLine[],
): Promise<MlbSlateResolveResult> {
  const lines: ResolvedMlbLine[] = [];
  const unresolved: UnresolvedMlbLine[] = [];

  for (const raw of raws) {
    try {
      const player = await loadPlayer(raw.playerId);
      if (!player) {
        unresolved.push({ raw, reason: `Player ${raw.playerId} not found in mlb_players.` });
        continue;
      }
      // Determine model direction. If the line is Demon-restricted
      // ('over' bookable side), we MUST pick OVER. Goblin → UNDER.
      // Standard ('both') → let the projection lean decide; we run
      // the engine on OVER first, then check probability to pick the
      // direction with edge.
      const bookable = raw.direction ?? 'both';
      const modelDirection: 'OVER' | 'UNDER' =
        bookable === 'over' ? 'OVER'
        : bookable === 'under' ? 'UNDER'
        : await pickBetterDirection(raw, player.isPitcher);

      const projection = await projectMlbStat({
        playerId: raw.playerId,
        statKey: raw.statKey,
        line: raw.line,
        direction: modelDirection,
        opponentTeamId: raw.opponentTeamId,
        isHome: raw.isHome,
        gamePk: raw.gamePk,
        opposingPitcherId: raw.opposingPitcherId,
      });

      lines.push({
        playerId: raw.playerId,
        playerName: player.fullName,
        position: player.position,
        team: { id: player.teamId, abbr: player.teamAbbr },
        isPitcher: player.isPitcher,
        statKey: raw.statKey,
        statLabel: statLabelOf(raw.statKey),
        line: raw.line,
        bookableSide: bookable,
        modelDirection,
        projection,
        gamePk: raw.gamePk ?? null,
        venueName: null,                  // populated in a future slice
      });
    } catch (err) {
      unresolved.push({
        raw,
        reason: (err as Error).message ?? 'Unknown error',
      });
    }
  }

  return { lines, unresolved };
}

// Pick the direction with the higher model probability. We run a
// quick OVER projection and decide based on which side > 50%.
async function pickBetterDirection(
  raw: RawMlbLine,
  _isPitcher: boolean,
): Promise<'OVER' | 'UNDER'> {
  const overProj = await projectMlbStat({
    playerId: raw.playerId,
    statKey: raw.statKey,
    line: raw.line,
    direction: 'OVER',
    opponentTeamId: raw.opponentTeamId,
    isHome: raw.isHome,
    gamePk: raw.gamePk,
    opposingPitcherId: raw.opposingPitcherId,
  });
  return overProj.probability >= 50 ? 'OVER' : 'UNDER';
}

// ---------- Helpers ----------

type PlayerRow = {
  id: number;
  fullName: string;
  position: string | null;
  isPitcher: boolean;
  teamId: number | null;
  teamAbbr: string | null;
};

async function loadPlayer(playerId: number): Promise<PlayerRow | null> {
  const { rows } = await getPool().query<{
    id: number;
    full_name: string;
    position: string | null;
    is_pitcher: boolean;
    team_id: number | null;
    team_abbr: string | null;
  }>(
    `SELECT p.id, p.full_name, p.position, p.is_pitcher,
            p.team_id, t.abbreviation AS team_abbr
       FROM mlb_players p
       LEFT JOIN mlb_teams t ON t.id = p.team_id
      WHERE p.id = $1`,
    [playerId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    fullName: r.full_name,
    position: r.position,
    isPitcher: r.is_pitcher,
    teamId: r.team_id,
    teamAbbr: r.team_abbr,
  };
}

function statLabelOf(key: MlbStatKey): string {
  return statMeta(key)?.label ?? key;
}
