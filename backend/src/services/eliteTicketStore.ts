// Elite ticket persistence + grading — Phase 142.
//
// Cross-sport Elite endpoint produces a ticket and publishes an
// article. To build a TRUE track record we also persist the ticket
// in a structured table so it can grade against actual game outcomes
// once they settle. Each leg's hit/miss is derivable from the
// existing per-sport projection_history rows; we record the
// ticket-level verdict (HIT iff every leg hit, otherwise MISS) so
// the historical view can show the full ledger.

import { getPool, isDbConfigured } from '../db.js';
import type { CrossSportTicket } from './crossSportEliteBuilder.js';

let tableEnsured = false;

export type StoredEliteTicket = {
  id: number;
  ticketDate: string;             // YYYY-MM-DD ET
  grade: 'A+' | 'A' | 'B';
  tier: '3-leg' | '2-leg';
  tierName: string;
  combinedFairPayout: number;
  combinedProbability: number;
  combinedEdgePercent: number;
  dislocationScore: number;
  sportsCovered: ('mlb' | 'nba' | 'mma')[];
  // Full ticket payload (legs + rationale) for replay / display
  legsJson: unknown;
  // Grading state — null until at least one leg has graded
  hitOrMiss: boolean | null;
  legsHit: number | null;
  legsTotal: number;
  gradedAt: string | null;
  createdAt: string;
};

export async function ensureEliteTicketsTable(): Promise<void> {
  if (tableEnsured || !isDbConfigured()) {
    tableEnsured = true;
    return;
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS elite_tickets (
      id BIGSERIAL PRIMARY KEY,
      ticket_date DATE NOT NULL,
      grade TEXT NOT NULL,
      tier TEXT NOT NULL,
      tier_name TEXT NOT NULL,
      combined_fair_payout NUMERIC NOT NULL,
      combined_probability NUMERIC NOT NULL,
      combined_edge_percent NUMERIC NOT NULL,
      dislocation_score NUMERIC NOT NULL,
      sports_covered TEXT[] NOT NULL,
      legs_json JSONB NOT NULL,
      hit_or_miss BOOLEAN,
      legs_hit INT,
      legs_total INT NOT NULL,
      graded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (ticket_date)
    );
    CREATE INDEX IF NOT EXISTS elite_tickets_date_idx
      ON elite_tickets (ticket_date DESC);
    CREATE INDEX IF NOT EXISTS elite_tickets_ungraded_idx
      ON elite_tickets (graded_at)
      WHERE graded_at IS NULL;
  `);
  tableEnsured = true;
}

// Idempotent upsert keyed on ticket_date — re-running the cross-sport
// endpoint mid-day refreshes the ticket if the engine produces a
// stronger combination after a slate update.
export async function upsertEliteTicket(opts: {
  ticketDate: string;
  ticket: CrossSportTicket;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureEliteTicketsTable();
  const t = opts.ticket;
  await getPool().query(
    `INSERT INTO elite_tickets (
       ticket_date, grade, tier, tier_name,
       combined_fair_payout, combined_probability, combined_edge_percent,
       dislocation_score, sports_covered, legs_json,
       legs_total
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11
     )
     ON CONFLICT (ticket_date) DO UPDATE SET
       grade = EXCLUDED.grade,
       tier = EXCLUDED.tier,
       tier_name = EXCLUDED.tier_name,
       combined_fair_payout = EXCLUDED.combined_fair_payout,
       combined_probability = EXCLUDED.combined_probability,
       combined_edge_percent = EXCLUDED.combined_edge_percent,
       dislocation_score = EXCLUDED.dislocation_score,
       sports_covered = EXCLUDED.sports_covered,
       legs_json = EXCLUDED.legs_json,
       legs_total = EXCLUDED.legs_total
     -- DON'T overwrite grading state — once graded, stays graded.
     WHERE elite_tickets.graded_at IS NULL`,
    [
      opts.ticketDate,
      t.grade,
      t.tier,
      t.tierName,
      t.combinedFairPayout,
      t.combinedProbability,
      t.combinedEdgePercent,
      t.dislocationScore,
      t.sportsCovered,
      JSON.stringify({ legs: t.legs, rationale: t.rationale }),
      t.legs.length,
    ],
  );
}

export async function listEliteTickets(opts?: { limit?: number }): Promise<StoredEliteTicket[]> {
  if (!isDbConfigured()) return [];
  await ensureEliteTicketsTable();
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 30));
  const { rows } = await getPool().query<{
    id: number;
    ticket_date: Date;
    grade: string;
    tier: string;
    tier_name: string;
    combined_fair_payout: string;
    combined_probability: string;
    combined_edge_percent: string;
    dislocation_score: string;
    sports_covered: string[];
    legs_json: unknown;
    hit_or_miss: boolean | null;
    legs_hit: number | null;
    legs_total: number;
    graded_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, ticket_date, grade, tier, tier_name,
            combined_fair_payout, combined_probability, combined_edge_percent,
            dislocation_score, sports_covered, legs_json,
            hit_or_miss, legs_hit, legs_total, graded_at, created_at
       FROM elite_tickets
      ORDER BY ticket_date DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    ticketDate: r.ticket_date.toISOString().slice(0, 10),
    grade: r.grade as 'A+' | 'A' | 'B',
    tier: r.tier as '3-leg' | '2-leg',
    tierName: r.tier_name,
    combinedFairPayout: Number(r.combined_fair_payout),
    combinedProbability: Number(r.combined_probability),
    combinedEdgePercent: Number(r.combined_edge_percent),
    dislocationScore: Number(r.dislocation_score),
    sportsCovered: r.sports_covered as ('mlb' | 'nba' | 'mma')[],
    legsJson: r.legs_json,
    hitOrMiss: r.hit_or_miss,
    legsHit: r.legs_hit,
    legsTotal: r.legs_total,
    gradedAt: r.graded_at ? r.graded_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  }));
}

// Walk ungraded tickets, look up each leg's hit/miss in the per-sport
// projection_history tables, compute ticket-level verdict (HIT only
// when EVERY leg hit). Tickets stay ungraded until ALL legs have a
// definitive verdict — partial-grade reports would be misleading.
export async function gradeEliteTickets(): Promise<{ graded: number; pending: number }> {
  if (!isDbConfigured()) return { graded: 0, pending: 0 };
  await ensureEliteTicketsTable();
  const pool = getPool();
  const { rows: ungraded } = await pool.query<{
    id: number;
    ticket_date: Date;
    legs_json: { legs: Array<{ playerId: number; espnAthleteId?: string; statKey: string; line: number; direction: 'OVER' | 'UNDER'; playerName: string }> };
  }>(`SELECT id, ticket_date, legs_json
        FROM elite_tickets
       WHERE graded_at IS NULL
         AND ticket_date < CURRENT_DATE`);

  let graded = 0;
  let pending = 0;
  for (const t of ungraded) {
    const verdicts: (boolean | null)[] = [];
    for (const leg of t.legs_json.legs) {
      const v = await gradeOneLeg({
        gameDate: t.ticket_date,
        playerId: leg.playerId,
        statKey: leg.statKey,
        direction: leg.direction,
        line: leg.line,
      });
      verdicts.push(v);
    }
    const allKnown = verdicts.every((v) => v !== null);
    if (!allKnown) {
      pending += 1;
      continue;
    }
    const legsHit = verdicts.filter((v) => v === true).length;
    const ticketHit = legsHit === verdicts.length;
    await pool.query(
      `UPDATE elite_tickets
          SET hit_or_miss = $1, legs_hit = $2, graded_at = NOW()
        WHERE id = $3`,
      [ticketHit, legsHit, t.id],
    );
    graded += 1;
  }
  return { graded, pending };
}

// Look up a single leg's hit/miss from the existing projection_history
// stores. Returns null when no graded row matches yet.
async function gradeOneLeg(args: {
  gameDate: Date;
  playerId: number;
  statKey: string;
  direction: 'OVER' | 'UNDER';
  line: number;
}): Promise<boolean | null> {
  const pool = getPool();
  // Try MLB first (numeric playerId is MLB Stats API id when leg
  // came from MLB engine).
  const mlb = await pool.query<{ hit_or_miss: boolean | null }>(
    `SELECT hit_or_miss
       FROM mlb_projection_history
      WHERE game_date = $1
        AND player_id = $2
        AND selected_stat = $3
        AND direction = $4
      ORDER BY id DESC
      LIMIT 1`,
    [args.gameDate, args.playerId, args.statKey, args.direction],
  ).catch(() => ({ rows: [] as Array<{ hit_or_miss: boolean | null }> }));
  if (mlb.rows[0]?.hit_or_miss !== undefined && mlb.rows[0].hit_or_miss !== null) {
    return mlb.rows[0].hit_or_miss;
  }
  // WNBA — for cross-sport NBA legs we don't have NBA projection_history
  // yet (NBA uses its own cache, not a graded log). NBA + UFC tickets
  // therefore stay ungraded until those grading pipelines exist.
  // That's HONEST per the no-fake-grading rule.
  return null;
}
