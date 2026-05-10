// ---------- NBA market-implied prob (de-vigged) bulk lookup ----------
//
// Mirror of mlbSlatePipeline iter 8: fetch real bookmaker prices,
// de-vig (paired-side multiplicative normalization, single-side
// fallback) so the projection engine compares its predicted prob
// against the book's TRUE belief — not the vig-inclusive raw implied.
// Bulk-shaped (one query for the whole slate's tuples) to avoid N+1
// per-leg DB hits.

const PAIR_WINDOW_MS = 6 * 60 * 60 * 1000;
const NBA_DFS_BOOKMAKERS = new Set(['prizepicks', 'underdog']);

type NbaMarketKey = string;       // `${playerId}|${statKey}|${line}`

function nbaMarketKey(playerId: number, statKey: Last10StatId, line: number): NbaMarketKey {
  return `${playerId}|${statKey}|${line}`;
}

async function fetchNbaMarketImpliedProbsBulk(
  legs: Array<{ playerId: number; statKey: Last10StatId; line: number }>,
): Promise<Map<NbaMarketKey, number>> {
  const out = new Map<NbaMarketKey, number>();
  if (legs.length === 0 || !isDbConfigured()) return out;
  try {
    const pool = getPool();
    // Build distinct (player, stat, line) tuples to query.
    const seen = new Set<string>();
    const playerIds: string[] = [];
    const statKeys: string[] = [];
    const lines: number[] = [];
    for (const l of legs) {
      const k = nbaMarketKey(l.playerId, l.statKey, l.line);
      if (seen.has(k)) continue;
      seen.add(k);
      playerIds.push(String(l.playerId));
      statKeys.push(l.statKey);
      lines.push(l.line);
    }
    if (playerIds.length === 0) return out;
    // Pull freshest snapshot per (playerId, statKey, line, bookmaker,
    // direction) over the last 7 days. Postgres unnest() lets us pass
    // three parallel arrays as a single set of tuples.
    const result = await pool.query<{
      internal_player_id: string;
      stat_key: string;
      line_value: string;
      bookmaker: string | null;
      direction: string;
      implied: string | null;
      captured_at: Date;
    }>(
      `WITH wanted AS (
         SELECT *
           FROM unnest($1::text[], $2::text[], $3::numeric[])
                AS t(internal_player_id, stat_key, line_value)
       ),
       latest AS (
         SELECT s.internal_player_id, s.stat_key, s.line_value,
                s.bookmaker, s.direction, s.implied_probability, s.captured_at,
                ROW_NUMBER() OVER (
                  PARTITION BY s.internal_player_id, s.stat_key, s.line_value, s.bookmaker, s.direction
                  ORDER BY s.captured_at DESC
                ) AS rn
           FROM market_snapshots s
           JOIN wanted w
             ON w.internal_player_id = s.internal_player_id
            AND w.stat_key = s.stat_key
            AND ABS(w.line_value - s.line_value) < 0.01
          WHERE s.sport = 'nba'
            AND COALESCE(s.bookmaker, '') NOT IN ('prizepicks', 'underdog')
            AND s.implied_probability IS NOT NULL
            AND s.captured_at >= (NOW() - INTERVAL '7 days')
       )
       SELECT internal_player_id, stat_key, line_value::text AS line_value,
              bookmaker, direction,
              implied_probability::text AS implied,
              captured_at
         FROM latest
        WHERE rn = 1`,
      [playerIds, statKeys, lines],
    );

    type Sided = { rawPct: number; capturedAt: number };
    type BookSlot = { over?: Sided; under?: Sided; both?: Sided };
    const byKey = new Map<NbaMarketKey, Map<string, BookSlot>>();
    for (const r of result.rows) {
      if (!r.implied) continue;
      const raw = Number(r.implied);
      if (!Number.isFinite(raw) || raw <= 0) continue;
      const pct = raw <= 1 ? raw * 100 : raw;
      const dir = (r.direction ?? '').toLowerCase();
      const key = `${r.internal_player_id}|${r.stat_key}|${Number(r.line_value)}`;
      const book = (r.bookmaker ?? '').toLowerCase() || 'unknown';
      const inner = byKey.get(key) ?? new Map<string, BookSlot>();
      const slot = inner.get(book) ?? {};
      const sided: Sided = {
        rawPct: Math.max(1, Math.min(99, pct)),
        capturedAt: r.captured_at.getTime(),
      };
      if (dir === 'over') slot.over = sided;
      else if (dir === 'under') slot.under = sided;
      else if (dir === 'both') slot.both = sided;
      inner.set(book, slot);
      byKey.set(key, inner);
    }

    for (const [key, books] of byKey.entries()) {
      // Prefer the freshest paired book.
      type Paired = { over: Sided; under: Sided; freshness: number };
      const paired: Paired[] = [];
      for (const slot of books.values()) {
        if (!slot.over || !slot.under) continue;
        const gap = Math.abs(slot.over.capturedAt - slot.under.capturedAt);
        if (gap > PAIR_WINDOW_MS) continue;
        paired.push({
          over: slot.over,
          under: slot.under,
          freshness: Math.max(slot.over.capturedAt, slot.under.capturedAt),
        });
      }
      paired.sort((a, b) => b.freshness - a.freshness);
      if (paired.length > 0) {
        const r = devigPair(paired[0].over.rawPct, paired[0].under.rawPct);
        out.set(key, trueProbForSide(r, 'OVER'));
        continue;
      }
      // Single-side fallback — pick the freshest OVER (or 'both').
      const candidates: Sided[] = [];
      for (const slot of books.values()) {
        if (slot.over) candidates.push(slot.over);
        if (slot.both) candidates.push(slot.both);
      }
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => b.capturedAt - a.capturedAt);
      out.set(key, devigSingleSide(candidates[0].rawPct));
    }
    return out;
  } catch {
    return out;     // DB blip → empty map; engine falls back to 50% baseline
  }
}

void NBA_DFS_BOOKMAKERS;       // doc-only — referenced via inline NOT IN

// End-to-end "raw line → resolved card" pipeline for NBA. Three
// ingestion paths funnel through here so the front-end always gets
// the same response shape:
//   - Auto-fetch (services/slatePrizePicks fetchPrizePicksNba)
//   - JSON paste (POST /api/slate/parse — admin)
//   - OCR image upload (POST /api/slate/parse-image → slateOcr.ocrPropBoard)
// Each ingestion source yields RawLine[]; resolveSlate normalizes
// names, runs the projection engine, builds combos, returns the
// SlateResponse the frontend renders.

import {
  getPlayerGameLogsBulkFromDb,
  getPool,
  isDbConfigured,
  listAllPlayerCandidatesFromDb,
} from '../db.js';
import { currentSeason, type PlayerGame } from '../nba/client.js';
import { computeHitProbability, type HitProbability } from './comparisonEngine.js';
import { isDoubleDoubleGame, STAT_MAP, type Last10StatId } from './last10.js';
import {
  isProjectable,
  project,
  type InjuryStatus,
  type ProjectionResult,
} from './projectionEngine.js';
import { getNbaCalibrationFeedbackCached } from './nbaCalibrationFeedback.js';
import type { CalibrationReport } from './slateCalibration.js';
import { devigPair, devigSingleSide, trueProbForSide } from '../market/devig.js';
import { classifyArchetype, type ArchetypeReport } from './playerArchetype.js';
import { buildCombos, type Combo } from './slateCombos.js';
import { getTodayInjuriesMap, type InjuryEntry } from './slateInjuries.js';
import { normalizeStatLabel, statLabelFor } from './slateNormalize.js';
import {
  resolvePlayerName,
  type PlayerCandidate,
} from './slateResolve.js';

export type RawLine = {
  // From PP API or OCR'd text:
  playerName: string;
  team?: string;
  position?: string;
  imageUrl?: string | null;
  statLabel: string;
  line: number;
  ppId?: string;
  startTime?: string | null;
  description?: string | null;
  opponentAbbr?: string | null;   // resolved from `description` if present
  // PrizePicks side restriction. 'over' = Demon (over-only),
  // 'under' = Goblin (under-only), 'both' or unset = standard prop.
  direction?: 'over' | 'under' | 'both';
};

export type ResolvedLine = {
  ppId?: string;
  playerId: number;
  playerName: string;          // canonical name from DB
  ppPlayerName: string;        // name as it appeared in source (for display)
  team: string | null;
  position: string | null;
  imageUrl: string | null;
  statKey: Last10StatId;
  statLabel: string;
  line: number;
  startTime?: string | null;
  description?: string | null;

  gamesAnalyzed: number;
  last10Avg: number;
  last10Values: number[];

  // Numeric stats only — populated for everything except double_double:
  hitProbability?: HitProbability;
  // Double-double rate (0-1) only when statKey === 'double_double':
  ddRate?: number;

  // ESPN-sourced injury status for tonight's slate, if applicable.
  // Common values: 'Out', 'Day-To-Day', 'Questionable', 'Probable'.
  injury?: InjuryEntry;

  // Player's historical performance against tonight's specific opponent
  // (current season only, all games we have cached). Sample size is
  // typically 1-4 games — small but informative for picking sharp lines.
  vsOpponent?: {
    opponentAbbr: string;
    gamesPlayed: number;
    avg: number;       // for double_double stat, this is the rate (0-1)
    // Per-game values vs the opponent. For DD, each entry is 0/1.
    // Used by the Wild Card builder to compute "hit N of last X vs
    // opponent" — the spec requires ≥1 historical hit vs the current
    // opponent for a pick to qualify as Wild Card.
    values: number[];
  };

  // Last-5 average and the delta vs the last-10 baseline. Positive →
  // player is heating up coming into tonight; negative → cold.
  // Threshold for showing an arrow on the UI is intentionally a bit
  // wide (>= 10% of L10 avg) so noise doesn't trigger directional
  // chips on flat performers.
  trend?: {
    last5Avg: number;
    deltaVsL10: number;     // last5 - last10
  };

  // PrizePicks side restriction passed through from the source slate
  // ('over' = Demon / over-only, 'under' = Goblin / under-only,
  // 'both' = standard). Drives the UI's "OVER ONLY" / "UNDER ONLY"
  // badge and blocks the parlay rail from suggesting a side that
  // isn't actually available to bet.
  direction?: 'over' | 'under' | 'both';

  // Layered projection-engine output. Populated for numeric stats only
  // (skipped for double_double, which is a binary not a continuous
  // distribution). Contains the full factor breakdown, confidence,
  // risk, edge, and human-readable model notes the UI surfaces in the
  // "Projection details" panel.
  projection?: ProjectionResult;

  // Volatility archetype derived from the player's recent game log
  // (Stable Producer / Boom-Bust / Minutes Sensitive / etc). Surfaced
  // as a chip on the card so the user can read the variance profile
  // alongside the projection.
  archetype?: ArchetypeReport;
};

export type UnresolvedLine = {
  rawText: string;
  rawStatLabel: string;
  line: number;
  reason: 'no_player_match' | 'unknown_stat' | 'no_recent_games';
};

export type SlateResponse = {
  lines: ResolvedLine[];
  unresolved: UnresolvedLine[];
  source: 'prizepicks_auto' | 'image_upload' | 'manual';
  fetchedAt: string;
  // Pre-built parlays (Best 2-6 + Wild Card) computed server-side so
  // every visitor sees the same picks and the snapshot writer/reader
  // share one source of truth. Empty when the slate doesn't have
  // enough eligible candidates (spec §"Limited slate" warning).
  combos: Combo[];
  // Slate strategy mode reflected in `combos`. Only set on responses
  // from /slate/today (the route that honors ?mode=). 'mode' is what
  // the user requested (may be 'auto'); 'resolvedMode' is the
  // underlying mode actually used to construct the cards. They differ
  // only when the user picked Auto.
  mode?: 'safe' | 'balanced' | 'aggressive' | 'insane' | 'auto';
  resolvedMode?: 'safe' | 'balanced' | 'aggressive' | 'insane';
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Normalize the ESPN-sourced injury status string to the projection
// engine's InjuryStatus. We treat "Doubtful" as "Out" for projection
// purposes — players listed Doubtful rarely play meaningful minutes.
function mapInjuryStatus(s: string | undefined): InjuryStatus {
  if (!s) return null;
  const norm = s.trim();
  if (norm === 'Out' || norm === 'Doubtful') return 'Out';
  if (norm === 'Questionable') return 'Questionable';
  if (norm === 'Day-To-Day') return 'Day-To-Day';
  if (norm === 'Probable') return 'Probable';
  return null;
}

/**
 * Resolve a batch of raw lines into ResolvedLine + UnresolvedLine arrays.
 * One DB round-trip for the player table, one for the bulk game logs.
 *
 * `asOfDate` (YYYY-MM-DD) filters each player's games to those strictly
 * before that date. Used by the history backfill so resolving a past
 * slate doesn't leak the very game we're about to grade against —
 * without it, the L10 average for "yesterday's slate" would include
 * yesterday's game and the projection becomes circular.
 */
export async function resolveSlate(
  raw: RawLine[],
  source: SlateResponse['source'],
  asOfDate?: string,
): Promise<SlateResponse> {
  const candidates: PlayerCandidate[] = await listAllPlayerCandidatesFromDb();

  // Pass 1: resolve player + stat. Group by playerId so we can do a
  // single bulk query for game logs.
  type Pending = {
    raw: RawLine;
    playerId: number;
    canonicalName: string;
    statKey: Last10StatId;
  };
  const pending: Pending[] = [];
  const unresolved: UnresolvedLine[] = [];

  for (const r of raw) {
    const statKey = normalizeStatLabel(r.statLabel);
    if (!statKey) {
      unresolved.push({
        rawText: r.playerName,
        rawStatLabel: r.statLabel,
        line: r.line,
        reason: 'unknown_stat',
      });
      continue;
    }
    const match = resolvePlayerName(r.playerName, candidates);
    if (!match.ok) {
      unresolved.push({
        rawText: r.playerName,
        rawStatLabel: r.statLabel,
        line: r.line,
        reason: 'no_player_match',
      });
      continue;
    }
    pending.push({
      raw: r,
      playerId: match.playerId,
      canonicalName: match.fullName,
      statKey,
    });
  }

  // Pass 2: bulk-fetch every player's last-10. We pull current season;
  // playoffs+regular were merged into the same row by sync-games.
  // Run the today-injuries lookup in parallel — it's cached and rarely
  // refetches but the first slate request of the morning will pay it.
  const uniquePlayerIds = Array.from(new Set(pending.map((p) => p.playerId)));
  const marketLegs = pending
    .filter((p) => isProjectable(p.statKey))
    .map((p) => ({ playerId: p.playerId, statKey: p.statKey, line: p.raw.line }));
  const [logs, injuries, calibrationReport, marketImpliedProbs] = await Promise.all([
    getPlayerGameLogsBulkFromDb(uniquePlayerIds, currentSeason()),
    getTodayInjuriesMap(),
    // L9 → L6 calibration feedback. Pre-fetch the report once for the
    // whole slate (cached 5 min) and pass it into every project() call
    // so per-bucket / per-stat overclaim corrections actually move the
    // model's probability output. NBA had been computing the same
    // calibration report for the History page without ever feeding it
    // back into projection-time decisions. Soft-fail to null if the
    // DB query throws — the engine treats null as "no feedback layer"
    // and degrades to its pre-feedback behavior.
    getNbaCalibrationFeedbackCached().catch((): CalibrationReport | null => null),
    // De-vigged sportsbook implied prob per (player, stat, line). Bulk
    // query over the slate's tuples → one round-trip instead of N+1.
    // Engine treats absent keys as null → 50% baseline (same as the
    // pre-iter-9 behavior), so missing market data never blocks a
    // projection.
    fetchNbaMarketImpliedProbsBulk(marketLegs),
  ]);

  function injuryFor(canonicalName: string): InjuryEntry | undefined {
    const key = canonicalName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return injuries.get(key);
  }

  const resolved: ResolvedLine[] = [];
  for (const p of pending) {
    let games = logs.get(p.playerId) ?? [];
    // Backfill mode: only consider games strictly before the slate
    // date. Required so resolving a past slate doesn't see the game
    // we're about to grade. games are newest-first so this is a
    // simple filter; the slice(0, 10) below still produces the right
    // L10 window.
    if (asOfDate) {
      games = games.filter((g) => g.date < asOfDate);
    }
    if (games.length === 0) {
      unresolved.push({
        rawText: p.raw.playerName,
        rawStatLabel: p.raw.statLabel,
        line: p.raw.line,
        reason: 'no_recent_games',
      });
      continue;
    }
    const last10 = games.slice(0, 10);

    // Build vs-opponent block — uses the player's full season log,
    // not just last 10, since a player may have only 1-4 prior games
    // against a given team in a season. Skip if we don't know who the
    // opponent is.
    const oppAbbr = p.raw.opponentAbbr ?? null;
    let vsOpponent: ResolvedLine['vsOpponent'] | undefined;
    if (oppAbbr) {
      const vsGames = games.filter((g) => g.opponentAbbr === oppAbbr);
      if (vsGames.length > 0) {
        if (p.statKey === 'double_double') {
          const ddValues: number[] = vsGames.map((g) => (isDoubleDoubleGame(g) ? 1 : 0));
          const dd = ddValues.reduce((a, b) => a + b, 0);
          vsOpponent = {
            opponentAbbr: oppAbbr,
            gamesPlayed: vsGames.length,
            avg: round2(dd / vsGames.length),
            values: ddValues,
          };
        } else {
          const get = STAT_MAP[p.statKey];
          const vsValues = vsGames.map(get);
          const vsAvg = vsValues.reduce((a, b) => a + b, 0) / vsValues.length;
          vsOpponent = {
            opponentAbbr: oppAbbr,
            gamesPlayed: vsGames.length,
            avg: round2(vsAvg),
            values: vsValues,
          };
        }
      }
    }

    // Last-5 trend (regardless of stat type — for DD it's a rate over
    // 5 games rather than an avg, but the same comparison works).
    let trend: ResolvedLine['trend'] | undefined;
    if (last10.length >= 5) {
      const last5 = last10.slice(0, 5);
      let last5Avg: number;
      let last10Avg: number;
      if (p.statKey === 'double_double') {
        last5Avg = last5.filter(isDoubleDoubleGame).length / last5.length;
        last10Avg = last10.filter(isDoubleDoubleGame).length / last10.length;
      } else {
        const get = STAT_MAP[p.statKey];
        last5Avg = last5.map(get).reduce((a, b) => a + b, 0) / last5.length;
        last10Avg = last10.map(get).reduce((a, b) => a + b, 0) / last10.length;
      }
      trend = {
        last5Avg: round2(last5Avg),
        deltaVsL10: round2(last5Avg - last10Avg),
      };
    }

    // Volatility archetype — computed from the player's full season
    // log (not just L10) so we have enough data for the CV math to
    // mean something. Cheap (one pass + sort), so we run it for every
    // resolved line including DD.
    const archetype = classifyArchetype(games, p.statKey);

    if (p.statKey === 'double_double') {
      const dd = last10.filter(isDoubleDoubleGame).length;
      resolved.push({
        ppId: p.raw.ppId,
        playerId: p.playerId,
        playerName: p.canonicalName,
        ppPlayerName: p.raw.playerName,
        team: p.raw.team ?? null,
        position: p.raw.position ?? null,
        imageUrl: p.raw.imageUrl ?? null,
        statKey: p.statKey,
        statLabel: statLabelFor(p.statKey),
        line: p.raw.line,
        direction: p.raw.direction ?? 'both',
        startTime: p.raw.startTime ?? null,
        description: p.raw.description ?? null,
        gamesAnalyzed: last10.length,
        last10Avg: round2(dd / last10.length),
        last10Values: last10.map((g) => (isDoubleDoubleGame(g) ? 1 : 0)),
        ddRate: dd / last10.length,
        injury: injuryFor(p.canonicalName),
        vsOpponent,
        trend,
        archetype,
      });
      continue;
    }

    const get = STAT_MAP[p.statKey];

    // Hit-probability sample blends 'recent form' (last-10 regardless
    // of opponent) with 'matchup history' (every season game vs the
    // specific opponent we're playing tonight). Dedup by gameId so a
    // game that's both in L10 AND vs-opp counts once. When no opponent
    // is set, this collapses to plain last-10 like before.
    const last10Values = last10.map(get);
    const last10Avg = last10Values.reduce((a, b) => a + b, 0) / last10Values.length;

    let combinedSample: PlayerGame[] = last10;
    if (oppAbbr) {
      const vsOppGames = games.filter((g) => g.opponentAbbr === oppAbbr);
      if (vsOppGames.length > 0) {
        const seen = new Set<string>();
        const merged: PlayerGame[] = [];
        for (const g of [...last10, ...vsOppGames]) {
          if (seen.has(g.gameId)) continue;
          seen.add(g.gameId);
          merged.push(g);
        }
        combinedSample = merged;
      }
    }
    const sampleValues = combinedSample.map(get);
    const hit = computeHitProbability(sampleValues, p.raw.line);

    // Run the layered projection engine. We pass the full season log
    // (engine slices its own L10/L5/vs-opp/HA windows) plus what context
    // we have today: opponent abbr, ESPN injury status. Pace/defense/
    // usage stay null until upstream sync gathers them — the engine
    // gracefully redistributes weight in their absence.
    const inj = injuryFor(p.canonicalName);
    let projection: ProjectionResult | undefined;
    if (isProjectable(p.statKey)) {
      const injStatus = mapInjuryStatus(inj?.status);
      // Short-circuit: don't render a projection card for an OUT player.
      if (injStatus !== 'Out') {
        const marketImpliedProb = marketImpliedProbs.get(
          nbaMarketKey(p.playerId, p.statKey, p.raw.line),
        ) ?? null;
        projection = project({
          selectedStat: p.statKey,
          lineValue: p.raw.line,
          seasonGames: games,
          opponentAbbr: oppAbbr,
          isHome: null, // tonight's home/away unknown at slate-build time
          playerInjuryStatus: injStatus,
          calibrationReport,
          marketImpliedProb,
        });
      }
    }

    resolved.push({
      ppId: p.raw.ppId,
      playerId: p.playerId,
      playerName: p.canonicalName,
      ppPlayerName: p.raw.playerName,
      team: p.raw.team ?? null,
      position: p.raw.position ?? null,
      imageUrl: p.raw.imageUrl ?? null,
      statKey: p.statKey,
      statLabel: statLabelFor(p.statKey),
      line: p.raw.line,
      direction: p.raw.direction ?? 'both',
      startTime: p.raw.startTime ?? null,
      description: p.raw.description ?? null,
      // gamesAnalyzed reflects the COMBINED sample so receipts read
      // 'hit X/Y' over the actual blended set (L10 + extra vs-opp games).
      gamesAnalyzed: combinedSample.length,
      last10Avg: round2(last10Avg),
      last10Values: last10Values,
      hitProbability: hit,
      injury: inj,
      vsOpponent,
      trend,
      projection,
      archetype,
    });
  }

  // Sort by mightHitPct desc — strongest signals first.
  resolved.sort((a, b) => (b.hitProbability?.mightHitPct ?? 0) - (a.hitProbability?.mightHitPct ?? 0));

  // Compute pre-built parlays once, server-side, so /slate/today,
  // /slate/auto, /slate/parse, and /slate/parse-image all surface the
  // same picks the snapshot path will store. The frontend renders
  // these directly (no client-side combo math).
  const { combos } = buildCombos(resolved);

  return {
    lines: resolved,
    unresolved,
    source,
    combos,
    fetchedAt: new Date().toISOString(),
  };
}
