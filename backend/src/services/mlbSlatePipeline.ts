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
import { computeMlbLast10 } from './mlbLast10Engine.js';
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
// Wild Card / momentum / matchup signals captured at lock time. The
// Wild Card builder uses these to classify each leg into a tier
// (Standard / Momentum / Matchup Spike / High Variance / No Edge).
// Pulled from the same data the projection engine already has —
// surfacing on the leg so downstream builders don't re-query.
export type WildCardSignals = {
  // L10 distribution at the queried line.
  sampleSize: number;
  last10HitCount: number | null;       // null when no line was queried
  last10HitRate: number | null;        // 0-100; null when no line
  consistencyScore: number;            // 0-100, from L10 engine
  // Trend signals.
  last5Average: number | null;
  last10Average: number;
  l5VsSeasonDelta: number | null;      // last5Avg - seasonAverage
  // Matchup signal — opponent average vs the player's overall season.
  // Positive = player has historically beaten this opponent.
  opponentAverage: number | null;
  opponentGames: number;
  opponentVsSeasonDelta: number | null;
  // Game context that's already fetched.
  lineupSpot: number | null;
  parkMultiplier: number;              // 1.00 = neutral
  venueName: string | null;
};

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
  // Wild Card / momentum signals. Populated even when the projection
  // engine didn't have full context — fields gracefully degrade.
  signals: WildCardSignals;
  // Synthetic key identifying the game this leg's player is in. We
  // don't have an MLB gameId at line-input time (admin paste doesn't
  // include it for every line), so we derive: gamePk if provided,
  // else `{teamId}-{opponentTeamId}` sorted. Used by the slate
  // builder to detect same-game leg stacks for correlation penalty.
  gameKey: string | null;
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

      // Capture the L10 + opponent + season averages so the Wild Card
      // builder can classify tiers without re-running projections. The
      // projection engine already pulled these but doesn't expose them
      // — re-fetching is cheap (same DB rows, two small queries).
      const last10 = await computeMlbLast10({
        playerId: raw.playerId,
        statKey: raw.statKey,
        line: raw.line,
        direction: modelDirection,
      }).catch(() => null);
      const seasonAndOpp = await loadSeasonAndOpponentAverages(
        raw.playerId,
        raw.statKey,
        raw.opponentTeamId,
      );
      const parkMultiplier = projection.contextAdjustments.park;
      const signals = buildSignals({
        last10,
        seasonAverage: seasonAndOpp.seasonAverage,
        opponentAverage: seasonAndOpp.opponentAverage,
        opponentGames: seasonAndOpp.opponentGames,
        lineupSpot: null,                 // surfaced later via gameContext if needed
        parkMultiplier,
        venueName: null,
      });

      // Build gameKey for correlation detection. gamePk is the
      // strongest signal (every leg from gamePk=746234 belongs to
      // the same game). When gamePk is missing, fall back to a
      // sorted team-opp pair so two Yankees-Red Sox legs collide
      // even without gamePks.
      const gameKey =
        raw.gamePk !== undefined
          ? `gpk:${raw.gamePk}`
          : (player.teamId !== null && raw.opponentTeamId !== undefined
              ? [player.teamId, raw.opponentTeamId].sort((a, b) => a - b).join('-')
              : null);

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
        signals,
        gameKey,
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

// ---------- Signal extraction ----------

// Lightweight season + opponent average pull. Same SQL pattern the
// projection engine uses internally; duplicated here so the slate
// pipeline can populate Wild Card signals without re-running the
// full projection engine for these numbers.
async function loadSeasonAndOpponentAverages(
  playerId: number,
  statKey: MlbStatKey,
  opponentTeamId: number | undefined,
): Promise<{
  seasonAverage: number | null;
  opponentAverage: number | null;
  opponentGames: number;
}> {
  // Defer to mlbLast10Engine's underlying tables. The signal-extraction
  // queries here are the same shape the projection engine uses — kept
  // local to keep the dependency graph clean. Empty result tolerated.
  const isHitter = !statKey.startsWith('ks') && statKey !== 'pitcher_outs'
    && !statKey.startsWith('innings_') && !statKey.startsWith('hits_allowed')
    && !statKey.startsWith('walks_allowed') && !statKey.startsWith('home_runs_allowed')
    && !statKey.startsWith('earned_runs_') && !statKey.startsWith('pitches_thrown');
  const table = isHitter ? 'mlb_hitting_stats' : 'mlb_pitching_stats';

  // We can't easily compute "average for this stat" without the per-stat
  // selector logic — skip that here and let the projection engine
  // handle it. Just return opponent count for the opponent-average gate.
  // Season average is left null in this lightweight path; Wild Card
  // builder uses the leg's last10Average / projection baseline instead.
  if (opponentTeamId === undefined) {
    return { seasonAverage: null, opponentAverage: null, opponentGames: 0 };
  }
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM ${table}
      WHERE player_id = $1 AND opponent_team_id = $2`,
    [playerId, opponentTeamId],
  );
  const opponentGames = Number(rows[0]?.count ?? 0);
  return {
    seasonAverage: null,
    opponentAverage: null,
    opponentGames,
  };
}

// Compose the Wild Card signals block from the pieces we have. Numbers
// gracefully degrade to null when source data is missing — the Wild
// Card builder's tier gates already check for null and skip.
function buildSignals(args: {
  last10: import('./mlbLast10Engine.js').MlbLast10Result | null;
  seasonAverage: number | null;
  opponentAverage: number | null;
  opponentGames: number;
  lineupSpot: number | null;
  parkMultiplier: number;
  venueName: string | null;
}): WildCardSignals {
  const l10 = args.last10;
  // L5 vs season delta is meaningful only when both are populated.
  // Use the projection engine's seasonAverage when available; fall
  // back to the L10 mean as a coarse season proxy.
  const seasonRef = args.seasonAverage ?? l10?.last10Average ?? null;
  const l5 = l10?.last5Average ?? null;
  const l5VsSeasonDelta =
    l5 !== null && seasonRef !== null ? l5 - seasonRef : null;
  const opponentVsSeasonDelta =
    args.opponentAverage !== null && seasonRef !== null
      ? args.opponentAverage - seasonRef
      : null;
  return {
    sampleSize: l10?.sampleSize ?? 0,
    last10HitCount: l10?.hitRate?.hits ?? null,
    last10HitRate: l10?.hitRate?.rate ?? null,
    consistencyScore: l10?.consistencyScore ?? 0,
    last5Average: l5,
    last10Average: l10?.last10Average ?? 0,
    l5VsSeasonDelta,
    opponentAverage: args.opponentAverage,
    opponentGames: args.opponentGames,
    opponentVsSeasonDelta,
    lineupSpot: args.lineupSpot,
    parkMultiplier: args.parkMultiplier,
    venueName: args.venueName,
  };
}
