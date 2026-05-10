// Starred props watchlist — Phase 148.
//
// Bloomberg-style "watchlist": users star any prop on the slate or
// Best Bets table, then see all their starred props in one place at
// /starred with live grading. Persists per-uid via localStorage so
// switching accounts doesn't bleed picks across users.
//
// Mirrors the savedParlays pattern (storage primitives + useStarredProps
// hook) for consistency. The starred record carries enough info to
// render the prop without round-tripping through a slate fetch — and
// to call /api/slate/live-grade for the live verdict.

import { useCallback, useEffect, useState } from 'react';
import { onUidChange, userKey } from './userKey';

export type Sport = 'nba' | 'mlb' | 'mma';

export type StarredProp = {
  /** Stable id: `${sport}-${playerId}-${statKey}-${line}-${direction}` */
  id: string;
  sport: Sport;
  playerId: number;
  // Optional alphanumeric ESPN athlete id for UFC fighters (whose ids
  // include letters and don't survive Number() coerce — playerId
  // collapses to 0). Live-grading code prefers this for the
  // scoreboard fighter match path. NBA + MLB starred props don't
  // carry it.
  espnAthleteId?: string;
  playerName: string;
  team: string | null;
  statKey: string;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  // Snapshot at time of starring — useful when the slate has rolled
  // off but the user still wants to see what they were tracking.
  snapshot: {
    probability: number;
    edgePercent: number;
    projection: number | null;
  };
  starredAt: number;
};

const KEY_BASE = 'statedge.starred-props';
const MAX = 50;

export function makeStarredId(sport: Sport, playerId: number, statKey: string, line: number, direction: 'OVER' | 'UNDER'): string {
  return `${sport}-${playerId}-${statKey}-${line}-${direction}`;
}

function read(): StarredProp[] {
  try {
    const raw = localStorage.getItem(userKey(KEY_BASE));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StarredProp[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(items: StarredProp[]): void {
  try { localStorage.setItem(userKey(KEY_BASE), JSON.stringify(items)); }
  catch { /* ignore — quota exceeded or storage disabled */ }
}

export function useStarredProps() {
  const [items, setItems] = useState<StarredProp[]>(() => read());

  useEffect(() => {
    const sync = () => setItems(read());
    window.addEventListener('storage', sync);
    const unsubUid = onUidChange(sync);
    return () => {
      window.removeEventListener('storage', sync);
      unsubUid();
    };
  }, []);

  const isStarred = useCallback((id: string) => {
    return items.some((p) => p.id === id);
  }, [items]);

  const star = useCallback((prop: Omit<StarredProp, 'id' | 'starredAt'>) => {
    const id = makeStarredId(prop.sport, prop.playerId, prop.statKey, prop.line, prop.direction);
    // Idempotent — re-starring an existing prop just refreshes its
    // snapshot + bumps the starred-at timestamp to the front.
    const existing = read().filter((p) => p.id !== id);
    const next: StarredProp = { ...prop, id, starredAt: Date.now() };
    const merged = [next, ...existing].slice(0, MAX);
    write(merged);
    setItems(merged);
    return next;
  }, []);

  const unstar = useCallback((id: string) => {
    const next = read().filter((p) => p.id !== id);
    write(next);
    setItems(next);
  }, []);

  const toggle = useCallback((prop: Omit<StarredProp, 'id' | 'starredAt'>) => {
    const id = makeStarredId(prop.sport, prop.playerId, prop.statKey, prop.line, prop.direction);
    const exists = read().some((p) => p.id === id);
    if (exists) {
      const next = read().filter((p) => p.id !== id);
      write(next);
      setItems(next);
    } else {
      const next: StarredProp = { ...prop, id, starredAt: Date.now() };
      const merged = [next, ...read().filter((p) => p.id !== id)].slice(0, MAX);
      write(merged);
      setItems(merged);
    }
  }, []);

  const clear = useCallback(() => {
    write([]);
    setItems([]);
  }, []);

  return { items, isStarred, star, unstar, toggle, clear };
}
