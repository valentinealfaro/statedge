// MMA routes — Phase 107a foundation.
//
// Just upcoming events for now. Future slices: pull moneyline + method-
// of-victory odds from The Odds API (already supports
// 'mma_mixed_martial_arts'), wire fight-night recap articles into the
// big-game cron, add fighter profile pages mirroring NBA/MLB.

import { Router } from 'express';
import { fetchUfcScoreboard } from '../mma/espn.js';
import { getUfcMoneylines } from '../mma/odds.js';
import {
  getLatestMmaDailySlate,
  getMmaDailySlate,
  setMmaDailySlate,
  type MmaStoredLine,
} from '../mma/slateStore.js';
import { listUfcStats } from '../mma/stats.js';
import { parseMmaSlateText } from '../services/mmaSlateTextParser.js';

export const mmaRouter: Router = Router();

// ET date helper. Mirrors the convention used by MLB slate code so
// "today's slate" rolls over at midnight ET, not UTC.
function todayEt(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

mmaRouter.get('/scoreboard', async (req, res) => {
  try {
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const events = await fetchUfcScoreboard({ startDate, endDate });
    res.json({
      events,
      count: events.length,
      // Bucket counts so the frontend can land on the right tab
      // without re-iterating the whole list.
      upcoming: events.filter((e) => e.state === 'pre').length,
      live: events.filter((e) => e.state === 'in').length,
      completed: events.filter((e) => e.state === 'post').length,
    });
  } catch (err) {
    console.error('mma/scoreboard failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/mma/odds — UFC moneylines from The Odds API. 12h cache so
// we don't burn through the 500-credit free tier. ?force=1 bypasses
// cache (admin-style toggle; doesn't require auth since the cost is
// 1 credit per upcoming-event market).
mmaRouter.get('/odds', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const result = await getUfcMoneylines({ force });
    res.json(result);
  } catch (err) {
    console.error('mma/odds failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/mma/stats — list of supported UFC stat keys + display
// metadata. Frontend uses this to render the slate paste help and
// the published-view group headers.
mmaRouter.get('/stats', (_req, res) => {
  res.json({ stats: listUfcStats() });
});

// POST /api/mma/slate/parse — preview parse of a pipe-format paste.
// No DB writes; returns parsed lines + unresolved errors so the
// admin can preview before publishing. Public (admin auth gates
// the publish step, not the preview).
mmaRouter.post('/slate/parse', (req, res) => {
  const text = (req.body?.text as string | undefined) ?? '';
  if (!text) {
    res.status(400).json({ error: 'text body required' });
    return;
  }
  const parsed = parseMmaSlateText(text);
  res.json(parsed);
});

// POST /api/mma/slate/publish — admin-gated. Parses + writes to
// mma_daily_slates for the given date (default today ET).
mmaRouter.post('/slate/publish', async (req, res) => {
  const expected = process.env.SLATE_ADMIN_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'SLATE_ADMIN_SECRET not configured' });
    return;
  }
  if (req.header('x-admin-secret') !== expected) {
    res.status(401).json({ error: 'admin secret required' });
    return;
  }

  const text = (req.body?.text as string | undefined) ?? '';
  const date = (req.body?.date as string | undefined) ?? todayEt();
  if (!text) {
    res.status(400).json({ error: 'text body required' });
    return;
  }

  const parsed = parseMmaSlateText(text);
  if (parsed.lines.length === 0) {
    res.status(400).json({
      error: 'no parseable lines',
      unresolved: parsed.unresolved,
    });
    return;
  }

  // Map ParsedMmaLine → MmaStoredLine (same shape today; future-
  // proofed in case we add resolved fighter ids).
  const stored: MmaStoredLine[] = parsed.lines.map((l) => ({
    fighterName: l.fighterName,
    league: l.league,
    statKey: l.statKey,
    line: l.line,
    direction: l.direction,
  }));

  try {
    await setMmaDailySlate({ date, lines: stored, rawText: text });
    res.json({
      ok: true,
      date,
      published: stored.length,
      unresolved: parsed.unresolved,
      skippedComments: parsed.skippedComments,
      skippedBlanks: parsed.skippedBlanks,
    });
  } catch (err) {
    console.error('mma/slate/publish failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/mma/slate/today — public view. Returns today's published
// slate (if any) — falls back to the most recent if today is empty
// so users between cards still see something. Both shapes include
// the published_date so the frontend can label "Today" vs "Most
// recent UFC card."
mmaRouter.get('/slate/today', async (_req, res) => {
  try {
    const today = todayEt();
    const slate = (await getMmaDailySlate(today)) ?? (await getLatestMmaDailySlate());
    res.json({
      today,
      slate,
    });
  } catch (err) {
    console.error('mma/slate/today failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

mmaRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', sport: 'mma', league: 'ufc' });
});
