// useEliteLiveTally — Phase 148j.
//
// Polls /api/slate/elite/live-state once per minute and returns a
// roll-up suitable for the NavBar's ★ Elite tab pulse signal:
//   - inFlight: at least one leg is currently live → red pulse
//   - hit:      ticket fully resolved as HIT today → green dot
//   - miss:     ticket resolved MISS or has any locked-out leg → red dot
//   - none:     no signal (pre-game, ungraded, no ticket persisted)
//
// The endpoint is already cached server-side (30s edge cache), so
// every-minute polling per browser tab is fine.

import { useEffect, useState } from 'react';
import { getEliteLiveState } from './api';

export type EliteLiveTally = {
  hasTicket: boolean;
  inFlight: number;
  hit: number;
  miss: number;
  ticketVerdict: 'HIT' | 'MISS' | null;
};

export function useEliteLiveTally(): EliteLiveTally {
  const [tally, setTally] = useState<EliteLiveTally>({
    hasTicket: false,
    inFlight: 0,
    hit: 0,
    miss: 0,
    ticketVerdict: null,
  });

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      getEliteLiveState()
        .then((r) => {
          if (cancelled) return;
          const rollup = r.rollup;
          if (!rollup) {
            setTally({ hasTicket: r.ticketDate !== null, inFlight: 0, hit: 0, miss: 0, ticketVerdict: null });
            return;
          }
          setTally({
            hasTicket: r.ticketDate !== null,
            inFlight: rollup.inFlight,
            hit: rollup.hit,
            miss: rollup.miss,
            ticketVerdict: rollup.ticketVerdict,
          });
        })
        .catch(() => { /* silent — tally falls back to no-signal */ });
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  return tally;
}
