import { useState } from 'react';
import { getAiSummary } from './api';
import { usePlan } from './plan';

type Props = {
  payload: unknown;
};

export function AiSummary({ payload }: Props) {
  const { plan } = usePlan();
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

  if (plan === 'free') {
    return (
      <div className="ai locked">
        <div className="ai-head">
          <h3>AI summary <span className="lock-pill">PRO</span></h3>
        </div>
        <p className="muted">
          AI-generated breakdowns of trends, matchups, consistency, and risk are a Pro feature.
          Upgrade to unlock — never betting picks, just analysis.
        </p>
      </div>
    );
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
