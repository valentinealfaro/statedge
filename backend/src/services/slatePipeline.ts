// End-to-end "raw line → resolved card" pipeline. Both the auto-fetch
// and the (planned) image-upload paths funnel through here so the
// front-end always gets the same response shape.

import {
  getPlayerGameLogsBulkFromDb,
  listAllPlayerCandidatesFromDb,
} from '../db.js';
import { currentSeason } from '../nba/client.js';
import { computeHitProbability, type HitProbability } from './comparisonEngine.js';
import { isDoubleDoubleGame, STAT_MAP, type Last10StatId } from './last10.js';
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
  source: 'prizepicks_auto' | 'image_upload';
  fetchedAt: string;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Resolve a batch of raw lines into ResolvedLine + UnresolvedLine arrays.
 * One DB round-trip for the player table, one for the bulk game logs.
 */
export async function resolveSlate(
  raw: RawLine[],
  source: SlateResponse['source'],
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
  const [logs, injuries] = await Promise.all([
    getPlayerGameLogsBulkFromDb(uniquePlayerIds, currentSeason()),
    getTodayInjuriesMap(),
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
    const games = logs.get(p.playerId) ?? [];
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
          const dd = vsGames.filter(isDoubleDoubleGame).length;
          vsOpponent = {
            opponentAbbr: oppAbbr,
            gamesPlayed: vsGames.length,
            avg: round2(dd / vsGames.length),
          };
        } else {
          const get = STAT_MAP[p.statKey];
          const vsValues = vsGames.map(get);
          const vsAvg = vsValues.reduce((a, b) => a + b, 0) / vsValues.length;
          vsOpponent = {
            opponentAbbr: oppAbbr,
            gamesPlayed: vsGames.length,
            avg: round2(vsAvg),
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
        startTime: p.raw.startTime ?? null,
        description: p.raw.description ?? null,
        gamesAnalyzed: last10.length,
        last10Avg: round2(dd / last10.length),
        last10Values: last10.map((g) => (isDoubleDoubleGame(g) ? 1 : 0)),
        ddRate: dd / last10.length,
        injury: injuryFor(p.canonicalName),
        vsOpponent,
        trend,
      });
      continue;
    }

    const get = STAT_MAP[p.statKey];
    const values = last10.map(get);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const hit = computeHitProbability(values, p.raw.line);

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
      startTime: p.raw.startTime ?? null,
      description: p.raw.description ?? null,
      gamesAnalyzed: last10.length,
      last10Avg: round2(avg),
      last10Values: values,
      hitProbability: hit,
      injury: injuryFor(p.canonicalName),
      vsOpponent,
      trend,
    });
  }

  // Sort by mightHitPct desc — strongest signals first.
  resolved.sort((a, b) => (b.hitProbability?.mightHitPct ?? 0) - (a.hitProbability?.mightHitPct ?? 0));

  return {
    lines: resolved,
    unresolved,
    source,
    fetchedAt: new Date().toISOString(),
  };
}
