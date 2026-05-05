import { Router } from 'express';
import OpenAI from 'openai';

export const aiRouter: Router = Router();

const SYSTEM_PROMPT = `You are a professional sports data analyst.

Do NOT give betting advice.

Analyze:
- trends
- matchups
- consistency
- performance

Return:
1. Summary
2. Trends
3. Breakdown
4. Risks
5. Insight`;

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (client) return client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  client = new OpenAI({ apiKey: key });
  return client;
}

aiRouter.post('/summary', async (req, res) => {
  const c = getClient();
  if (!c) {
    res
      .status(503)
      .json({ error: 'AI summaries unavailable: set OPENAI_API_KEY in backend/.env to enable.' });
    return;
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'JSON body with comparison context required' });
    return;
  }

  try {
    const completion = await c.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            'Analyze this comparison data and return the requested 5-section breakdown. Data:\n' +
            JSON.stringify(payload, null, 2),
        },
      ],
      temperature: 0.4,
    });
    const summary = completion.choices[0]?.message?.content ?? '';
    res.json({ summary });
  } catch (err) {
    console.error('ai/summary failed', err);
    res.status(502).json({ error: 'AI request failed' });
  }
});
