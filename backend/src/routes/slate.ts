import { Router } from 'express';
import multer from 'multer';
import { fetchPrizePicksNba } from '../services/slatePrizePicks.js';
import { resolveSlate, type RawLine, type ResolvedLine } from '../services/slatePipeline.js';
import { ocrPropBoard } from '../services/slateOcr.js';
import {
  getDailySlateFromDb,
  getPlayerGameLogsBulkFromDb,
  getSlateSnapshotFromDb,
  isDbConfigured,
  listSlateSnapshotsFromDb,
  setDailySlateInDb,
  setSlateResolvedInDb,
  snapshotSlateCombosInDb,
  type StoredSlateLine,
} from '../db.js';
import { currentSeason } from '../nba/client.js';
import { getGemini, GEMINI_MODEL } from '../services/gemini.js';
import { buildCombos, type Combo } from '../services/slateCombos.js';
import { gradeCombo, type GradedCombo } from '../services/slateGrade.js';

export const slateRouter: Router = Router();

// In-memory storage so we never write the screenshot to disk. The image
// stays in the request lifetime and is GC'd after the response is sent.
// 8MB cap is generous for any phone screenshot but rejects pathological
// uploads.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

// Pull the opponent abbreviation out of a PP `description` string
// like "PHI/NYK" given the player's team ("PHI"). Some entries use
// other separators or are blank — we fall back to null on any miss
// and the slate just skips the vs-opp block for that line.
function parseOpponent(description: string | null, team: string | null | undefined): string | null {
  if (!description || !team) return null;
  const parts = description.split(/[\/@]+|\s+vs\.?\s+/i).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (parts.length !== 2) return null;
  const t = team.toUpperCase();
  if (parts[0] === t) return parts[1]!;
  if (parts[1] === t) return parts[0]!;
  return null;
}

// Auto-fetch path: pull current PrizePicks NBA prop board, normalize
// stat labels, resolve player names, compute hit probability, return
// the same SlateResponse shape the (planned) image-upload path uses.
//
// CAVEAT: depends on PP's undocumented public API. May start returning
// 403 / 429 / a different schema with no warning. The frontend is
// expected to handle errors here and surface the upload alternative.
slateRouter.get('/auto', async (_req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Slate requires DB' });
    return;
  }

  try {
    const ppLines = await fetchPrizePicksNba();
    if (ppLines.length === 0) {
      res.json({ lines: [], unresolved: [], source: 'prizepicks_auto', fetchedAt: new Date().toISOString() });
      return;
    }
    // Convert PP-shape into the pipeline's RawLine shape. PP's
    // `description` is "AWAY/HOME" (e.g. "PHI/NYK"); the player is on
    // exactly one of those teams, so the OTHER one is the opponent.
    const raw: RawLine[] = ppLines.map((p) => {
      const opponent = parseOpponent(p.description, p.team);
      return {
        playerName: p.playerName,
        team: p.team,
        position: p.position,
        imageUrl: p.imageUrl,
        statLabel: p.statType,
        line: p.line,
        ppId: p.ppId,
        startTime: p.startTime,
        description: p.description,
        opponentAbbr: opponent,
      };
    });
    const out = await resolveSlate(raw, 'prizepicks_auto');
    // Browsers shouldn't cache an actively-changing prop board.
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  } catch (err) {
    console.error('slate/auto failed', err);
    res.status(502).json({
      error: 'PrizePicks auto-fetch failed',
      detail: (err as Error).message,
    });
  }
});

// Image-upload path: multipart screenshot in, structured slate out.
// Image is OCR'd via Gemini Vision (gemini-2.5-flash), then run through the
// same resolver+probability pipeline as the auto path. The image bytes
// live in memory for the request lifetime only — never persisted.
slateRouter.post('/parse-image', upload.single('image'), async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Slate requires DB' });
    return;
  }
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: 'multipart field "image" required' });
    return;
  }
  if (!file.mimetype.startsWith('image/')) {
    res.status(400).json({ error: 'file must be an image' });
    return;
  }

  try {
    const ocr = await ocrPropBoard(file.buffer, file.mimetype);
    if (ocr.raw.length === 0) {
      res.json({ lines: [], unresolved: [], source: 'image_upload', fetchedAt: new Date().toISOString() });
      return;
    }
    const out = await resolveSlate(ocr.raw, 'image_upload');
    res.json(out);
  } catch (err) {
    console.error('slate/parse-image failed', err);
    res.status(500).json({
      error: 'image parse failed',
      detail: (err as Error).message,
    });
  }
});

// AI analysis of a parlay slip. Frontend POSTs the resolved legs (so
// the LLM sees the per-leg stats it should reason over — no need to
// re-fetch DB), we ask gemini-2.5-flash for a concise paragraph:
// strongest pick, biggest risk, useful context. Single call regardless
// of leg count keeps the cost minimal.

const ANALYZE_SYSTEM = `You are a precise sports data analyst, not a tout.

You receive a list of NBA prop lines a user has built into a parlay.
Each leg includes: player, team vs opponent, stat type, the line, the
player's last-10 average, hit count vs the line, the lean direction,
the might-hit %, vs-opponent average if available, recent-form trend,
and any current injury status.

Write a SHORT paragraph (3-4 sentences max) that surfaces:
  1. Which leg is the strongest signal and why
  2. Which leg is the biggest risk (line vs L10 gap, injury,
     small vs-opp sample)
  3. One non-obvious cross-leg observation if present (e.g.,
     "three of the four legs lean over assists" or "this slip
     is heavy on guards against the same defense").

NEVER:
  - tell the user this is a good or bad bet
  - mention "lock", "guaranteed", "free money", or any betting language
  - reference odds or implied probability beyond what we provide
  - speculate beyond what the supplied stats support

Output is the paragraph itself, no headers, no preamble.`;

// Per-card insight — the "Why?" affordance on /slate. One ResolvedLine
// in, one short sentence out. Frontend caches per-card so each card is
// at most one Gemini call per page-load.
const INSIGHT_SYSTEM = `You are a precise sports data analyst, not a tout.

You receive a single NBA prop line with the player's recent context:
their L10 average, hit count above the line, lean direction, vs-opp
average if available, recent-form trend, and any injury status.

Write ONE concise sentence that surfaces the most important thing
about this line. Examples of the SHAPE we want:
  "Maxey averaged 26.1 over his last 10 — well above the 22.5 line —
   but the Knicks held him to 18 in their only meeting this season."
  "Embiid is listed Day-To-Day, so the 25.5 line is exposed even
   though his L10 avg sits at 28.3."

Hard rules:
  - One sentence, max ~30 words.
  - Use only the supplied stats — no speculation.
  - No betting language (no 'lock', 'guaranteed', 'free money', etc).
  - No 'I think' / 'I'd take' / 'I recommend'.
  - Just facts and the most relevant tension.`;

slateRouter.post('/insight', async (req, res) => {
  const ai = getGemini();
  if (!ai) {
    res.status(503).json({ error: 'AI insight unavailable: GEMINI_API_KEY not set' });
    return;
  }
  const line = req.body?.line;
  if (!line || typeof line !== 'object') {
    res.status(400).json({ error: 'body.line required (a ResolvedLine)' });
    return;
  }

  const r = line as ResolvedLine;
  const trimmed = {
    player: r.playerName,
    team: r.team,
    opp: r.vsOpponent?.opponentAbbr ?? null,
    stat: r.statLabel,
    line: r.line,
    L10_avg: r.last10Avg,
    hit_pct: r.hitProbability?.mightHitPct ?? null,
    lean: r.hitProbability?.lean ?? null,
    hit_over_count: r.hitProbability ? Math.round(r.hitProbability.hitOver * r.gamesAnalyzed) : null,
    games_analyzed: r.gamesAnalyzed,
    vs_opp_avg: r.vsOpponent?.avg ?? null,
    vs_opp_games: r.vsOpponent?.gamesPlayed ?? null,
    L5_avg: r.trend?.last5Avg ?? null,
    trend_delta: r.trend?.deltaVsL10 ?? null,
    injury: r.injury?.status ?? null,
  };

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Write the one-sentence insight for this line:\n' + JSON.stringify(trimmed, null, 2) }],
        },
      ],
      config: {
        systemInstruction: INSIGHT_SYSTEM,
        temperature: 0.3,
      },
    });
    const insight = (response.text ?? '').trim();
    res.json({ insight });
  } catch (err) {
    console.error('slate/insight failed', err);
    res.status(502).json({ error: 'insight request failed' });
  }
});

slateRouter.post('/analyze', async (req, res) => {
  const ai = getGemini();
  if (!ai) {
    res.status(503).json({ error: 'AI analysis unavailable: GEMINI_API_KEY not set' });
    return;
  }
  const legs = req.body?.legs;
  if (!Array.isArray(legs) || legs.length === 0) {
    res.status(400).json({ error: 'body.legs required (non-empty array)' });
    return;
  }
  if (legs.length > 8) {
    res.status(400).json({ error: 'too many legs (max 8)' });
    return;
  }

  // Project the resolved-line shape down to the fields the model
  // actually needs. Keeps the prompt focused and cheap.
  const trimmed = (legs as ResolvedLine[]).map((l) => ({
    player: l.playerName,
    team: l.team,
    opp: l.vsOpponent?.opponentAbbr ?? null,
    stat: l.statLabel,
    line: l.line,
    L10_avg: l.last10Avg,
    hit_pct: l.hitProbability?.mightHitPct ?? null,
    lean: l.hitProbability?.lean ?? null,
    hit_over_count: l.hitProbability ? Math.round(l.hitProbability.hitOver * l.gamesAnalyzed) : null,
    games_analyzed: l.gamesAnalyzed,
    vs_opp_avg: l.vsOpponent?.avg ?? null,
    vs_opp_games: l.vsOpponent?.gamesPlayed ?? null,
    L5_avg: l.trend?.last5Avg ?? null,
    trend_delta: l.trend?.deltaVsL10 ?? null,
    injury: l.injury?.status ?? null,
  }));

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Analyze this slip:\n' + JSON.stringify(trimmed, null, 2) }],
        },
      ],
      config: {
        systemInstruction: ANALYZE_SYSTEM,
        temperature: 0.3,
      },
    });
    const summary = (response.text ?? '').trim();
    res.json({ summary });
  } catch (err) {
    console.error('slate/analyze failed', err);
    res.status(502).json({ error: 'analysis request failed' });
  }
});

// JSON-body parse path. Used by:
//   - the unresolved-fix UI ("did you mean Jalen Brunson?") that
//     re-resolves a corrected name
//   - the new manual-entry mode (Build my own slate) that feeds in
//     player+stat+line tuples a user typed in directly
//
// Optional body.source flips the response source label to 'manual'
// when set; defaults to 'image_upload' for backwards compatibility
// with the OCR-fallback callers.
slateRouter.post('/parse', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Slate requires DB' });
    return;
  }
  const raw = req.body?.raw;
  if (!Array.isArray(raw)) {
    res.status(400).json({ error: 'body.raw must be an array of { playerName, statLabel, line }' });
    return;
  }
  const requestedSource =
    req.body?.source === 'manual' ? 'manual' : 'image_upload';
  // Minimal validation — we trust caller not to abuse, but reject
  // obviously malformed entries.
  const sanitized: RawLine[] = [];
  for (const r of raw) {
    if (typeof r?.playerName !== 'string' || typeof r?.statLabel !== 'string') continue;
    const line = Number(r.line);
    if (!Number.isFinite(line)) continue;
    sanitized.push({
      playerName: r.playerName,
      statLabel: r.statLabel,
      line,
      team: typeof r.team === 'string' ? r.team : undefined,
      position: typeof r.position === 'string' ? r.position : undefined,
      opponentAbbr: typeof r.opponentAbbr === 'string' ? r.opponentAbbr.toUpperCase() : null,
      direction: r.direction === 'over' || r.direction === 'under' ? r.direction : 'both',
    });
  }

  try {
    const out = await resolveSlate(sanitized, requestedSource);
    res.json(out);
  } catch (err) {
    console.error('slate/parse failed', err);
    res.status(500).json({ error: 'slate parse failed' });
  }
});

// In-process dedupe for the auto-publish path below. When tonight's
// slate hasn't been admin-pasted yet, the first visitor to hit
// /slate/today triggers a live PrizePicks pull and persist; while
// that's in flight, concurrent visitors await the same promise so
// we don't fire 10 PP requests when 10 tabs open at once.
let autoPublishInflight: Promise<StoredSlateLine[]> | null = null;

// Live-pull from PrizePicks → normalize → persist as today's slate.
// Used as the auto-fallback when no admin paste exists for today.
// Returns the lines that were persisted (empty array if PP returned
// nothing usable). Throws on PP errors so the caller can decide
// whether to surface or swallow.
async function autoPublishFromPrizePicks(): Promise<StoredSlateLine[]> {
  const ppLines = await fetchPrizePicksNba();
  const stored: StoredSlateLine[] = [];
  for (const p of ppLines) {
    if (!p.playerName || !p.statType) continue;
    if (!Number.isFinite(p.line) || p.line <= 0) continue;
    const opp = parseOpponent(p.description, p.team);
    stored.push({
      playerName: p.playerName,
      statLabel: p.statType,
      line: p.line,
      team: p.team || undefined,
      opponentAbbr: opp,
      direction: 'both',
    });
  }
  if (stored.length === 0) return [];
  await setDailySlateInDb(stored);
  return stored;
}

// Public daily slate. The admin can POST the day's prop sheet, but
// when no paste has happened yet we auto-pull from PrizePicks so
// visitors see tonight's lines without anyone having to publish.
// We auto-resolve on GET so the response carries fully populated
// cards (with model probabilities) ready to render.
slateRouter.get('/today', async (_req, res) => {
  if (!isDbConfigured()) {
    res.json({ slate: null, resolved: null });
    return;
  }
  try {
    let stored = await getDailySlateFromDb();

    // Empty-for-today → try the auto-publish fallback. PP can 403 from
    // Vercel egress IPs, so we treat any failure as "nothing to show"
    // and let the admin paste path remain available.
    if (!stored || stored.lines.length === 0) {
      try {
        if (!autoPublishInflight) {
          autoPublishInflight = autoPublishFromPrizePicks().finally(() => {
            autoPublishInflight = null;
          });
        }
        const lines = await autoPublishInflight;
        if (lines.length > 0) {
          stored = await getDailySlateFromDb();
        }
      } catch (err) {
        console.warn('slate/today auto-publish skipped:', (err as Error).message);
      }
    }

    if (!stored || stored.lines.length === 0) {
      res.json({ slate: null, resolved: null });
      return;
    }
    const raw: RawLine[] = stored.lines.map((l) => ({
      playerName: l.playerName,
      statLabel: l.statLabel,
      line: l.line,
      team: l.team,
      opponentAbbr: l.opponentAbbr ?? null,
      direction: l.direction ?? 'both',
    }));
    const resolved = await resolveSlate(raw, 'manual');

    // Lock today's pre-built parlays into slate_results on first fetch.
    // ON CONFLICT DO NOTHING in the helper means subsequent fetches
    // leave the snapshot untouched — every visitor sees the same
    // combos all day, and we have a stable record to grade later.
    // Best-effort: failure here must not break the slate response.
    try {
      const combos = buildCombos(resolved.lines);
      if (combos.length > 0) {
        await snapshotSlateCombosInDb(stored.date, combos);
      }
    } catch (snapErr) {
      console.warn('slate/today combo snapshot failed:', (snapErr as Error).message);
    }

    res.json({
      slate: { date: stored.date, count: stored.lines.length, updatedAt: stored.updatedAt },
      resolved,
    });
  } catch (err) {
    console.error('slate/today GET failed', err);
    res.status(500).json({ error: 'slate today failed' });
  }
});

// Admin write — replaces today's lines wholesale. Requires
// SLATE_ADMIN_SECRET env var to be set on the backend; the request
// must include x-admin-secret header. Any client can read, only an
// authenticated admin can write.
slateRouter.post('/today', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'Daily slate requires DB' });
    return;
  }
  const secret = process.env.SLATE_ADMIN_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'SLATE_ADMIN_SECRET not configured on server' });
    return;
  }
  const provided = req.header('x-admin-secret');
  if (provided !== secret) {
    res.status(401).json({ error: 'admin secret mismatch' });
    return;
  }
  const lines = req.body?.lines;
  if (!Array.isArray(lines)) {
    res.status(400).json({ error: 'body.lines must be an array' });
    return;
  }
  const sanitized: StoredSlateLine[] = [];
  for (const l of lines) {
    if (typeof l?.playerName !== 'string' || typeof l?.statLabel !== 'string') continue;
    const lineNum = Number(l.line);
    if (!Number.isFinite(lineNum) || lineNum <= 0) continue;
    const dir = l.direction === 'over' || l.direction === 'under' ? l.direction : 'both';
    sanitized.push({
      playerName: l.playerName,
      statLabel: l.statLabel,
      line: lineNum,
      team: typeof l.team === 'string' ? l.team : undefined,
      opponentAbbr: typeof l.opponentAbbr === 'string' ? l.opponentAbbr : null,
      direction: dir,
    });
  }
  try {
    const out = await setDailySlateInDb(sanitized);
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('slate/today POST failed', err);
    res.status(500).json({ error: 'slate today write failed' });
  }
});

// -----------------------------------------------------------------
// History: past pre-built parlays with win/loss against actual stats.
//
// Snapshots are written by /slate/today on first fetch each day. They
// stay ungraded until someone opens the History tab — at which point
// each entry whose games are final gets resolved against the cached
// player game logs and persisted back to slate_results.results.
//
// Two endpoints:
//   GET /slate/history          → list of recent days (lazy-grades on read)
//   GET /slate/history/:date    → single day with full leg detail
// -----------------------------------------------------------------

// Age threshold (in calendar days) past which we'll attempt to grade
// a snapshot. Tonight's slate has no actuals yet, so we skip it; once
// today rolls into yesterday (>=1 day old) we try to look up game logs.
function shouldAttemptGrade(date: string, todayEt: string): boolean {
  return date < todayEt;
}

function todayEtDate(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

// Grade a snapshot's combos against player_game_logs for the given
// date. Returns the GradedCombo[] and a flag indicating whether every
// leg has a final-game value (so we know whether to persist results).
async function gradeSnapshot(
  date: string,
  combos: Combo[],
): Promise<{ graded: GradedCombo[]; allResolved: boolean }> {
  // Collect every player_id we need to look up so we can do a single
  // bulk DB roundtrip rather than fanning out one query per leg.
  const playerIds = new Set<number>();
  for (const c of combos) for (const l of c.legs) playerIds.add(l.playerId);

  const gamesByPlayer = await getPlayerGameLogsBulkFromDb(
    Array.from(playerIds),
    currentSeason(),
  );

  const graded = combos.map((c) => gradeCombo(c, gamesByPlayer, date));
  // "Resolved" means no leg is still pending (no_game). If even one
  // leg is missing actuals, we treat the day as not-yet-final and skip
  // persisting — next viewer will retry. This handles late-night games
  // and game-log sync lag gracefully.
  const allResolved = graded.every((g) => g.pendingCount === 0);
  return { graded, allResolved };
}

slateRouter.get('/history', async (_req, res) => {
  if (!isDbConfigured()) {
    res.json({ days: [] });
    return;
  }
  try {
    const rows = await listSlateSnapshotsFromDb(30);
    const today = todayEtDate();

    // Lazy-grade any unresolved past day. Done sequentially to bound
    // DB load — 30 days × ~6 legs/combo is small enough that this is
    // fine, and gating by allResolved means after the first viewer per
    // day, subsequent calls just return the cached graded result.
    const days: Array<{
      date: string;
      status: 'pending' | 'resolved';
      combos: GradedCombo[] | Combo[];
      resolvedAt: string | null;
    }> = [];

    for (const row of rows) {
      const combos = (row.combos as Combo[]) ?? [];

      // Already graded → return cached results as-is.
      if (row.results && row.resolvedAt) {
        days.push({
          date: row.date,
          status: 'resolved',
          combos: row.results as GradedCombo[],
          resolvedAt: row.resolvedAt,
        });
        continue;
      }

      // Not yet ripe (today or future) → ship the ungraded combos.
      if (!shouldAttemptGrade(row.date, today)) {
        days.push({
          date: row.date,
          status: 'pending',
          combos,
          resolvedAt: null,
        });
        continue;
      }

      // Old enough to grade — try it.
      try {
        const { graded, allResolved } = await gradeSnapshot(row.date, combos);
        if (allResolved) {
          await setSlateResolvedInDb(row.date, graded);
          days.push({
            date: row.date,
            status: 'resolved',
            combos: graded,
            resolvedAt: new Date().toISOString(),
          });
        } else {
          // Game logs haven't fully synced for this date yet — return
          // the partially-graded view but don't persist (next viewer
          // will retry once the sync catches up).
          days.push({
            date: row.date,
            status: 'pending',
            combos: graded,
            resolvedAt: null,
          });
        }
      } catch (err) {
        console.warn('slate/history grade failed for', row.date, (err as Error).message);
        days.push({
          date: row.date,
          status: 'pending',
          combos,
          resolvedAt: null,
        });
      }
    }

    res.json({ days });
  } catch (err) {
    console.error('slate/history failed', err);
    res.status(500).json({ error: 'history fetch failed' });
  }
});

// Single-day detail view. Same lazy-grade behavior as the list endpoint.
slateRouter.get('/history/:date', async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: 'history requires DB' });
    return;
  }
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  try {
    const row = await getSlateSnapshotFromDb(date);
    if (!row) {
      res.status(404).json({ error: 'no snapshot for that date' });
      return;
    }
    const combos = (row.combos as Combo[]) ?? [];

    if (row.results && row.resolvedAt) {
      res.json({
        date: row.date,
        status: 'resolved' as const,
        combos: row.results as GradedCombo[],
        resolvedAt: row.resolvedAt,
      });
      return;
    }

    const today = todayEtDate();
    if (!shouldAttemptGrade(row.date, today)) {
      res.json({
        date: row.date,
        status: 'pending' as const,
        combos,
        resolvedAt: null,
      });
      return;
    }

    const { graded, allResolved } = await gradeSnapshot(row.date, combos);
    if (allResolved) {
      await setSlateResolvedInDb(row.date, graded);
    }
    res.json({
      date: row.date,
      status: allResolved ? ('resolved' as const) : ('pending' as const),
      combos: graded,
      resolvedAt: allResolved ? new Date().toISOString() : null,
    });
  } catch (err) {
    console.error('slate/history/:date failed', err);
    res.status(500).json({ error: 'history detail failed' });
  }
});

