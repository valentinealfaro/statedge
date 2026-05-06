# Firebase Auth setup

The auth wiring is in the codebase — sign-in button shows up in the
nav once these three steps are done.

## 1. Add a Web App to your Firebase project

1. Open the Firebase Console for the **Statedge** project.
2. Project settings (gear icon, top-left) → **Your apps**.
3. Click the `</>` (Web) button → register the app:
   - App nickname: `StatEdge Web`
   - **Don't** check "Also set up Firebase Hosting" (we deploy on Vercel).
4. After registering, you'll see a code block with a `firebaseConfig` object
   that looks like:

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "statedge-f5cb3.firebaseapp.com",
     projectId: "statedge-f5cb3",
     storageBucket: "statedge-f5cb3.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abcdef0123456789"
   };
   ```

   **Keep this open in another tab** — you'll paste the values in step 3.

## 2. Enable sign-in providers + authorized domains

Firebase Console → **Authentication** (left nav) → **Get started** if it's
the first time.

1. **Sign-in method** tab → click **Google** → toggle **Enable** → set the
   project support email → **Save**.
2. (Optional, recommended) Same tab → **Email/Password** → **Enable** → **Save**.
3. **Settings** tab → **Authorized domains** → make sure these are listed:
   - `localhost` (already there by default)
   - `statedge-frontend.vercel.app`
   - any custom domain you add later

## 3. Set environment variables in Vercel

Frontend project on Vercel → **Settings** → **Environment Variables**.
Add these four (Production + Preview + Development scopes):

| Name                          | Value                       |
| ----------------------------- | --------------------------- |
| `VITE_FIREBASE_API_KEY`       | `apiKey` from step 1        |
| `VITE_FIREBASE_AUTH_DOMAIN`   | `authDomain` from step 1    |
| `VITE_FIREBASE_PROJECT_ID`    | `projectId` from step 1     |
| `VITE_FIREBASE_APP_ID`        | `appId` from step 1         |

After saving, hit **Redeploy** on the latest deployment so the new env
gets baked into the build.

For local dev, also create `frontend/.env.local`:

```
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=statedge-f5cb3.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=statedge-f5cb3
VITE_FIREBASE_APP_ID=1:1234567890:web:abc...
```

(`.env.local` is in `.gitignore` so this isn't committed.)

## What "configured" looks like

- Sign-in button appears in the top-right of the navbar on Compare /
  Standings / Slate / Game pages.
- Clicking it opens a Google account chooser popup.
- After signing in, your avatar replaces the button. Clicking the avatar
  shows your name, email, and a **Sign out** button.

## What's NOT yet hooked up to auth

The sign-in works but we haven't yet migrated the existing per-device
features to be per-user:

- **Saved comparisons** are still keyed by browser localStorage.
- **Free-tier daily limit** still tracks per-device.
- **Recently viewed** still per-device.

Those migrations are the natural next step now that auth state exists.
The signed-in user's `uid` will replace the localStorage namespace, and
free-tier counter checks will hit a Firestore collection so the limit
follows the user across devices.

## Firebase config values are public

These four env vars are baked into the JS bundle that any visitor can
download — that's how Firebase Web SDK works. Security comes from the
**Authorized Domains** list (step 2.3) and per-provider config, NOT
from hiding the API key. Don't try to "secret" them.
