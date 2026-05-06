// Admin / owner email allowlist. Anyone signed in with one of these
// emails is auto-Pro and bypasses the free-tier gate.
//
// Two sources, in order:
//   1. VITE_ADMIN_EMAILS env (CSV of emails, set in Vercel) — primary
//   2. Hardcoded fallback below — keeps the owner unlimited even
//      before the env is configured. Anyone with the source can see
//      these emails, but that's fine since the security guarantee
//      isn't "secret email list," it's "must sign in with that
//      Google account."
//
// To add or rotate teammates, set VITE_ADMIN_EMAILS=a@x.com,b@y.com
// in Vercel env (Production + Preview + Development) and redeploy.

const HARDCODED_FALLBACK = [
  'info@vcvservices.com',
];

function readEnvList(): string[] {
  const raw = import.meta.env.VITE_ADMIN_EMAILS;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

let cached: Set<string> | null = null;
function getList(): Set<string> {
  if (cached) return cached;
  const env = readEnvList();
  const all = env.length > 0 ? env : HARDCODED_FALLBACK.map((s) => s.toLowerCase());
  cached = new Set(all);
  return cached;
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getList().has(email.toLowerCase());
}
