import { useState } from 'react';
import { getAiSummary } from './api';

type Props = {
  payload: unknown;
};

export function AiSummary({ payload }: Props) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setSummary(null);
    try {
      const data = await getAiSummary(payload);
      setSummary(data.summary);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ai">
      <div className="ai-head">
        <h3>AI summary</h3>
        <button className="primary" onClick={run} disabled={loading}>
          {loading ? 'Analyzing…' : summary ? 'Regenerate' : 'Generate AI summary'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {summary && <pre className="ai-body">{summary}</pre>}
    </div>
  );
}
