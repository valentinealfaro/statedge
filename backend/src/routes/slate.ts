import { Router } from 'express';
import multer from 'multer';
import { fetchPrizePicksNba } from '../services/slatePrizePicks.js';
import { resolveSlate, type RawLine } from '../services/slatePipeline.js';
import { ocrPropBoard } from '../services/slateOcr.js';
import { isDbConfigured } from '../db.js';

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
// Image is OCR'd via OpenAI Vision (gpt-4o-mini), then run through the
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

// Override path: takes a JSON body of pre-extracted raw lines — used
// when the user fixes an unresolved entry in the UI ("did you mean
// Jalen Brunson?") and we want to re-resolve just that one line.
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
    });
  }

  try {
    const out = await resolveSlate(sanitized, 'image_upload');
    res.json(out);
  } catch (err) {
    console.error('slate/parse failed', err);
    res.status(500).json({ error: 'slate parse failed' });
  }
});
