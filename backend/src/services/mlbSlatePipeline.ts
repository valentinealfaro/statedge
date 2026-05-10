// MLB slate pipeline. Takes raw MLB prop lines (player + stat + line +
// direction + optional game context), runs each through the
// projection engine, and returns enriched lines ready for the slate
// builder. The boundary between "ingestion" and "construction" stays
// clean here — pipeline knows about projections, builder knows about
// cards.
//
// Ingestion sources funneling lines into this pipeline:
//   - PrizePicks browser-IP pull (Phase 103g — Vercel datacenter IPs
//     hit Cloudflare 403, so admin's residential IP fetches and
//     POSTs back via /api/market/prizepicks/fallback-ingest).
//   - Admin JSON paste (legacy v1 path; still wired).
//   - PrizePicks raw text paste (mlbSlateTextParser).
// The engine works the same regardless of source. OCR / Gemini are
// NBA-specific and not ported here.

import {
  projectMlbStat,
  type ProjectionResult,
} from './mlbProjectionEngine.js';
import { computeMlbLast10 } from './mlbLast10Engine.js';
import { statMeta, type MlbStatKey } from '../mlb/stats.js';
import { getPool, isDbConfigured } from '../db.js';
import { devigPair, devigSingleSide, trueProbForSide } from '../market/devig.js';

// ---------- Market-implied prob lookup ----------
//
// Iter 3 of the formula loop wired raw bookmaker implied probability
// into the projection engine via market_snapshots. Iter 8 closes the
// vig hole that left in place: raw implied probabilities are juice-
// inclusive (e.g. -110/-110 → 52.4%/52.4%, sum 104.8%), so comparing
// our model output to raw implied was comparing against a "charged"
// number rather than the book's actual belief. With proper de-vigging,
// -110/-110 → 50%/50% and our edge math reads against the true market
// read, not the vig.
//
// Strategy:
//   - For each (player, stat, line), fetch the freshest snapshot per
//     (bookmaker, direction) over the last 7 days. Exclude DFS books
//     (PrizePicks/Underdog price flex-payout, not a market read).
//   - Group by bookmaker. When a book has BOTH over and under captured
//     within 6 hours of each other, de-vig the pair multiplicatively
//     (true_p = raw_p / (raw_p_over + raw_p_under)) and return the
//     book's true belief for the requested side.
//   - Prefer the most-recent paired bookmaker. Falls back to single-
//     side approximation (subtract half the typical 4.5% vig) only
//     when no paired bookmaker exists.
//   - Returns null when no usable snapshot at all — engine falls back
//     to 50% baseline (same as iter-1's null path), so missing market
//     data stays honest, not pretend-50.

// DFS books — their published probability is a flex-payout artifact,
// not a real bookmaker line. Exclude from the market-implied lookup.
const DFS_BOOKMAKERS = new Set(['prizepicks', 'underdog']);

// Time window for considering an over/under pair "the same snapshot".
// Books refresh on different cadences; 6h is wide enough to capture
// the typical between-side gap and tight enough that we don't pair an
// over from yesterday with an under from this morning.
const PAIR_WINDOW_MS = 6 * 60 * 60 * 1000;

async function fetchLatestMlbMarketImpliedProb(args: {
  playerId: number;
  statKey: MlbStatKey;
  line: number;
  direction: 'OVER' | 'UNDER';
}): Promise<number | null> {
  if (!isDbConfigured()) return null;
  try {
    const pool = getPool();
    // Pull the freshest snapshot per (bookmaker, direction) over the
    // last 7 days. ROW_NUMBER lets us pick the latest of each side
    // per bookmaker without N+1 queries.
    const result = await pool.query<{
      bookmaker: string | null;
      direction: string;
      implied: string | null;
      captured_at: Date;
    }>(
      `WITH latest AS (
         SELECT bookmaker, direction, implied_probability, captured_at,
                ROW_NUMBER() OVER (
                  PARTITION BY bookmaker, direction
                  ORDER BY captured_at DESC
                ) AS rn
           FROM market_snapshots
          WHERE sport = 'mlb'
            AND internal_player_id = $1::text
            AND stat_key = $2
            AND ABS(line_value - $3::numeric) < 0.01
            AND COALESCE(bookmaker, '') NOT IN ('prizepicks', 'underdog')
            AND implied_probability IS NOT NULL
            AND captured_at >= (NOW() - INTERVAL '7 days')
       )
       SELECT bookmaker, direction, implied_probability::text AS implied, captured_at
         FROM latest
        WHERE rn = 1`,
      [String(args.playerId), args.statKey, args.line],
    );
    const rows = result.rows;
    if (rows.length === 0) return null;

    type Sided = { rawPct: number; capturedAt: number };
    const byBook = new Map<string, { over?: Sided; under?: Sided; both?: Sided }>();
    for (const r of rows) {
      if (!r.implied) continue;
      const raw = Number(r.implied);
      if (!Number.isFinite(raw) || raw <= 0) continue;
      const pct = raw <= 1 ? raw * 100 : raw;
      const dir = (r.direction ?? '').toLowerCase();
      const book = (r.bookmaker ?? '').toLowerCase() || 'unknown';
      const slot = byBook.get(book) ?? {};
      const sided: Sided = {
        rawPct: Math.max(1, Math.min(99, pct)),
        capturedAt: r.captured_at.getTime(),
      };
      if (dir === 'over') slot.over = sided;
      else if (dir === 'under') slot.under = sided;
      else if (dir === 'both') slot.both = sided;
      byBook.set(book, slot);
    }

    // Prefer paired books, sorted by freshest pair-time. The pair
    // freshness = max(over.capturedAt, under.capturedAt) so a book
    // with one fresh side and one stale side ranks below a book with
    // two equally-fresh sides.
    type PairedBook = {
      book: string;
      over: Sided;
      under: Sided;
      pairFreshness: number;
      pairGapMs: number;
    };
    const paired: PairedBook[] = [];
    for (const [book, slot] of byBook.entries()) {
      if (!slot.over || !slot.under) continue;
      const gap = Math.abs(slot.over.capturedAt - slot.under.capturedAt);
      if (gap > PAIR_WINDOW_MS) continue;
      paired.push({
        book,
        over: slot.over,
        under: slot.under,
        pairFreshness: Math.max(slot.over.capturedAt, slot.under.capturedAt),
        pairGapMs: gap,
      });
    }
    paired.sort((a, b) => b.pairFreshness - a.pairFreshness);

    if (paired.length > 0) {
      const best = paired[0];
      const result = devigPair(best.over.rawPct, best.under.rawPct);
      return trueProbForSide(result, args.direction);
    }

    // No paired book within the window — fall back to single-side
    // approximation. Pick the freshest snapshot of the requested side
    // (or 'both', which we treat as side-agnostic).
    const candidates: Sided[] = [];
    for (const slot of byBook.values()) {
      if (args.direction === 'OVER' && slot.over) candidates.push(slot.over);
      if (args.direction === 'UNDER' && slot.under) candidates.push(slot.under);
      if (slot.both) candidates.push(slot.both);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.capturedAt - a.capturedAt);
    return devigSingleSide(candidates[0].rawPct);
  } catch {
    return null;     // DB blip → silent fallback, consistent with iter-1
  }
}

void DFS_BOOKMAKERS;       // referenced via inline NOT IN clause above; kept for grep-able doc

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
  // Long-term anchor surfaced from the projection engine. Drives the
  // L10-vs-season component of momentumExpansionScore.
  seasonAverage: number | null;
  seasonGames: number;
  // L2 composite: 0..100, direction-aware. Blends production lift
  // (L5/L10), season lift (L10/season), projection separation, and
  // L10 hit rate. Per the 2026-05-08 Wild Card philosophy memo, this
  // is the primary tiebreaker for Aggressive + Wild Card ranking.
  // 50 = neutral, ≥65 = real momentum, ≤35 = anti-momentum.
  momentumExpansionScore: number;
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

// Resolve a list of raw lines into projected legs. Runs in PARALLEL
// batches because real MLB slates can hit 3000+ legs (PrizePicks's
// full board — every stat type × Demon/Goblin variant per player).
// Sequential mode timed out the serverless function past ~250 legs.
//
// Batch size 30 = ~30 concurrent DB queries. Neon handles this
// comfortably at the connection-pool level. With ~250ms per leg
// sequentially, 3000 legs at concurrency=30 = ~25 seconds wall time
// instead of 12 minutes. Still well under Vercel Pro's 60-300s
// function timeout.
//
// Order is preserved: each batch processes in input order, and
// unresolved lines are concatenated in the order they failed.
const RESOLVE_BATCH_SIZE = 30;

export async function resolveMlbSlate(
  raws: RawMlbLine[],
): Promise<MlbSlateResolveResult> {
  const lines: ResolvedMlbLine[] = [];
  const unresolved: UnresolvedMlbLine[] = [];

  for (let i = 0; i < raws.length; i += RESOLVE_BATCH_SIZE) {
    const chunk = raws.slice(i, i + RESOLVE_BATCH_SIZE);
    const settled = await Promise.allSettled(
      chunk.map((raw) => resolveOneLine(raw)),
    );
    for (let j = 0; j < settled.length; j += 1) {
      const r = settled[j]!;
      const raw = chunk[j]!;
      if (r.status === 'fulfilled') {
        if (r.value.kind === 'resolved') lines.push(r.value.line);
        else unresolved.push({ raw, reason: r.value.reason });
      } else {
        unresolved.push({
          raw,
          reason: (r.reason as Error)?.message ?? 'Unknown error',
        });
      }
    }
  }

  return { lines, unresolved };
}

// Per-line resolution extracted from the original sequential loop so
// we can map+await many at once. Returns a discriminated union so
// the batch caller can route to lines or unresolved without throwing.
async function resolveOneLine(
  raw: RawMlbLine,
): Promise<
  | { kind: 'resolved'; line: ResolvedMlbLine }
  | { kind: 'unresolved'; reason: string }
> {
  try {
    const player = await loadPlayer(raw.playerId);
    if (!player) {
      return { kind: 'unresolved', reason: `Player ${raw.playerId} not found in mlb_players.` };
    }
    // Determine model direction. If the line is Demon-restricted
    // ('over' bookable side), we MUST pick OVER. Goblin → UNDER.
    // Standard ('both') → let the projection lean decide.
    const bookable = raw.direction ?? 'both';
    const modelDirection: 'OVER' | 'UNDER' =
      bookable === 'over' ? 'OVER'
      : bookable === 'under' ? 'UNDER'
      : await pickBetterDirection(raw, player.isPitcher);

    // Look up the latest real-bookmaker implied probability for this
    // exact prop. Best-effort: when no snapshot exists or the DB is
    // unreachable, falls through to null and the engine uses the v0
    // 50% baseline (same as before iter 1).
    const marketImpliedProb = await fetchLatestMlbMarketImpliedProb({
      playerId: raw.playerId,
      statKey: raw.statKey,
      line: raw.line,
      direction: modelDirection,
    });

    const projection = await projectMlbStat({
      playerId: raw.playerId,
      statKey: raw.statKey,
      line: raw.line,
      direction: modelDirection,
      opponentTeamId: raw.opponentTeamId,
      isHome: raw.isHome,
      gamePk: raw.gamePk,
      opposingPitcherId: raw.opposingPitcherId,
      marketImpliedProb: marketImpliedProb ?? undefined,
    });

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
      seasonAverage: projection.seasonAverage ?? seasonAndOpp.seasonAverage,
      seasonGames: projection.seasonGames,
      opponentAverage: seasonAndOpp.opponentAverage,
      opponentGames: seasonAndOpp.opponentGames,
      lineupSpot: null,
      parkMultiplier,
      venueName: null,
      momentumExpansionScore: projection.momentumExpansionScore,
    });

    const gameKey =
      raw.gamePk !== undefined
        ? `gpk:${raw.gamePk}`
        : (player.teamId !== null && raw.opponentTeamId !== undefined
            ? [player.teamId, raw.opponentTeamId].sort((a, b) => a - b).join('-')
            : null);

    return {
      kind: 'resolved',
      line: {
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
        venueName: null,
      },
    };
  } catch (err) {
    return { kind: 'unresolved', reason: (err as Error).message ?? 'Unknown error' };
  }
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
  seasonGames: number;
  opponentAverage: number | null;
  opponentGames: number;
  lineupSpot: number | null;
  parkMultiplier: number;
  venueName: string | null;
  momentumExpansionScore: number;
}): WildCardSignals {
  const l10 = args.last10;
  // L5 vs season delta is meaningful only when both are populated.
  // Use the projection engine's seasonAverage when available; fall
  // back to the L10 mean as a coarse season proxy.
  const seasonRef = args.seasonAverage ?? l10?.last10Average ?? null;
  const l5 = l10?.last5Average ?? null;
  const l10Avg = l10?.last10Average ?? 0;
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
    last10Average: l10Avg,
    l5VsSeasonDelta,
    opponentAverage: args.opponentAverage,
    opponentGames: args.opponentGames,
    opponentVsSeasonDelta,
    seasonAverage: args.seasonAverage,
    seasonGames: args.seasonGames,
    momentumExpansionScore: args.momentumExpansionScore,
    lineupSpot: args.lineupSpot,
    parkMultiplier: args.parkMultiplier,
    venueName: args.venueName,
  };
}
