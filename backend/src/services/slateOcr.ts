// OCR-by-Vision: send a screenshot to Gemini and ask for structured
// {playerName, statLabel, line}[] back. Far more reliable than
// Tesseract on stylized prop boards (dark backgrounds, custom fonts,
// player headshots).

import { Type } from '@google/genai';
import { getGemini, GEMINI_MODEL } from './gemini.js';
import type { RawLine } from './slatePipeline.js';

const SYSTEM = `You are a precise data extractor.
You receive a screenshot of a sports prop board (PrizePicks, Underdog,
DraftKings Pick6, etc).
Extract every player+stat+line you can see.

Rules:
- "playerName": full name, exactly as printed (do not invent middle names).
- "statLabel": map to one of:
  Points, Rebounds, Pts+Rebs+Asts, 3-PT Made, Steals, Blocked Shots,
  Turnovers, Pts+Asts, Pts+Rebs, Rebs+Asts, FG Made, Free Throws Made,
  Personal Fouls, Blks+Stls, Double-Double.
  Map common abbreviations back to the canonical form ("PRA" -> "Pts+Rebs+Asts",
  "PR" -> "Pts+Rebs", "Threes" -> "3-PT Made").
- "line": numeric line value (e.g., 24.5, not "24.5+").
- "team": 2-3 letter team abbreviation if visible (LAL, BOS, GSW), else omit.
- "opponent": 2-3 letter abbreviation of tonight's opposing team if visible
  ("vs DEN", "@ DEN", "LAL/DEN"); omit if not visible.
- Only include single-player props. Skip combos like "Brunson + Embiid".
- Skip "Live" / "Pre-game" / promotional banners.
- If you can't read a line clearly, skip it — don't guess.

Output valid JSON conforming to the schema.`;

// Strict response schema so Gemini always returns the same shape.
// Gemini's structured-output mode validates against this server-side.
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    lines: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          playerName: { type: Type.STRING },
          statLabel:  { type: Type.STRING },
          line:       { type: Type.NUMBER },
          team:       { type: Type.STRING },
          opponent:   { type: Type.STRING },
        },
        required: ['playerName', 'statLabel', 'line'],
        propertyOrdering: ['playerName', 'statLabel', 'line', 'team', 'opponent'],
      },
    },
  },
  required: ['lines'],
} as const;

export type OcrResult = {
  raw: RawLine[];
  modelUsed: string;
};

export async function ocrPropBoard(
  imageBuffer: Buffer,
  mimeType: string,
): Promise<OcrResult> {
  const ai = getGemini();
  if (!ai) {
    throw new Error('OCR requires GEMINI_API_KEY');
  }

  const b64 = imageBuffer.toString('base64');

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: b64 } },
          { text: 'Extract the prop lines from this screenshot.' },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM,
      temperature: 0.0,
      responseMimeType: 'application/json',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responseSchema: RESPONSE_SCHEMA as any,
    },
  });

  const text = (response.text ?? '{}').trim();
  let parsed: { lines?: unknown };
  try {
    parsed = JSON.parse(text) as { lines?: unknown };
  } catch (err) {
    throw new Error(`OCR returned invalid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed.lines)) {
    return { raw: [], modelUsed: GEMINI_MODEL };
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
      opponentAbbr:
        typeof o.opponent === 'string' && o.opponent.length > 0
          ? o.opponent.toUpperCase()
          : null,
    });
  }

  return { raw, modelUsed: GEMINI_MODEL };
}
