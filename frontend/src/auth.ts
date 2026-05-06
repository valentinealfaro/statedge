// Auth state hook + helpers. Wraps firebase.ts so components don't
// import the SDK directly — keeps the dependency tree shallow and
// makes mocking easier if we ever add tests.

import { useEffect, useState } from 'react';
import {
  isAuthConfigured,
  signInWithGoogle,
  signOutCurrent,
  subscribeAuth,
} from './firebase';
import type { User } from 'firebase/auth';

export type AuthState = {
  // null = not signed in. undefined = still loading initial state.
  user: User | null | undefined;
  configured: boolean;
};

export function useAuth(): AuthState & {
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
} {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    if (!isAuthConfigured()) {
      setUser(null);
      return;
    }
    const unsub = subscribeAuth(setUser);
    return unsub;
  }, []);

  return {
    user,
    configured: isAuthConfigured(),
    signIn: async () => {
      try {
        await signInWithGoogle();
      } catch (err) {
        // Most "errors" here are popup-closed-by-user — silent is fine.
        // Propagate everything else so the UI can surface it.
        const code = (err as { code?: string }).code;
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
        throw err;
      }
    },
    signOut: signOutCurrent,
  };
}
