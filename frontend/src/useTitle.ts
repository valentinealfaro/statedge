import { useEffect } from 'react';

const BASE = 'StatEdge';

// Sets document.title for the duration of the calling component's mount.
// Restores the previous title on unmount so we don't leave a stale title
// behind when the user navigates away.
export function useTitle(parts: (string | null | undefined)[]) {
  useEffect(() => {
    const filtered = parts.filter((p): p is string => !!p && p.trim() !== '');
    const next = filtered.length === 0 ? BASE : `${filtered.join(' · ')} · ${BASE}`;
    const prev = document.title;
    document.title = next;
    return () => { document.title = prev; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, parts);
}
