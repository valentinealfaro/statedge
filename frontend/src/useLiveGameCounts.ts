// useLiveGameCounts — Phase 148g.
//
// Lightweight global hook for "is anything live in sport X right now?"
// reads. Used by the NavBar to add a red pulse dot to NBA/MLB/MMA tabs
// when their sport has games in progress. Polls once per minute, cheap
// per-page tax — and the per-sport scoreboards are already cached
// server-side.

import { useEffect, useState } from 'react';
import {
  getMlbToday,
  getTodayGames,
  getUfcScoreboard,
} from './api';

export type LiveCounts = {
  nba: number;
  mlb: number;
  ufc: number;
};

export function useLiveGameCounts(): LiveCounts {
  const [counts, setCounts] = useState<LiveCounts>({ nba: 0, mlb: 0, ufc: 0 });

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      Promise.allSettled([
        getTodayGames().catch(() => null),
        getMlbToday().catch(() => null),
        getUfcScoreboard().catch(() => null),
      ]).then(([nbaRes, mlbRes, ufcRes]) => {
        if (cancelled) return;
        let nba = 0;
        let mlb = 0;
        let ufc = 0;
        if (nbaRes.status === 'fulfilled' && nbaRes.value) {
          for (const g of nbaRes.value.games) {
            if (g.status.state === 'in') nba++;
          }
        }
        if (mlbRes.status === 'fulfilled' && mlbRes.value) {
          for (const g of mlbRes.value.games) {
            if (g.status.inProgress) mlb++;
          }
        }
        if (ufcRes.status === 'fulfilled' && ufcRes.value) {
          for (const ev of ufcRes.value.events ?? []) {
            if (ev.state !== 'in') continue;
            for (const f of ev.fights) {
              if (f.state === 'in') ufc++;
            }
          }
        }
        setCounts({ nba, mlb, ufc });
      });
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  return counts;
}
