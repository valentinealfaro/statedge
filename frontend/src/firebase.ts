// Firebase Web SDK init. Reads config from VITE_FIREBASE_* env vars at
// build time (Vite inlines them). When any required field is missing
// — e.g. local dev without `.env.local`, or before the user has set
// the Vercel env vars — the auth module is disabled and the rest of
// the app keeps working without it.
//
// IMPORTANT: these env values are PUBLIC. They get baked into the JS
// bundle anyone can download. Firebase security comes from the
// Authorized Domains list (Firebase Console > Auth > Settings) +
// per-provider config + Firestore security rules — NOT from hiding
// these strings.

import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';

type FirebaseEnv = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
};

function readEnv(): FirebaseEnv | null {
  const apiKey     = import.meta.env.VITE_FIREBASE_API_KEY;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
  const projectId  = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const appId      = import.meta.env.VITE_FIREBASE_APP_ID;
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return { apiKey, authDomain, projectId, appId };
}

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let initState: 'pending' | 'ready' | 'disabled' = 'pending';

function ensureInit(): Auth | null {
  if (initState === 'disabled') return null;
  if (authInstance) return authInstance;
  const env = readEnv();
  if (!env) {
    initState = 'disabled';
    return null;
  }
  app = initializeApp(env);
  authInstance = getAuth(app);
  initState = 'ready';
  return authInstance;
}

export function isAuthConfigured(): boolean {
  return readEnv() !== null;
}

export function subscribeAuth(cb: (user: User | null) => void): () => void {
  const auth = ensureInit();
  if (!auth) {
    cb(null);
    return () => {};
  }
  return onAuthStateChanged(auth, cb);
}

export async function signInWithGoogle(): Promise<User | null> {
  const auth = ensureInit();
  if (!auth) throw new Error('Firebase auth is not configured');
  const provider = new GoogleAuthProvider();
  // Always show account chooser so a multi-account user can pick.
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOutCurrent(): Promise<void> {
  const auth = ensureInit();
  if (!auth) return;
  await signOut(auth);
}

// Get the current user's ID token for backend verification. Throws if
// not signed in. Backend routes that need auth call admin SDK to
// verify; we don't have that wiring yet, but the helper is ready.
export async function getIdToken(): Promise<string | null> {
  const auth = ensureInit();
  if (!auth?.currentUser) return null;
  return auth.currentUser.getIdToken();
}
