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
           card_type, model_version, inputs_json
         ) VALUES (
           $1, $2, NULL, NULL,
           $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14, $15
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
         card_type, model_version, inputs_json
       ) VALUES (
         $1, $2, NULL, NULL,
         $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15
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
  }>(
    `SELECT id, game_date, player_id, selected_stat, line_value, direction,
            projection_value, probability, risk_score, trap_score, card_type,
            result_value, hit_or_miss, graded_at
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
  }));
}

// Update a single graded row. Used by the grader to fill in results.
export async function setMlbProjectionResult(opts: {
  id: number;
  resultValue: number;
  hitOrMiss: boolean;
}): Promise<void> {
  await getPool().query(
    `UPDATE mlb_projection_history
        SET result_value = $1,
            hit_or_miss  = $2,
            graded_at    = NOW()
      WHERE id = $3`,
    [opts.resultValue, opts.hitOrMiss, opts.id],
  );
}

function toIsoDate(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
