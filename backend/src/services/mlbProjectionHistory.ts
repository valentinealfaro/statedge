// MLB projection history — Phase 5 calibration foundation.
//
// Every projection that ships as part of a published slate gets a
// row in mlb_projection_history. After games finish, the grader
// fills in result_value + hit_or_miss. Calibration aggregates over
// graded rows to surface predicted-vs-actual accuracy per
// probability bucket / stat type / risk tier.
//
// Mission alignment:
//   - "Truth and accountability" — every projection is auditable
//   - "No fake guarantees" — calibration shows when the model is wrong
//   - "Long-term EV over short-term excitement" — this is the
//     foundation that enables the model to improve over time
//
// Writes are tied to slate construction (POST /api/mlb/slate). Ad-hoc
// /api/mlb/projection requests don't persist — those are exploratory.

import { getPool } from '../db.js';
import type { MlbCombo } from './mlbSlateBuilder.js';
import type { ResolvedMlbLine } from './mlbSlatePipeline.js';
import { ensureMlbTables } from '../mlb/db.js';

// Schema version stamped on every row. Bump when the projection
// formula changes meaningfully — calibration can then segregate
// pre/post-formula rows so we don't compare against an old model.
export const MLB_MODEL_VERSION = 'mlb-v0.3.5-park-weather-lineup-bvp';

export type RecordableMlbCombo = {
  combo: MlbCombo;
  cardType: MlbCombo['label'];
};

// Persist all legs from a published slate. One row per leg per card
// (so a player appearing in multiple cards gets multiple rows — that's
// intentional, calibration treats each card-leg as an independent
// observation).
export async function recordMlbSlateProjections(opts: {
  combos: RecordableMlbCombo[];
  gameDate: string;            // YYYY-MM-DD — drives the grader join
}): Promise<{ inserted: number }> {
  await ensureMlbTables();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.gameDate)) {
    throw new Error(`Invalid gameDate: ${opts.gameDate} (expected YYYY-MM-DD).`);
  }
  const pool = getPool();
  let inserted = 0;
  for (const { combo, cardType } of opts.combos) {
    for (const leg of combo.legs) {
      // Inputs JSON captures the leg's full projection snapshot at
      // lock time so we can replay what the model saw later (drift
      // analysis, auditing). Lean — no Postgres-heavy types.
      const inputsJson = {
        modelVersion: MLB_MODEL_VERSION,
        cardLabel: combo.label,
        cardSubtitle: combo.subtitle,
        cardSize: combo.size,
        averageEdge: combo.averageEdge,
        averageTrap: combo.averageTrap,
        gamePk: leg.gamePk,
        bookableSide: leg.bookableSide,
      };

      // team_id + opponent_team_id are best-effort. We have team in
      // the leg (string abbr) but not opponent. Future enhancement:
      // resolve from gamePk → mlb_games row at write time. For now,
      // grader doesn't need them — it joins on player_id + game_date.
      await pool.query(
        `INSERT INTO mlb_projection_history (
           game_date, player_id, team_id, opponent_team_id,
           selected_stat, line_value, direction,
           projection_value, probability, confidence_score,
           risk_score, trap_score, edge_score, ev_score,
           card_type, model_version, inputs_json,
           market_implied_prob, edge_percent, line_inflation_score,
           public_bias_tags, sharpness_score, edge_durability,
           fragility_score, momentum_score, reason_codes,
           why_market_wrong
         ) VALUES (
           $1, $2, NULL, NULL,
           $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14, $15,
           $16, $17, $18,
           $19, $20, $21,
           $22, $23, $24,
           $25
         )`,
        [
          opts.gameDate,
          leg.playerId,
          leg.statKey,
          leg.line,
          leg.direction,
          leg.projection,
          leg.probability,
          /* confidence_score */ null,    // future: surface from leg
          leg.riskScore,
          leg.trapScore,
          /* edge_score */ null,
          /* ev_score */ null,
          cardType,
          MLB_MODEL_VERSION,
          JSON.stringify(inputsJson),
          // Phase 102 — Market Memory snapshot.
          leg.marketImpliedProb ?? null,
          leg.edgePercent ?? null,
          leg.lineInflationScore ?? null,
          leg.publicBiasTags ?? [],
          leg.sharpnessScore ?? null,
          leg.edgeDurability ?? null,
          leg.fragilityScore ?? null,
          leg.momentumExpansionScore ?? null,
          leg.reasonCodes ?? [],
          leg.whyMarketWrong ?? null,
        ],
      );
      inserted += 1;
    }
  }
  return { inserted };
}

// Persist top SGP legs for a single game-detail page view. Each
// matchup snapshots its top-N edge legs (typically 4 — the actual
// displayed parlay) under card_type='SGP' so the calibration loop +
// the slate history page can grade them just like Best 2-6 + Wild
// Card cards. This is THE feedback channel that proves "we pick
// winners" — every game's SGP becomes a tracked prediction with
// real-world outcome, accumulating evidence over time.
export async function recordMlbSgpLegs(opts: {
  legs: ResolvedMlbLine[];
  gameDate: string;            // YYYY-MM-DD
  gamePk: number;
  awayAbbr: string | null;
  homeAbbr: string | null;
}): Promise<{ inserted: number }> {
  await ensureMlbTables();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.gameDate)) {
    throw new Error(`Invalid gameDate: ${opts.gameDate} (expected YYYY-MM-DD).`);
  }
  if (opts.legs.length === 0) return { inserted: 0 };
  const pool = getPool();
  let inserted = 0;
  for (const leg of opts.legs) {
    const inputsJson = {
      modelVersion: MLB_MODEL_VERSION,
      cardLabel: 'SGP',
      cardSize: opts.legs.length,
      gamePk: opts.gamePk,
      matchup:
        opts.awayAbbr && opts.homeAbbr
          ? `${opts.awayAbbr}@${opts.homeAbbr}`
          : null,
      bookableSide: leg.bookableSide,
    };
    await pool.query(
      `INSERT INTO mlb_projection_history (
         game_date, player_id, team_id, opponent_team_id,
         selected_stat, line_value, direction,
         projection_value, probability, confidence_score,
         risk_score, trap_score, edge_score, ev_score,
         card_type, model_version, inputs_json,
         market_implied_prob, edge_percent, line_inflation_score,
         public_bias_tags, sharpness_score, edge_durability,
         fragility_score, momentum_score, reason_codes,
         why_market_wrong
       ) VALUES (
         $1, $2, NULL, NULL,
         $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15,
         $16, $17, $18,
         $19, $20, $21,
         $22, $23, $24,
         $25
       )`,
      [
        opts.gameDate,
        leg.playerId,
        leg.statKey,
        leg.line,
        leg.modelDirection,
        leg.projection.projection,
        leg.projection.probability,
        null,
        leg.projection.riskScore,
        leg.projection.trapScore,
        null,
        null,
        'SGP',
        MLB_MODEL_VERSION,
        JSON.stringify(inputsJson),
        // Phase 102 — Market Memory snapshot for SGP legs too.
        leg.projection.marketImpliedProb,
        leg.projection.edgePercent,
        leg.projection.lineInflationScore,
        leg.projection.publicBiasTags,
        leg.projection.sharpnessScore,
        leg.projection.edgeDurability,
        leg.projection.fragilityScore,
        leg.projection.momentumExpansionScore,
        leg.projection.reasonCodes,
        leg.projection.whyMarketWrong,
      ],
    );
    inserted += 1;
  }
  return { inserted };
}

// Read ungraded rows in a window — used by both the lazy grader and
// the calibration aggregator (which only counts graded rows). Bounded
// to a 90-day window by default so calibration queries stay fast.
export type StoredProjection = {
  id: number;
  gameDate: string;
  playerId: number;
  selectedStat: string;
  lineValue: number;
  direction: 'OVER' | 'UNDER';
  projectionValue: number;
  probability: number;
  riskScore: number | null;
  trapScore: number | null;
  cardType: string | null;
  resultValue: number | null;
  hitOrMiss: boolean | null;
  gradedAt: string | null;
  // Phase 102 — Market Memory fields snapshotted at projection time.
  // Nullable because legacy rows pre-Phase-102 don't have them.
  marketImpliedProb: number | null;
  edgePercent: number | null;
  lineInflationScore: number | null;
  publicBiasTags: string[] | null;
  sharpnessScore: number | null;
  edgeDurability: string | null;
  fragilityScore: number | null;
  momentumScore: number | null;
  reasonCodes: string[] | null;
  whyMarketWrong: string | null;
  failureArchetype: string | null;
};

export async function listMlbProjections(opts: {
  windowDays?: number;
  graded?: 'graded' | 'ungraded' | 'all';
}): Promise<StoredProjection[]> {
  await ensureMlbTables();
  const pool = getPool();
  const windowDays = opts.windowDays ?? 90;
  const graded = opts.graded ?? 'all';
  const gradedClause =
    graded === 'graded'   ? 'AND hit_or_miss IS NOT NULL'
    : graded === 'ungraded' ? 'AND hit_or_miss IS NULL'
    : '';
  const { rows } = await pool.query<{
    id: number;
    game_date: Date;
    player_id: number;
    selected_stat: string;
    line_value: string;
    direction: string;
    projection_value: string;
    probability: string;
    risk_score: string | null;
    trap_score: string | null;
    card_type: string | null;
    result_value: string | null;
    hit_or_miss: boolean | null;
    graded_at: Date | null;
    market_implied_prob: string | null;
    edge_percent: string | null;
    line_inflation_score: string | null;
    public_bias_tags: string[] | null;
    sharpness_score: string | null;
    edge_durability: string | null;
    fragility_score: string | null;
    momentum_score: string | null;
    reason_codes: string[] | null;
    why_market_wrong: string | null;
    failure_archetype: string | null;
  }>(
    `SELECT id, game_date, player_id, selected_stat, line_value, direction,
            projection_value, probability, risk_score, trap_score, card_type,
            result_value, hit_or_miss, graded_at,
            market_implied_prob, edge_percent, line_inflation_score,
            public_bias_tags, sharpness_score, edge_durability,
            fragility_score, momentum_score, reason_codes,
            why_market_wrong, failure_archetype
       FROM mlb_projection_history
      WHERE game_date >= (CURRENT_DATE - $1::int)
            ${gradedClause}
      ORDER BY game_date DESC, id DESC`,
    [windowDays],
  );
  return rows.map((r) => ({
    id: r.id,
    gameDate: toIsoDate(r.game_date),
    playerId: r.player_id,
    selectedStat: r.selected_stat,
    lineValue: Number(r.line_value),
    direction: (r.direction === 'UNDER' ? 'UNDER' : 'OVER') as 'OVER' | 'UNDER',
    projectionValue: Number(r.projection_value),
    probability: Number(r.probability),
    riskScore: r.risk_score === null ? null : Number(r.risk_score),
    trapScore: r.trap_score === null ? null : Number(r.trap_score),
    cardType: r.card_type,
    resultValue: r.result_value === null ? null : Number(r.result_value),
    hitOrMiss: r.hit_or_miss,
    gradedAt: r.graded_at ? r.graded_at.toISOString() : null,
    marketImpliedProb: r.market_implied_prob === null ? null : Number(r.market_implied_prob),
    edgePercent: r.edge_percent === null ? null : Number(r.edge_percent),
    lineInflationScore: r.line_inflation_score === null ? null : Number(r.line_inflation_score),
    publicBiasTags: r.public_bias_tags,
    sharpnessScore: r.sharpness_score === null ? null : Number(r.sharpness_score),
    edgeDurability: r.edge_durability,
    fragilityScore: r.fragility_score === null ? null : Number(r.fragility_score),
    momentumScore: r.momentum_score === null ? null : Number(r.momentum_score),
    reasonCodes: r.reason_codes,
    whyMarketWrong: r.why_market_wrong,
    failureArchetype: r.failure_archetype,
  }));
}

// Update a single graded row. Used by the grader to fill in results.
// Phase 102 — also persists failure_archetype on misses so the
// calibration page can show "where are misses concentrating?"
export async function setMlbProjectionResult(opts: {
  id: number;
  resultValue: number;
  hitOrMiss: boolean;
  failureArchetype?: string | null;
}): Promise<void> {
  await getPool().query(
    `UPDATE mlb_projection_history
        SET result_value      = $1,
            hit_or_miss       = $2,
            graded_at         = NOW(),
            failure_archetype = $3
      WHERE id = $4`,
    [opts.resultValue, opts.hitOrMiss, opts.failureArchetype ?? null, opts.id],
  );
}

function toIsoDate(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
