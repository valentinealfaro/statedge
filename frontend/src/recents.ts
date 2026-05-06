// Auto-tracked "recently viewed" comparisons. Different from saved.ts:
// - free users get this too (it's not a Pro feature)
// - capped much shorter (10) — it's history, not a curated list
// - written automatically when a comparison view mounts, not via a button
//
// Same shape as SavedItem so the rest of the app can reuse describeItem()
// and the Compare-page "open" logic.

import { useCallback, useEffect, useState } from 'react';
import type { SavedDraft, SavedItem } from './saved';
import { onUidChange, userKey } from './userKey';

const KEY_BASE = 'statedge.recents';
const MAX = 10;

function read(): SavedItem[] {
  try {
    const raw = localStorage.getItem(userKey(KEY_BASE));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(items: SavedItem[]) {
  try { localStorage.setItem(userKey(KEY_BASE), JSON.stringify(items)); } catch { /* ignore */ }
}

function contentKey(item: SavedDraft): string {
  switch (item.type) {
    case 'pvt':    return `pvt:${item.player.id}:${item.team.id}`;
    case 'pvp':    return `pvp:${item.a.id}:${item.b.id}`;
    case 'tvt':    return `tvt:${item.a.id}:${item.b.id}`;
    case 'last10': return `last10:${item.player.id}`;
  }
}

// Module-scoped throttle: a comparison view's effect can run twice in
// React 18 strict mode and fire on quick remounts; we don't want each
// to count as a separate "recent" entry. Same key within 2s = ignored.
const lastWrite = new Map<string, number>();

export function recordRecent(draft: SavedDraft): void {
  const key = contentKey(draft);
  const now = Date.now();
  const prev = lastWrite.get(key) ?? 0;
  if (now - prev < 2000) return;
  lastWrite.set(key, now);

  const others = read().filter((existing) => existing.id !== key);
  const fresh: SavedItem = { ...draft, id: key, savedAt: now } as SavedItem;
  const next = [fresh, ...others].slice(0, MAX);
  write(next);
  // Storage event doesn't fire in the same tab — broadcast manually so the
  // recents list re-renders without a refresh.
  window.dispatchEvent(new Event('statedge:recents-changed'));
}

export function useRecents() {
  const [items, setItems] = useState<SavedItem[]>(() => read());

  useEffect(() => {
    const sync = () => setItems(read());
    window.addEventListener('storage', sync);
    window.addEventListener('statedge:recents-changed', sync);
    const unsubUid = onUidChange(sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('statedge:recents-changed', sync);
      unsubUid();
    };
  }, []);

  const clear = useCallback(() => {
    write([]);
    setItems([]);
    window.dispatchEvent(new Event('statedge:recents-changed'));
  }, []);

  return { items, clear };
}
