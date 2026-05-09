// Provider credit budget tracker — Phase 103e.
//
// The Odds API charges credits per request; the free tier is 500/month.
// An infinite loop or accidentally-scheduled poll could drain that
// in minutes. This module is the safety net.
//
// Design points:
//   1. DB-backed counter. Vercel function instances are ephemeral —
//      in-memory counters reset on cold start, which would let the
//      same function re-spend the budget after every redeploy. The
//      counter lives in `provider_credit_usage` (one row per
//      provider × calendar-month).
//   2. Best-effort with self-report. The Odds API returns
//      x-requests-used in the response headers — we use that as
//      ground truth when present, and fall back to "+1 per call"
//      when it's missing.
//   3. Soft cap from env. ODDS_API_MONTHLY_CREDITS=500 says "refuse
//      fetches once the running total ≥ 500 in the current calendar
//      month." Operator can raise it (after upgrade) without code
//      changes.
//   4. Calendar-month rollover. UTC. The counter for May resets to
//      zero on June 1 00:00 UTC.

import { getPool, isDbConfigured } from '../db.js';

let budgetTableEnsured = false;

async function ensureBudgetTable(): Promise<void> {
  if (budgetTableEnsured || !isDbConfigured()) {
    budgetTableEnsured = true;
    return;
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS provider_credit_usage (
      provider_source TEXT NOT NULL,
      year_month      TEXT NOT NULL,         -- YYYY-MM, UTC
      credits_used    NUMERIC NOT NULL DEFAULT 0,
      requests        INTEGER NOT NULL DEFAULT 0,
      last_updated    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (provider_source, year_month)
    );
  `);
  budgetTableEnsured = true;
}

function currentYearMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export type BudgetStatus = {
  provider: string;
  yearMonth: string;
  creditsUsed: number;
  creditsCap: number | null;       // null = uncapped (no env var)
  creditsRemaining: number | null; // null when uncapped
  requests: number;
  exhausted: boolean;
};

// Read current budget status. Returns even when DB is not configured
// (in which case we report uncapped, untracked).
export async function getBudgetStatus(provider: string, capEnv: string): Promise<BudgetStatus> {
  const yearMonth = currentYearMonth();
  const cap = process.env[capEnv] ? Number(process.env[capEnv]) : null;
  if (!isDbConfigured()) {
    return {
      provider, yearMonth,
      creditsUsed: 0,
      creditsCap: cap,
      creditsRemaining: cap,
      requests: 0,
      exhausted: false,
    };
  }
  await ensureBudgetTable();
  const { rows } = await getPool().query<{ credits_used: string; requests: string }>(
    `SELECT credits_used, requests FROM provider_credit_usage
      WHERE provider_source = $1 AND year_month = $2`,
    [provider, yearMonth],
  );
  const creditsUsed = rows[0] ? Number(rows[0].credits_used) : 0;
  const requests = rows[0] ? Number(rows[0].requests) : 0;
  const remaining = cap === null ? null : Math.max(0, cap - creditsUsed);
  return {
    provider, yearMonth,
    creditsUsed,
    creditsCap: cap,
    creditsRemaining: remaining,
    requests,
    exhausted: cap !== null && creditsUsed >= cap,
  };
}

// Throw if a fetch would push us over budget. Call this BEFORE the
// network request. Returns the current status for caller to log.
export async function assertBudgetAvailable(
  provider: string,
  capEnv: string,
  estimatedCost: number,
): Promise<BudgetStatus> {
  const status = await getBudgetStatus(provider, capEnv);
  if (status.creditsCap !== null && status.creditsUsed + estimatedCost > status.creditsCap) {
    throw new Error(
      `${provider} budget exceeded: used ${status.creditsUsed} + estimate ${estimatedCost} > cap ${status.creditsCap} for ${status.yearMonth}. ` +
      `Either raise ${capEnv} (after upgrading the provider plan) or wait for next-month rollover.`,
    );
  }
  return status;
}

// Record actual credits spent after a fetch. Pass the provider's
// reported cost (from response headers) when available, else 1.
export async function recordSpend(provider: string, credits: number): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBudgetTable();
  const yearMonth = currentYearMonth();
  await getPool().query(
    `INSERT INTO provider_credit_usage (provider_source, year_month, credits_used, requests, last_updated)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (provider_source, year_month) DO UPDATE
       SET credits_used = provider_credit_usage.credits_used + EXCLUDED.credits_used,
           requests     = provider_credit_usage.requests + 1,
           last_updated = NOW()`,
    [provider, yearMonth, credits],
  );
}
