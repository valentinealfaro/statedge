// OCR-by-Vision: send a screenshot to GPT-4o-mini and ask for structured
// {playerName, statLabel, line}[] back. Far more reliable than Tesseract
// on stylized prop boards (dark backgrounds, custom fonts, photos).

import OpenAI from 'openai';
import type { RawLine } from './slatePipeline.js';

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (client) return client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  client = new OpenAI({ apiKey: key });
  return client;
}

const SYSTEM = `You are a precise data extractor.
You receive a screenshot of a sports prop board (PrizePicks, Underdog,
DraftKings Pick6, etc).
Extract every player+stat+line you can see.

Output valid JSON only — no commentary, no code fences.

Schema:
{
  "lines": [
    { "playerName": "First Last", "statLabel": "Points|Rebounds|Pts+Rebs+Asts|3-PT Made|Steals|Blocked Shots|Turnovers|Pts+Asts|Pts+Rebs|Rebs+Asts|FG Made|Free Throws Made|Personal Fouls|Blks+Stls|Double-Double", "line": 24.5, "team": "LAL" }
  ]
}

Rules:
- "playerName": full name, exactly as printed (do not invent middle names).
- "statLabel": match one of the values listed above. Map common abbreviations
  back to the canonical form ("PRA" -> "Pts+Rebs+Asts", "PR" -> "Pts+Rebs",
  "Threes" -> "3-PT Made", etc).
- "line": numeric line value (e.g., 24.5, not "24.5+").
- "team": 2-3 letter team abbreviation if visible (LAL, BOS, GSW), else omit.
- Only include single-player props. Skip combos like "Brunson + Embiid".
- Skip "Live" / "Pre-game" / promotional banners.
- If you can't read a line clearly, skip it — don't guess.`;

export type OcrResult = {
  raw: RawLine[];
  modelUsed: string;
};

export async function ocrPropBoard(
  imageBuffer: Buffer,
  mimeType: string,
): Promise<OcrResult> {
  const c = getClient();
  if (!c) {
    throw new Error('OCR requires OPENAI_API_KEY');
  }

  const b64 = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${b64}`;

  const completion = await c.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract the prop lines from this screenshot.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
        ],
      },
    ],
    temperature: 0.0,
  });

  const text = completion.choices[0]?.message?.content ?? '{}';
  let parsed: { lines?: unknown };
  try {
    parsed = JSON.parse(text) as { lines?: unknown };
  } catch (err) {
    throw new Error(`OCR returned invalid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed.lines)) {
    return { raw: [], modelUsed: 'gpt-4o-mini' };
  }

  const raw: RawLine[] = [];
  for (const item of parsed.lines) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.playerName !== 'string' || typeof o.statLabel !== 'string') continue;
    const line = Number(o.line);
    if (!Number.isFinite(line)) continue;
    raw.push({
      playerName: o.playerName,
      statLabel: o.statLabel,
      line,
      team: typeof o.team === 'string' ? o.team : undefined,
    });
  }

  return { raw, modelUsed: 'gpt-4o-mini' };
}
