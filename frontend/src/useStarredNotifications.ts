// useStarredNotifications — Phase 148k.
//
// Watches the user's starred props' live verdicts and fires a desktop
// notification each time a prop transitions from "still in flight /
// pending" to a final/locked state (HIT / ON_PACE_HIT / MISS /
// ON_PACE_MISS / PUSH). Bloomberg-feel "your watchlist just hit"
// pings without requiring the user to leave the page open.
//
// Permission model:
//   - We never auto-prompt — the user explicitly opts in via a button
//     on /starred. The hook just RESPECTS the current permission and
//     fires when granted. It's the page's job to surface the prompt.
//   - When permission isn't granted, the hook still runs (cheap) but
//     calls a no-op for the actual notification.
//
// De-dupe: a prop only fires once per resolution. We track the last
// observed verdict per prop id; transitions to the same verdict don't
// re-fire. Initial load is a "set baseline only" pass — we don't fire
// for verdicts that already existed before the user landed on the page.

import { useEffect, useRef } from 'react';
import type { EliteLegLiveState } from './api';
import type { StarredProp } from './starredProps';

const FINAL_VERDICTS = new Set<EliteLegLiveState['verdict']>([
  'HIT', 'ON_PACE_HIT', 'MISS', 'ON_PACE_MISS', 'PUSH',
]);

export function useStarredNotifications(
  items: StarredProp[],
  liveByKey: Map<string, EliteLegLiveState>,
): void {
  // last verdict observed per prop id, used to detect transitions
  const prevRef = useRef<Map<string, string>>(new Map());
  // baselineSet ensures we don't fire on initial mount for verdicts
  // that already existed when the page loaded
  const baselineSetRef = useRef(false);

  useEffect(() => {
    const prev = prevRef.current;
    const next = new Map<string, string>();
    const transitions: Array<{ prop: StarredProp; verdict: EliteLegLiveState['verdict']; current: number | null }> = [];

    for (const p of items) {
      const live = liveByKey.get(p.id);
      if (!live) continue;
      next.set(p.id, live.verdict);
      if (!baselineSetRef.current) continue;     // initial pass — no fires
      const before = prev.get(p.id);
      if (before === live.verdict) continue;     // no transition
      if (FINAL_VERDICTS.has(live.verdict)) {
        transitions.push({ prop: p, verdict: live.verdict, current: live.currentValue });
      }
    }

    prevRef.current = next;

    if (!baselineSetRef.current) {
      baselineSetRef.current = true;
      return;
    }
    if (transitions.length === 0) return;

    // Fire notifications only when the user has explicitly granted.
    // We never auto-prompt; the page handles that.
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    for (const t of transitions) {
      const isHit = t.verdict === 'HIT' || t.verdict === 'ON_PACE_HIT';
      const isMiss = t.verdict === 'MISS' || t.verdict === 'ON_PACE_MISS';
      const tag = `statedge-starred-${t.prop.id}`;
      const verdictLabel =
        t.verdict === 'HIT' ? '✓ HIT'
        : t.verdict === 'ON_PACE_HIT' ? '✓ ON PACE'
        : t.verdict === 'MISS' ? '✗ MISS'
        : t.verdict === 'ON_PACE_MISS' ? '✗ LOCKED OUT'
        : '— PUSH';
      const valueSuffix = t.current !== null ? ` · ${t.current}` : '';
      try {
        const n = new Notification(`${verdictLabel} · ${t.prop.playerName}`, {
          body: `${t.prop.statLabel} ${t.prop.line} ${t.prop.direction === 'OVER' ? '↑' : '↓'}${valueSuffix}`,
          tag,                       // collapses repeat fires per prop in OS notification center
          icon: '/favicon.ico',
          silent: !isHit && !isMiss, // only ping audibly on definitive outcomes
        });
        n.onclick = () => {
          window.focus();
          window.location.assign('/starred');
        };
      } catch {
        /* OS notification API can throw on some platforms; ignore */
      }
    }
  }, [items, liveByKey]);
}

// Page-level helper to surface the permission state in UI. Returns
// 'default' (not asked yet) | 'granted' | 'denied' | 'unsupported'.
// Pages call this to decide whether to render the opt-in button.
export function notificationPermission(): 'default' | 'granted' | 'denied' | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

// Triggers the browser permission prompt. Returns the resulting state.
// Resolves to 'unsupported' when Notification API isn't available.
export async function requestNotificationPermission(): Promise<'default' | 'granted' | 'denied' | 'unsupported'> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return 'denied';
  }
}
