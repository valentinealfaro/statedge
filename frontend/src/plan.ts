// Local-only plan + daily-usage tracker.
//
// Auth/Stripe aren't wired yet (external setup required), but the spec's
// free-tier gate ("2 comparisons / day") still needs to exist so users see
// a real Free → Pro surface. We key off localStorage and the local date.
//
// "Pro" can be unlocked offline via the secret code in unlockPro() — once
// Stripe is in place this gets replaced by a real entitlement check.

import { useCallback, useEffect, useState } from 'react';

export type Plan = 'free' | 'pro';

const PLAN_KEY = 'statedge.plan';
const USAGE_KEY = 'statedge.usage';
const PRO_UNLOCK_CODE = 'STATEDGE-EARLY';

export const FREE_DAILY_LIMIT = 2;

function todayKey(): string {
  const d = new Date();
  // YYYY-MM-DD in local time so the limit resets at the user's midnight.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

type Usage = { date: string; count: number };

function readUsage(): Usage {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (!raw) return { date: todayKey(), count: 0 };
    const parsed = JSON.parse(raw) as Usage;
    if (parsed.date !== todayKey()) return { date: todayKey(), count: 0 };
    return parsed;
  } catch {
    return { date: todayKey(), count: 0 };
  }
}

function writeUsage(u: Usage) {
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch { /* ignore */ }
}

function readPlan(): Plan {
  try {
    return (localStorage.getItem(PLAN_KEY) as Plan) === 'pro' ? 'pro' : 'free';
  } catch {
    return 'free';
  }
}

export function unlockPro(code: string): boolean {
  if (code.trim().toUpperCase() !== PRO_UNLOCK_CODE) return false;
  try { localStorage.setItem(PLAN_KEY, 'pro'); } catch { /* ignore */ }
  return true;
}

export function downgradeToFree() {
  try { localStorage.setItem(PLAN_KEY, 'free'); } catch { /* ignore */ }
}

export function usePlan() {
  const [plan, setPlan] = useState<Plan>(() => readPlan());
  const [usage, setUsage] = useState<Usage>(() => readUsage());

  // Re-read from storage on mount so a tab that was open across midnight
  // picks up the date rollover, and so plan changes from another tab sync.
  useEffect(() => {
    const sync = () => {
      setPlan(readPlan());
      setUsage(readUsage());
    };
    sync();
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const recordComparison = useCallback(() => {
    if (readPlan() === 'pro') return;
    const u = readUsage();
    const next: Usage = { date: u.date, count: u.count + 1 };
    writeUsage(next);
    setUsage(next);
  }, []);

  const refresh = useCallback(() => {
    setPlan(readPlan());
    setUsage(readUsage());
  }, []);

  const remaining = plan === 'pro'
    ? Infinity
    : Math.max(0, FREE_DAILY_LIMIT - usage.count);

  return {
    plan,
    usageToday: usage.count,
    remaining,
    canRunComparison: plan === 'pro' || remaining > 0,
    recordComparison,
    refresh,
  };
}
