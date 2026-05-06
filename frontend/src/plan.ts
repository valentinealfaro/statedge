// Local plan + daily-usage tracker. Storage keys are now uid-namespaced
// when the user is signed in (via userKey.ts) so two people sharing a
// browser don't see each other's counter or plan flag. Falls back to
// the device-shared key when signed out — that path stays a no-op
// when auth isn't configured.
//
// Stripe still isn't wired (external setup required); the unlock code
// path is the temporary entitlement bridge until it is.

import { useCallback, useEffect, useState } from 'react';
import { onUidChange, userKey } from './userKey';

export type Plan = 'free' | 'pro';

const PLAN_BASE = 'statedge.plan';
const USAGE_BASE = 'statedge.usage';
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
    const raw = localStorage.getItem(userKey(USAGE_BASE));
    if (!raw) return { date: todayKey(), count: 0 };
    const parsed = JSON.parse(raw) as Usage;
    if (parsed.date !== todayKey()) return { date: todayKey(), count: 0 };
    return parsed;
  } catch {
    return { date: todayKey(), count: 0 };
  }
}

function writeUsage(u: Usage) {
  try { localStorage.setItem(userKey(USAGE_BASE), JSON.stringify(u)); } catch { /* ignore */ }
}

function readPlan(): Plan {
  try {
    return (localStorage.getItem(userKey(PLAN_BASE)) as Plan) === 'pro' ? 'pro' : 'free';
  } catch {
    return 'free';
  }
}

export function unlockPro(code: string): boolean {
  if (code.trim().toUpperCase() !== PRO_UNLOCK_CODE) return false;
  try { localStorage.setItem(userKey(PLAN_BASE), 'pro'); } catch { /* ignore */ }
  return true;
}

export function downgradeToFree() {
  try { localStorage.setItem(userKey(PLAN_BASE), 'free'); } catch { /* ignore */ }
}

export function usePlan() {
  const [plan, setPlan] = useState<Plan>(() => readPlan());
  const [usage, setUsage] = useState<Usage>(() => readUsage());

  // Re-read from storage on mount so a tab that was open across midnight
  // picks up the date rollover, plan changes from another tab sync via
  // 'storage', AND uid changes (sign-in / sign-out) flip the namespace.
  useEffect(() => {
    const sync = () => {
      setPlan(readPlan());
      setUsage(readUsage());
    };
    sync();
    window.addEventListener('storage', sync);
    const unsubUid = onUidChange(sync);
    return () => {
      window.removeEventListener('storage', sync);
      unsubUid();
    };
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
