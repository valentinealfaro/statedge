import { Router } from 'express';
import { getGemini, GEMINI_MODEL } from '../services/gemini.js';

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

aiRouter.post('/summary', async (req, res) => {
  const ai = getGemini();
  if (!ai) {
    res
      .status(503)
      .json({ error: 'AI summaries unavailable: set GEMINI_API_KEY in env to enable.' });
    return;
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'JSON body with comparison context required' });
    return;
  }

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'Analyze this comparison data and return the requested 5-section breakdown. Data:\n' +
                JSON.stringify(payload, null, 2),
            },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.4,
      },
    });

    const summary = response.text ?? '';
    res.json({ summary });
  } catch (err) {
    console.error('ai/summary failed', err);
    res.status(502).json({ error: 'AI request failed' });
  }
});
