// Shared Gemini client. Lazy-init from GEMINI_API_KEY env var so any
// service that needs LLM access can call getGemini() without bothering
// with apiKey threading.
//
// Default model is gemini-2.5-flash — fast, cheap (~$0.10 per 1M input
// tokens, ~$0.40 per 1M output), supports vision via inlineData parts,
// supports structured-JSON output via responseMimeType. Suits all
// three current use cases (text summary, parlay analysis, image OCR).

import { GoogleGenAI } from '@google/genai';

let cached: GoogleGenAI | null = null;

export function getGemini(): GoogleGenAI | null {
  if (cached) return cached;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  cached = new GoogleGenAI({ apiKey });
  return cached;
}

// Default model used by all of our endpoints. Bumping it here flips
// every call site at once.
export const GEMINI_MODEL = 'gemini-2.5-flash';
