// WNBA projection history — Phase 78 calibration foundation.
// Same role as MLB's mlbProjectionHistory + grader + calibration:
//   - When admin publishes the slate, every projected leg gets a row
//     in wnba_projection_history with the projection snapshot
//   - After games finish, the lazy grader pulls actual stats from
//     ESPN gamelog per player + slate-date, compares to line+direction,
//     writes result_value + hit_or_miss
//   - The calibration aggregator returns predicted-vs-observed buckets
//     by probability tier, stat, card type, risk tier
//
// Mission alignment: every projection is auditable. Calibration shows
// when the model is wrong. Long-term EV over short-term excitement.

import { getPool } from '../db.js';
import {
  classifyFailure,
  summarizeArchetypes,
  type FailureArchetype,
  type FailureArchetypeBucket,
} from '../services/failureArchetype.js';
import { fetchWnbaPlayerGameLog, type WnbaGameLogEntry } from './espn.js';
import type { ProjectedWnbaLine } from './projection.js';

export const WNBA_MODEL_VERSION = 'wnba-v0.1.0-espn-gamelog-blend';

let tablesEnsured = false;
async function ensureWnbaProjectionHistoryTable(): Promise<void> {
  if (tablesEnsured) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS wnba_projection_history (
      id                SERIAL PRIMARY KEY,
      created_at        TIMESTAMP DEFAULT NOW(),
      game_date         DATE NOT NULL,
      athlete_id        TEXT NOT NULL,
      player_name       TEXT NOT NULL,
      team              TEXT,
      stat_key          TEXT NOT NULL,
      line_value        NUMERIC NOT NULL,
      direction         TEXT NOT NULL,
      projection_value  NUMERIC,
      probability       NUMERIC,
      edge_percent      NUMERIC,
      trap_score        NUMERIC,
      fragility_score   NUMERIC,
      momentum_score    NUMERIC,
      card_type         TEXT,
      model_version     TEXT,
      result_value      NUMERIC,
      hit_or_miss       BOOLEAN,
      graded_at         TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS wnba_proj_history_date_idx ON wnba_projection_history (game_date DESC);
    CREATE INDEX IF NOT EXISTS wnba_proj_history_athlete_idx ON wnba_projection_history (athlete_id);
  `);
  // Phase 102 — Market Memory schema additions. Idempotent.
  await getPool().query(`
    ALTER TABLE wnba_projection_history ADD COLUMN IF NOT EXISTS market_implied_prob   NUMERIC;
    ALTER TABLE wnba_projection_history ADD COLUMN IF NOT EXISTS line_inflation_score  NUMERIC;
    ALTER TABLE wnba_projection_history ADD COLUMN IF NOT EXISTS public_bias_tags      TEXT[];
    ALTER TABLE wnba_projection_history ADD COLUMN IF NOT EXISTS sharpness_score       NUMERIC;
    ALTER TABLE wnba_projection_history ADD COLUMN IF NOT EXISTS edge_durability       TEXT;
    ALTER TABLE wnba_projection_history ADD COLUMN IF NOT EXISTS reason_codes          TEXT[];
    ALTER TABLE wnba_projection_history ADD COLUMN IF NOT EXISTS why_market_wrong      TEXT;
    ALTER TABLE wnba_projection_history ADD COLUMN IF NOT EXISTS failure_archetype     TEXT;
  `);
  tablesEnsured = true;
}

export type RecordableWnbaLeg = {
  line: ProjectedWnbaLine;
  cardType: string;       // 'Best 2' / 'Best 5' / 'top-edges' / etc
};

export async function recordWnbaProjections(opts: {
  legs: RecordableWnbaLeg[];
  gameDate: string;       // YYYY-MM-DD
}): Promise<{ inserted: number }> {
  await ensureWnbaProjectionHistoryTable();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.gameDate)) {
    throw new Error(`Invalid gameDate: ${opts.gameDate}`);
  }
  if (opts.legs.length === 0) return { inserted: 0 };
  const pool = getPool();
  let inserted = 0;
  for (const { line, cardType } of opts.legs) {
    await pool.query(
      `INSERT INTO wnba_projection_history (
         game_date, athlete_id, player_name, team,
         stat_key, line_value, direction,
         projection_value, probability, edge_percent,
         trap_score, fragility_score, momentum_score,
         card_type, model_version,
         market_implied_prob, line_inflation_score,
         public_bias_tags, sharpness_score, edge_durability,
         reason_codes, why_market_wrong
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, $9, $10,
         $11, $12, $13,
         $14, $15,
         $16, $17,
         $18, $19, $20,
         $21, $22
       )`,
      [
        opts.gameDate,
        line.athleteId,
        line.playerName,
        line.team,
        line.statKey,
        line.line,
        line.direction,
        line.projection,
        line.probability,
        line.edgePercent,
        line.trapScore,
        line.fragilityScore,
        line.momentumScore,
        cardType,
        WNBA_MODEL_VERSION,
        // Phase 102 — Market Memory snapshot.
        line.marketImpliedProb ?? null,
        line.lineInflationScore ?? null,
        line.publicBiasTags ?? [],
        line.sharpnessScore ?? null,
        line.edgeDurability ?? null,
        line.reasonCodes ?? [],
        line.whyMarketWrong ?? null,
      ],
    );
    inserted += 1;
  }
  return { inserted };
}

// ---------- Grader ----------

const STAT_PICKERS: Record<string, (g: WnbaGameLogEntry) => number> = {
  points:         (g) => g.points,
  rebounds:       (g) => g.rebounds,
  assists:        (g) => g.assists,
  three_pt_made:  (g) => g.threePtMade,
  steals:         (g) => g.steals,
  blocks:         (g) => g.blocks,
  turnovers:      (g) => g.turnovers,
  fg_made:        (g) => g.fgMade,
  fg_attempted:   (g) => g.fgAttempted,
  ft_made:        (g) => g.ftMade,
  ft_attempted:   (g) => g.ftAttempted,
  personal_fouls: (g) => g.fouls,
  pra:            (g) => g.points + g.rebounds + g.assists,
  pr:             (g) => g.points + g.rebounds,
  pa:             (g) => g.points + g.assists,
  ra:             (g) => g.rebounds + g.assists,
  stocks:         (g) => g.steals + g.blocks,
};

export type GradeResult = {
  scanned: number;
  graded: number;
  unmatched: number;       // gamelog had no game on slate_date
};

// Lazy grader — finds ungraded rows whose slate_date is in the past,
// fetches the player's gamelog, finds the matching game, writes
// result_value + hit_or_miss.
export async function gradeWnbaProjections(opts: { windowDays?: number } = {}): Promise<GradeResult> {
  await ensureWnbaProjectionHistoryTable();
  const windowDays = opts.windowDays ?? 30;
  const pool = getPool();
  // Pull every ungraded row whose game_date is at least 1 day in the
  // past (give ESPN time to populate gamelogs). Phase 102: also pull
  // the projection-time signals so the failure-archetype classifier
  // can run on misses.
  const { rows } = await pool.query<{
    id: number;
    game_date: Date;
    athlete_id: string;
    stat_key: string;
    line_value: string;
    direction: string;
    probability: string | null;
    edge_percent: string | null;
    projection_value: string | null;
    trap_score: string | null;
    fragility_score: string | null;
    momentum_score: string | null;
    line_inflation_score: string | null;
    public_bias_tags: string[] | null;
  }>(
    `SELECT id, game_date, athlete_id, stat_key, line_value, direction,
            probability, edge_percent, projection_value, trap_score,
            fragility_score, momentum_score, line_inflation_score,
            public_bias_tags
       FROM wnba_projection_history
      WHERE hit_or_miss IS NULL
        AND game_date >= (CURRENT_DATE - $1::int)
        AND game_date <= CURRENT_DATE
      ORDER BY game_date DESC
      LIMIT 500`,
    [windowDays],
  );

  let graded = 0;
  let unmatched = 0;

  // Cache gamelogs across the batch — same player often has many rows.
  const gamelogCache = new Map<string, WnbaGameLogEntry[]>();
  const getLog = async (athleteId: string): Promise<WnbaGameLogEntry[]> => {
    if (gamelogCache.has(athleteId)) return gamelogCache.get(athleteId)!;
    const log = await fetchWnbaPlayerGameLog(athleteId).catch(() => [] as WnbaGameLogEntry[]);
    gamelogCache.set(athleteId, log);
    return log;
  };

  for (const r of rows) {
    const dateIso = `${r.game_date.getUTCFullYear()}-${String(r.game_date.getUTCMonth() + 1).padStart(2, '0')}-${String(r.game_date.getUTCDate()).padStart(2, '0')}`;
    const log = await getLog(r.athlete_id);
    const gameOnDate = log.find((g) => g.date === dateIso);
    if (!gameOnDate) { unmatched += 1; continue; }
    const picker = STAT_PICKERS[r.stat_key];
    if (!picker) { unmatched += 1; continue; }
    const actual = picker(gameOnDate);
    const line = Number(r.line_value);
    let hit: boolean;
    if (r.direction === 'OVER')      hit = actual > line;
    else if (r.direction === 'UNDER') hit = actual < line;
    else continue;     // 'both' isn't a graded direction

    // Phase 102 — failure archetype classification on misses only.
    let failureArchetype: string | null = null;
    if (!hit) {
      failureArchetype = classifyFailure({
        probability: r.probability === null ? 50 : Number(r.probability),
        edgePercent: r.edge_percent === null ? 0 : Number(r.edge_percent),
        projection: r.projection_value === null ? 0 : Number(r.projection_value),
        line,
        direction: r.direction === 'OVER' ? 'OVER' : 'UNDER',
        trapScore: r.trap_score === null ? 0 : Number(r.trap_score),
        fragilityScore: r.fragility_score === null ? 50 : Number(r.fragility_score),
        momentumScore: r.momentum_score === null ? null : Number(r.momentum_score),
        lineInflationScore: r.line_inflation_score === null ? 0 : Number(r.line_inflation_score),
        publicBiasTags: r.public_bias_tags ?? [],
        resultValue: actual,
      });
    }

    await pool.query(
      `UPDATE wnba_projection_history
          SET result_value      = $1,
              hit_or_miss       = $2,
              graded_at         = NOW(),
              failure_archetype = $3
        WHERE id = $4`,
      [actual, hit, failureArchetype, r.id],
    );
    graded += 1;
  }

  return { scanned: rows.length, graded, unmatched };
}

// ---------- Calibration aggregator ----------

export type CalibrationBucket = {
  label: string;
  graded: number;
  hits: number;
  predictedAverage: number;       // avg projected probability
  observedHitRate: number;         // hits/graded × 100
  smoothedHitRate: number;         // Bayesian-smoothed against 50% prior with 10 pseudo-games
  sampleTier: 'thin' | 'moderate' | 'strong';
};

export type WnbaCalibrationReport = {
  windowDays: number;
  totalGraded: number;
  totalHits: number;
  totalMisses: number;
  overallHitRate: number;
  smoothedHitRate: number;
  averagePredicted: number;
  calibrationGap: number;          // observed - predicted
  byProbability: CalibrationBucket[];
  byStatType: CalibrationBucket[];
  byCardType: CalibrationBucket[];
  // Phase 102 — Loss Forensics. Distribution of failure archetypes
  // across all misses in the window.
  failureArchetypes: FailureArchetypeBucket[];
  modelVersion: string;
};

const PRIOR_PSEUDO_GAMES = 10;
const PRIOR_HIT_RATE = 0.50;

function smoothHit(hits: number, total: number): number {
  return ((hits + PRIOR_PSEUDO_GAMES * PRIOR_HIT_RATE) /
          (total + PRIOR_PSEUDO_GAMES)) * 100;
}

function tierFromN(n: number): 'thin' | 'moderate' | 'strong' {
  if (n < 10) return 'thin';
  if (n < 30) return 'moderate';
  return 'strong';
}

// ---------- History listing (Phase 93) ----------
//
// Used by /api/wnba/slate/history to render date-by-date track record.
// Returns ALL rows in window — graded + ungraded — so the UI can show
// pending counts honestly.

export type WnbaHistoryRow = {
  gameDate: string;          // YYYY-MM-DD
  athleteId: string;
  playerName: string;
  team: string | null;
  statKey: string;
  direction: 'OVER' | 'UNDER';
  cardType: string | null;
  hitOrMiss: boolean | null; // null = ungraded
};

export async function listWnbaProjections(opts: { windowDays?: number } = {}): Promise<WnbaHistoryRow[]> {
  await ensureWnbaProjectionHistoryTable();
  const windowDays = opts.windowDays ?? 30;
  const pool = getPool();
  const { rows } = await pool.query<{
    game_date: Date;
    athlete_id: string;
    player_name: string;
    team: string | null;
    stat_key: string;
    direction: string;
    card_type: string | null;
    hit_or_miss: boolean | null;
  }>(
    `SELECT game_date, athlete_id, player_name, team,
            stat_key, direction, card_type, hit_or_miss
       FROM wnba_projection_history
      WHERE game_date >= (CURRENT_DATE - $1::int)
      ORDER BY game_date DESC`,
    [windowDays],
  );
  return rows.map((r) => ({
    gameDate: `${r.game_date.getUTCFullYear()}-${String(r.game_date.getUTCMonth() + 1).padStart(2, '0')}-${String(r.game_date.getUTCDate()).padStart(2, '0')}`,
    athleteId: r.athlete_id,
    playerName: r.player_name,
    team: r.team,
    statKey: r.stat_key,
    direction: (r.direction === 'OVER' ? 'OVER' : 'UNDER'),
    cardType: r.card_type,
    hitOrMiss: r.hit_or_miss,
  }));
}

export async function computeWnbaCalibration(opts: { windowDays?: number } = {}): Promise<WnbaCalibrationReport> {
  await ensureWnbaProjectionHistoryTable();
  const windowDays = opts.windowDays ?? 30;
  const pool = getPool();

  const { rows } = await pool.query<{
    probability: string;
    edge_percent: string | null;
    stat_key: string;
    card_type: string | null;
    hit_or_miss: boolean;
    failure_archetype: string | null;
  }>(
    `SELECT probability, edge_percent, stat_key, card_type, hit_or_miss,
            failure_archetype
       FROM wnba_projection_history
      WHERE hit_or_miss IS NOT NULL
        AND game_date >= (CURRENT_DATE - $1::int)`,
    [windowDays],
  );

  const totalGraded = rows.length;
  const totalHits = rows.filter((r) => r.hit_or_miss === true).length;
  const totalMisses = totalGraded - totalHits;
  const overallHitRate = totalGraded > 0 ? (totalHits / totalGraded) * 100 : 0;
  const smoothedHitRate = smoothHit(totalHits, totalGraded);
  const averagePredicted = totalGraded > 0
    ? rows.reduce((s, r) => s + Number(r.probability), 0) / totalGraded
    : 0;
  const calibrationGap = overallHitRate - averagePredicted;

  // By probability bucket — 50-59 / 60-69 / 70-79 / 80+
  const probBuckets: Array<{ min: number; max: number; label: string }> = [
    { min: 0,  max: 49.999, label: '<50%' },
    { min: 50, max: 59.999, label: '50-59%' },
    { min: 60, max: 69.999, label: '60-69%' },
    { min: 70, max: 79.999, label: '70-79%' },
    { min: 80, max: 100,    label: '80%+' },
  ];
  const byProbability: CalibrationBucket[] = probBuckets.map((b) => {
    const inB = rows.filter((r) => Number(r.probability) >= b.min && Number(r.probability) <= b.max);
    const hits = inB.filter((r) => r.hit_or_miss).length;
    const predAvg = inB.length > 0
      ? inB.reduce((s, r) => s + Number(r.probability), 0) / inB.length
      : 0;
    return {
      label: b.label,
      graded: inB.length,
      hits,
      predictedAverage: Math.round(predAvg * 10) / 10,
      observedHitRate: inB.length > 0 ? Math.round((hits / inB.length) * 1000) / 10 : 0,
      smoothedHitRate: Math.round(smoothHit(hits, inB.length) * 10) / 10,
      sampleTier: tierFromN(inB.length),
    };
  });

  // By stat type
  const statKeys = [...new Set(rows.map((r) => r.stat_key))].sort();
  const byStatType: CalibrationBucket[] = statKeys.map((stat) => {
    const inS = rows.filter((r) => r.stat_key === stat);
    const hits = inS.filter((r) => r.hit_or_miss).length;
    const predAvg = inS.length > 0
      ? inS.reduce((s, r) => s + Number(r.probability), 0) / inS.length
      : 0;
    return {
      label: stat,
      graded: inS.length,
      hits,
      predictedAverage: Math.round(predAvg * 10) / 10,
      observedHitRate: inS.length > 0 ? Math.round((hits / inS.length) * 1000) / 10 : 0,
      smoothedHitRate: Math.round(smoothHit(hits, inS.length) * 10) / 10,
      sampleTier: tierFromN(inS.length),
    };
  });

  // By card type
  const cardKeys = [...new Set(rows.map((r) => r.card_type ?? 'unspecified'))].sort();
  const byCardType: CalibrationBucket[] = cardKeys.map((card) => {
    const inC = rows.filter((r) => (r.card_type ?? 'unspecified') === card);
    const hits = inC.filter((r) => r.hit_or_miss).length;
    const predAvg = inC.length > 0
      ? inC.reduce((s, r) => s + Number(r.probability), 0) / inC.length
      : 0;
    return {
      label: card,
      graded: inC.length,
      hits,
      predictedAverage: Math.round(predAvg * 10) / 10,
      observedHitRate: inC.length > 0 ? Math.round((hits / inC.length) * 1000) / 10 : 0,
      smoothedHitRate: Math.round(smoothHit(hits, inC.length) * 10) / 10,
      sampleTier: tierFromN(inC.length),
    };
  });

  // Phase 102 — Loss Forensics. Distribution of failure archetypes
  // across rows where hit_or_miss === false AND failure_archetype is
  // populated. Older rows pre-Phase-102 will have null archetypes
  // and are excluded from the distribution.
  const missArchetypes = rows
    .filter((r) => r.hit_or_miss === false && r.failure_archetype)
    .map((r) => r.failure_archetype as FailureArchetype);
  const failureArchetypes = summarizeArchetypes(missArchetypes);

  return {
    windowDays,
    totalGraded,
    totalHits,
    totalMisses,
    overallHitRate: Math.round(overallHitRate * 10) / 10,
    smoothedHitRate: Math.round(smoothedHitRate * 10) / 10,
    averagePredicted: Math.round(averagePredicted * 10) / 10,
    calibrationGap: Math.round(calibrationGap * 10) / 10,
    byProbability,
    byStatType,
    byCardType,
    failureArchetypes,
    modelVersion: WNBA_MODEL_VERSION,
  };
}
