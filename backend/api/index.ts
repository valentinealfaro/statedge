// Vercel serverless entry. Vercel auto-discovers api/*.ts as Functions.
// We initialize Express once at module load and forward requests to it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/app.js';

let appInstance: ReturnType<typeof createApp> | null = null;
let initError: unknown = null;

try {
  appInstance = createApp();
} catch (err) {
  initError = err;
  console.error('[statedge] failed to init Express app:', err);
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (initError || !appInstance) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'Backend failed to initialize',
        detail: initError instanceof Error ? initError.message : String(initError),
      }),
    );
    return;
  }
  return appInstance(req, res);
}
