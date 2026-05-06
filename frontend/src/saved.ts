// LocalStorage-backed "Saved comparisons" — per the spec, this is a Pro feature.
// Storing the entity objects (Player / Team) directly so we can rehydrate the
// whole matchup without an extra fetch.

import { useCallback, useEffect, useState } from 'react';
import type { Player, Team } from './api';
import { onUidChange, userKey } from './userKey';

export type SavedItem =
  | { id: string; type: 'pvt'; player: Player; team: Team; savedAt: number }
  | { id: string; type: 'pvp'; a: Player; b: Player; savedAt: number }
  | { id: string; type: 'tvt'; a: Team; b: Team; savedAt: number }
  | { id: string; type: 'last10'; player: Player; savedAt: number };

// Distributive Omit so each variant of the discriminated union keeps its
// own shape after dropping the runtime fields. (Plain Omit collapses to
// only the common keys.)
export type SavedDraft =
  SavedItem extends infer U ? U extends SavedItem ? Omit<U, 'id' | 'savedAt'> : never : never;

const KEY_BASE = 'statedge.saved';
const MAX_ITEMS = 50;

function read(): SavedItem[] {
  try {
    const raw = localStorage.getItem(userKey(KEY_BASE));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function write(items: SavedItem[]) {
  try { localStorage.setItem(userKey(KEY_BASE), JSON.stringify(items)); } catch { /* ignore */ }
}

// Identity by content so re-saving the same matchup updates the timestamp
// instead of stacking duplicates.
function contentKey(item: SavedDraft): string {
  switch (item.type) {
    case 'pvt':    return `pvt:${item.player.id}:${item.team.id}`;
    case 'pvp':    return `pvp:${item.a.id}:${item.b.id}`;
    case 'tvt':    return `tvt:${item.a.id}:${item.b.id}`;
    case 'last10': return `last10:${item.player.id}`;
  }
}

export function describeItem(item: SavedItem): string {
  switch (item.type) {
    case 'pvt':    return `${item.player.fullName} vs ${item.team.abbreviation}`;
    case 'pvp':    return `${item.a.fullName} vs ${item.b.fullName}`;
    case 'tvt':    return `${item.a.abbreviation} vs ${item.b.abbreviation}`;
    case 'last10': return `${item.player.fullName} · last 10`;
  }
}

export function useSavedComparisons() {
  const [items, setItems] = useState<SavedItem[]>(() => read());

  useEffect(() => {
    const sync = () => setItems(read());
    window.addEventListener('storage', sync);
    const unsubUid = onUidChange(sync);
    return () => {
      window.removeEventListener('storage', sync);
      unsubUid();
    };
  }, []);

  const save = useCallback((draft: SavedDraft) => {
    const key = contentKey(draft);
    const now = Date.now();
    const others = read().filter((existing) => contentKey(existing) !== key);
    const fresh: SavedItem = { ...draft, id: key, savedAt: now } as SavedItem;
    const next = [fresh, ...others].slice(0, MAX_ITEMS);
    write(next);
    setItems(next);
  }, []);

  const remove = useCallback((id: string) => {
    const next = read().filter((i) => i.id !== id);
    write(next);
    setItems(next);
  }, []);

  const has = useCallback((draft: SavedDraft): boolean => {
    const key = contentKey(draft);
    return read().some((i) => i.id === key);
  }, []);

  return { items, save, remove, has };
}
