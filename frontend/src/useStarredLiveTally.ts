// useStarredLiveTally — Phase 148h.
//
// Polls live grading for the user's starred props and returns a roll-up
// suitable for a navbar badge: total props live (including final/settled
// today), and per-state counts (hit / live / miss). Used by NavBar to
// surface "★ 3" with a red pulse when something the user is following
// has resolved or is in flight.
//
// Cheap because:
//  - Reads from useStarredProps (localStorage-backed, free)
//  - One bulk POST to /api/slate/live-grade per minute
//  - Caps at 50 starred props per-poll to match server-side limit
//
// All three sports grade now (NBA + MLB + UFC). UFC stat keys outside
// the supported set (sig_strikes, takedowns, knockdowns, control_time)
// return UNGRADED honestly — those count as `pending` in the tally,
// which is the correct behavior for "we have no live signal yet".

import { useEffect, useState } from 'react';
import { liveGradeLegs, type EliteLegLiveState } from './api';
import { useStarredProps } from './starredProps';

export type StarredLiveTally = {
  total: number;       // total starred props the user has
  hit: number;
  liveInFlight: number;
  miss: number;
  pending: number;
};

export function useStarredLiveTally(): StarredLiveTally {
  const { items } = useStarredProps();
  const [states, setStates] = useState<Map<string, EliteLegLiveState>>(new Map());

  // Cap at 50 to match the server-side /live-grade limit. All sports
  // grade now — UFC props with unsupported stat keys come back UNGRADED
  // and roll up into `pending`, which is the honest verdict for "no
  // live signal".
  const gradable = items.slice(0, 50);
  const sig = gradable.map((p) => p.id).join('|');

  useEffect(() => {
    if (gradable.length === 0) { setStates(new Map()); return; }
    let cancelled = false;
    const tick = () => {
      const payload = gradable.map((p) => ({
        playerId: p.playerId,
        espnAthleteId: p.espnAthleteId,
        playerName: p.playerName,
        statKey: p.statKey,
        direction: p.direction,
        line: p.line,
      }));
      liveGradeLegs(payload)
        .then((legs) => {
          if (cancelled) return;
          const m = new Map<string, EliteLegLiveState>();
          for (let i = 0; i < legs.length; i++) {
            m.set(gradable[i]!.id, legs[i]!);
          }
          setStates(m);
        })
        .catch(() => { /* silent — badge falls back to 0 counts */ });
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [sig]);   // eslint-disable-line react-hooks/exhaustive-deps

  let hit = 0;
  let liveInFlight = 0;
  let miss = 0;
  let pending = 0;
  for (const p of items) {
    const s = states.get(p.id);
    if (!s) { pending++; continue; }
    const v = s.verdict;
    if (v === 'HIT' || v === 'ON_PACE_HIT') hit++;
    else if (v === 'IN_FLIGHT') liveInFlight++;
    else if (v === 'MISS' || v === 'ON_PACE_MISS' || v === 'PUSH') miss++;
    else pending++;
  }
  return { total: items.length, hit, liveInFlight, miss, pending };
}
