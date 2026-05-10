// GlobalNotifications — Phase 148n.
//
// Mounts the starred-prop + Elite-ticket notification hooks at the App
// level so desktop notifications fire regardless of which page the
// user is on. Previously the hooks lived on /starred and /elite — fine
// while users were on those pages, useless when they were on /best-bets,
// /nba/slate, the home page, etc.
//
// Polls cadence: 60s (matches the live-state edge cache TTL).
// Permission-conservative — fires only when Notification.permission ===
// 'granted'. The opt-in buttons live on /starred and /elite and prompt
// the user; this component just respects the resulting permission.
//
// Renders nothing visible.

import { useEffect, useState } from 'react';
import {
  getEliteLiveState,
  liveGradeLegs,
  type EliteLegLiveState,
  type EliteLiveStateResponse,
} from './api';
import { useStarredProps } from './starredProps';
import { useEliteNotifications } from './useEliteNotifications';
import { useStarredNotifications } from './useStarredNotifications';

export function GlobalNotifications() {
  const { items } = useStarredProps();
  const [liveByKey, setLiveByKey] = useState<Map<string, EliteLegLiveState>>(new Map());
  const [eliteState, setEliteState] = useState<EliteLiveStateResponse | null>(null);

  // Single combined poll — Elite live-state + per-leg starred grading.
  // If permission isn't granted yet, polling still runs (cheap) so
  // that the moment the user grants permission the next firing finds
  // a fresh state and the baseline pass primes correctly.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      // Elite ticket
      try {
        const elite = await getEliteLiveState();
        if (!cancelled) setEliteState(elite);
      } catch { /* silent */ }

      // Starred props — all sports. UFC stat keys outside the supported
      // set (sig_strikes/takedowns/knockdowns/control_time) come back
      // UNGRADED, which the notification hook ignores by design.
      const gradable = items.slice(0, 50);
      if (gradable.length === 0) {
        if (!cancelled) setLiveByKey(new Map());
        return;
      }
      try {
        const states = await liveGradeLegs(gradable.map((p) => ({
          playerId: p.playerId,
          espnAthleteId: p.espnAthleteId,
          playerName: p.playerName,
          statKey: p.statKey,
          direction: p.direction,
          line: p.line,
        })));
        if (cancelled) return;
        const m = new Map<string, EliteLegLiveState>();
        for (let i = 0; i < states.length; i++) {
          m.set(gradable[i]!.id, states[i]!);
        }
        setLiveByKey(m);
      } catch { /* silent */ }
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [items]);

  // Mount the per-domain notification hooks. Each owns its own
  // de-dupe state (firedRef + ticketDate reset) so the same event
  // never fires twice in one session.
  useStarredNotifications(items, liveByKey);
  useEliteNotifications(eliteState?.ticketDate ?? null, eliteState?.rollup ?? null);

  return null;
}
