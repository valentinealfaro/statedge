import { useEffect, useRef, useState } from 'react';
import { useAuth } from './auth';

// Top-right of the navbar. Three states:
//   - auth not configured: nothing rendered (we don't want a dead button
//     in environments where Firebase env vars aren't set yet)
//   - configured + signed-out: 'Sign in' button
//   - configured + signed-in: avatar + dropdown with email and sign-out
export function UserMenu() {
  const { user, configured, signIn, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  // Close dropdown on outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  if (!configured) return null;
  if (user === undefined) return null;       // still loading initial auth state

  if (!user) {
    return (
      <button
        className="usermenu-signin"
        onClick={async () => {
          setBusy(true);
          try { await signIn(); }
          catch (e) { console.error('sign-in failed', e); }
          finally { setBusy(false); }
        }}
        disabled={busy}
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    );
  }

  const initial = (user.displayName ?? user.email ?? '?')[0]!.toUpperCase();

  return (
    <div className="usermenu" ref={wrapRef}>
      <button
        className="usermenu-trigger"
        onClick={() => setOpen((v) => !v)}
        title={user.displayName ?? user.email ?? 'Account'}
        aria-expanded={open}
      >
        {user.photoURL
          ? <img className="usermenu-photo" src={user.photoURL} alt={user.displayName ?? ''} />
          : <span className="usermenu-initial">{initial}</span>
        }
      </button>
      {open && (
        <div className="usermenu-dropdown">
          <div className="usermenu-name">{user.displayName ?? 'Signed in'}</div>
          <div className="usermenu-email">{user.email}</div>
          <button
            className="usermenu-signout"
            onClick={async () => {
              setOpen(false);
              await signOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
