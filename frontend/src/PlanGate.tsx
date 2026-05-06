import { useState } from 'react';
import { downgradeToFree, FREE_DAILY_LIMIT, unlockPro, usePlan } from './plan';

// Shown above the Compare flows. Three states:
//  - Pro: small badge + "manage" link
//  - Free with budget: count remaining + upgrade CTA
//  - Free out of budget: blocking card with unlock code input
export function PlanGate() {
  const { plan, remaining, usageToday, refresh } = usePlan();
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState<string | null>(null);

  function tryUnlock() {
    const ok = unlockPro(code);
    if (!ok) {
      setCodeErr('Code not recognized');
      return;
    }
    setCode('');
    setCodeErr(null);
    refresh();
  }

  if (plan === 'pro') {
    return (
      <div className="plan-bar pro">
        <span className="plan-tag">PRO</span>
        <span className="plan-msg">Unlimited comparisons + AI summaries</span>
        <button
          className="link"
          onClick={() => { downgradeToFree(); refresh(); }}
        >
          Switch to Free
        </button>
      </div>
    );
  }

  if (remaining > 0) {
    return (
      <div className="plan-bar free">
        <span className="plan-tag free-tag">FREE</span>
        <span className="plan-msg">
          {remaining} of {FREE_DAILY_LIMIT} comparison{remaining === 1 ? '' : 's'} left today
        </span>
        <details className="plan-unlock">
          <summary>Upgrade</summary>
          <p className="muted small">
            Stripe checkout is coming soon. Got an early-access code?
          </p>
          <div className="plan-unlock-row">
            <input
              value={code}
              onChange={(e) => { setCode(e.target.value); setCodeErr(null); }}
              placeholder="STATEDGE-…"
            />
            <button onClick={tryUnlock}>Unlock</button>
          </div>
          {codeErr && <p className="error small">{codeErr}</p>}
        </details>
      </div>
    );
  }

  return (
    <div className="plan-bar blocked">
      <h3 style={{ margin: '0 0 8px' }}>Daily free limit reached</h3>
      <p className="muted">
        You've used your {FREE_DAILY_LIMIT} free comparisons for today
        ({usageToday}/{FREE_DAILY_LIMIT}). Come back tomorrow, or upgrade to Pro for
        unlimited comparisons + AI summaries.
      </p>
      <p className="muted small">
        Stripe checkout is coming soon. Got an early-access code?
      </p>
      <div className="plan-unlock-row">
        <input
          value={code}
          onChange={(e) => { setCode(e.target.value); setCodeErr(null); }}
          placeholder="STATEDGE-…"
        />
        <button onClick={tryUnlock}>Unlock Pro</button>
      </div>
      {codeErr && <p className="error small">{codeErr}</p>}
    </div>
  );
}
