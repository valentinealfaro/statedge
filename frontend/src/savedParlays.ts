// Pro-only saved parlays. Stored per-user (uid-scoped via userKey.ts)
// so signing in pulls your slips, signing out hides them. Each slip
// remembers the leg identifiers (playerId-statKey-line) the user
// curated and a friendly label.
//
// Stored separately from the Saved comparisons system because the
// shape is different (an array of legs vs. a single matchup) and the
// UX surface is local to /slate.

import { useCallback, useEffect, useState } from 'react';
import { onUidChange, userKey } from './userKey';

export type SavedParlay = {
  id: string;
  name: string;
  // Leg identifiers in the same format the URL `legs=` param uses:
  // "<playerId>-<statKey>-<line>". Lets us re-apply by writing the
  // string into the URL on open.
  legs: string[];
  savedAt: number;
};

const KEY_BASE = 'statedge.parlays';
const MAX = 50;

function read(): SavedParlay[] {
  try {
    const raw = localStorage.getItem(userKey(KEY_BASE));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedParlay[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(items: SavedParlay[]): void {
  try { localStorage.setItem(userKey(KEY_BASE), JSON.stringify(items)); }
  catch { /* ignore */ }
}

export function useSavedParlays() {
  const [items, setItems] = useState<SavedParlay[]>(() => read());

  useEffect(() => {
    const sync = () => setItems(read());
    window.addEventListener('storage', sync);
    const unsubUid = onUidChange(sync);
    return () => {
      window.removeEventListener('storage', sync);
      unsubUid();
    };
  }, []);

  const save = useCallback((name: string, legs: string[]) => {
    const trimmed = name.trim() || `${legs.length}-leg parlay`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next: SavedParlay = { id, name: trimmed, legs, savedAt: Date.now() };
    const merged = [next, ...read()].slice(0, MAX);
    write(merged);
    setItems(merged);
    return next;
  }, []);

  const remove = useCallback((id: string) => {
    const next = read().filter((p) => p.id !== id);
    write(next);
    setItems(next);
  }, []);

  const rename = useCallback((id: string, name: string) => {
    const next = read().map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p));
    write(next);
    setItems(next);
  }, []);

  return { items, save, remove, rename };
}
