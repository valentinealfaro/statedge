// Single source of truth for "whose localStorage are we reading."
// When a user signs in, every per-user feature (saved comparisons,
// daily-use counter, recently viewed) should namespace under their
// uid so two people sharing a device don't see each other's data.
// When signed out, we fall back to a device-keyed namespace.
//
// Modules consume this via:
//   userKey('statedge.saved')
//     // → 'statedge.saved:<uid>' when signed in
//     // → 'statedge.saved'         when signed out
//
// And subscribe to onUidChange() to re-read storage when auth state
// flips (sign-in / sign-out flips storage namespace and we need to
// re-render with the new view).

const UID_CHANGED = 'statedge:uid-changed';

let currentUid: string | null = null;

export function getUid(): string | null {
  return currentUid;
}

export function setUid(uid: string | null): void {
  if (currentUid === uid) return;
  currentUid = uid;
  window.dispatchEvent(new Event(UID_CHANGED));
}

export function userKey(base: string): string {
  return currentUid ? `${base}:${currentUid}` : base;
}

export function onUidChange(listener: () => void): () => void {
  window.addEventListener(UID_CHANGED, listener);
  return () => window.removeEventListener(UID_CHANGED, listener);
}
