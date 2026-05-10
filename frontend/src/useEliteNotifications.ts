// useEliteNotifications — Phase 148l.
//
// Companion to useStarredNotifications but scoped to the user's
// today's-Elite ticket. Fires a single desktop notification when the
// ticket-level verdict transitions from null/in-flight to HIT or
// MISS. One notification per resolution event per session — once
// fired, won't refire even on tab refocus.
//
// Permission model: same as useStarredNotifications. Never
// auto-prompts; respects the existing browser permission. Pages that
// mount this hook should also surface the opt-in button.

import { useEffect, useRef } from 'react';
import type { EliteLiveStateResponse } from './api';

export function useEliteNotifications(
  ticketDate: string | null,
  rollup: EliteLiveStateResponse['rollup'] | null,
): void {
  // Tracks (ticketDate, verdict) tuples we've already fired for, so
  // the same resolution event doesn't refire on every poll. Cleared
  // when ticketDate changes (new day = new ticket = new firing
  // opportunity).
  const firedRef = useRef<Set<string>>(new Set());
  const lastDateRef = useRef<string | null>(null);

  useEffect(() => {
    // Reset firing memory on new ticket date.
    if (lastDateRef.current !== ticketDate) {
      firedRef.current = new Set();
      lastDateRef.current = ticketDate;
    }

    if (!ticketDate || !rollup) return;
    const verdict = rollup.ticketVerdict;
    if (verdict !== 'HIT' && verdict !== 'MISS') return;

    const fingerprint = `${ticketDate}::${verdict}`;
    if (firedRef.current.has(fingerprint)) return;
    firedRef.current.add(fingerprint);

    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const isHit = verdict === 'HIT';
    try {
      const n = new Notification(
        `${isHit ? '✓ Elite ticket HIT' : '✗ Elite ticket MISS'}`,
        {
          body: `${rollup.legsTotal}-leg ticket · ${rollup.hit} hit / ${rollup.miss} miss`,
          tag: `statedge-elite-${ticketDate}`,
          icon: '/favicon.ico',
        },
      );
      n.onclick = () => {
        window.focus();
        window.location.assign('/elite');
      };
    } catch {
      /* OS notification API can throw on some platforms; ignore */
    }
  }, [ticketDate, rollup]);
}
