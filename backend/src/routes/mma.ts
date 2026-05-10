// MMA routes — Phase 107a foundation.
//
// Just upcoming events for now. Future slices: pull moneyline + method-
// of-victory odds from The Odds API (already supports
// 'mma_mixed_martial_arts'), wire fight-night recap articles into the
// big-game cron, add fighter profile pages mirroring NBA/MLB.

import { Router } from 'express';
import { fetchUfcScoreboard, fetchUfcFightCenter, type UfcEvent, type UfcFight } from '../mma/espn.js';
import { getUfcMoneylines } from '../mma/odds.js';
import { projectUfcProp } from '../mma/projectionEngine.js';
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

// GET /api/mma/fight/:eventId/:fightId
//
// Fight detail page data — pulls the matching event+fight out of
// the scoreboard listing and parallel-fetches each fighter's career
// bio + averages from ESPN's athletes endpoint. Returns all in one
// payload so the frontend renders the ESPN-style fight card without
// chained client-side fetches.
//
// Edge cache 30s — short enough that mid-fight state (round/result)
// updates land quickly while live fights are running, but long
// enough to dampen polling traffic for the bios (which don't move).
mmaRouter.get('/fight/:eventId/:fightId', async (req, res) => {
  try {
    const eventId = String(req.params.eventId ?? '');
    const fightId = String(req.params.fightId ?? '');
    if (!eventId || !fightId) {
      res.status(400).json({ error: 'eventId and fightId required' });
      return;
    }
    const events = await fetchUfcScoreboard();
    const event = events.find((e: UfcEvent) => e.id === eventId);
    if (!event) {
      res.status(404).json({ error: 'event not found' });
      return;
    }
    const fight = event.fights.find((f: UfcFight) => f.id === fightId);
    if (!fight) {
      res.status(404).json({ error: 'fight not found' });
      return;
    }
    // One fightcenter call returns BOTH fighters' bio + this-fight
    // live stats. Replaces the earlier per-athlete fan-out.
    const fc = await fetchUfcFightCenter(eventId, fightId);
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json({
      event: {
        id: event.id,
        name: event.name,
        shortName: event.shortName,
        date: event.date,
        state: event.state,
        venue: event.venue,
      },
      fight,
      bios: { red: fc.red, blue: fc.blue },
    });
  } catch (err) {
    console.error('mma/fight detail failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

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

// GET /api/mma/slate/projections
//
// Phase 148q. Returns today's UFC slate enriched with the moneyline-
// anchored projection engine's output (probability / edge / trap /
// fragility / projection value / rationale) per line. Same pipeline
// the cross-sport Elite builder runs internally — exposed here so
// /best-bets can include UFC alongside NBA + MLB once the frontend
// wires it up. Lines without a scoreboard pairing (rare; usually a
// late-replacement) are skipped: projectUfcProp needs the opponent
// to compute defensive context.
mmaRouter.get('/slate/projections', async (_req, res) => {
  try {
    const today = todayEt();
    const slate = (await getMmaDailySlate(today)) ?? (await getLatestMmaDailySlate());
    if (!slate) {
      res.json({ today, slate: null, projections: [] });
      return;
    }

    const [moneylinesResp, scoreboard] = await Promise.all([
      getUfcMoneylines().catch(() => ({ events: [] as Array<{ fighterA: { fighterName: string; fairProbability: number }; fighterB: { fighterName: string; fairProbability: number } }> })),
      fetchUfcScoreboard().catch(() => [] as UfcEvent[]),
    ]);

    // Same diacritic-strip used by crossSportEliteBuilder so that
    // PrizePicks paste names ('C. Carpenter', accents, etc.) line up
    // with Odds API + ESPN display names.
    const fighterNorm = (s: string) =>
      s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').replace(/\s+/g, ' ').trim();

    const fairByFighter = new Map<string, number>();
    for (const ev of moneylinesResp.events) {
      fairByFighter.set(fighterNorm(ev.fighterA.fighterName), ev.fighterA.fairProbability);
      fairByFighter.set(fighterNorm(ev.fighterB.fighterName), ev.fighterB.fairProbability);
    }

    const opponentByFighter = new Map<string, string>();
    for (const ev of scoreboard) {
      for (const f of ev.fights) {
        const red = f.fighters.red;
        const blue = f.fighters.blue;
        if (red?.displayName && blue?.displayName) {
          opponentByFighter.set(fighterNorm(red.displayName), blue.displayName);
          opponentByFighter.set(fighterNorm(blue.displayName), red.displayName);
        }
      }
    }

    const projections = slate.lines.flatMap((line) => {
      const norm = fighterNorm(line.fighterName);
      const opponent = opponentByFighter.get(norm);
      if (!opponent) return [];   // honest skip — no opponent context
      const fair = fairByFighter.get(norm) ?? null;
      try {
        const projection = projectUfcProp({
          fighterName: line.fighterName,
          opponentName: opponent,
          fairProbability: fair,
          statKey: line.statKey,
          line: line.line,
          direction: line.direction,
        });
        return [{
          fighterName: line.fighterName,
          opponentName: opponent,
          statKey: line.statKey,
          line: line.line,
          direction: line.direction,
          fairProbability: fair,
          ...projection,
        }];
      } catch (err) {
        console.warn('projectUfcProp failed', line.fighterName, line.statKey, (err as Error).message);
        return [];
      }
    });

    // 5-minute browser cache mirrors /api/slate (NBA) / /api/mlb/slate
    // freshness expectations. Edge functions / CDN absorb burst load.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ today, slate, projections });
  } catch (err) {
    console.error('mma/slate/projections failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

mmaRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', sport: 'mma', league: 'ufc' });
});
