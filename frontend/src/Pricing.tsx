import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { NavBar } from './NavBar';
import { unlockPro, usePlan } from './plan';
import { useTitle } from './useTitle';

// Free vs Pro pricing page. Shows the feature matrix and provides two
// upgrade paths: an unlock code (existing PRO_UNLOCK_CODE flow) for
// invited testers, and a placeholder "Contact Sales" mailto for now
// until Stripe is wired.
export function Pricing() {
  useTitle(['Pricing']);
  const { plan, isAdmin } = usePlan();
  const isPro = plan === 'pro' || isAdmin;
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  function tryUnlock() {
    setCodeError(null);
    const ok = unlockPro(code);
    if (!ok) {
      setCodeError('That code didn\'t work. Check the casing and try again.');
      return;
    }
    navigate('/slate');
  }

  return (
    <div className="app">
      <NavBar />

      <div className="pricing-hero">
        <h1>Find your edge.</h1>
        <p className="tag">
          Free for player-vs-team comparisons. Upgrade to Pro to unlock the
          full prop slate, parlay builder, and AI analysis.
        </p>
      </div>

      <div className="pricing-tiers">
        <div className="pricing-tier">
          <div className="pricing-tier-name">Free</div>
          <div className="pricing-tier-price">
            <span className="pricing-amt">$0</span>
            <span className="pricing-per">forever</span>
          </div>
          <ul className="pricing-features">
            <li>✓ <strong>Compare</strong> — player vs team, player vs player, team vs team</li>
            <li>✓ Last-10 game logs with by-opponent breakdowns</li>
            <li>✓ Hit probability against any line</li>
            <li>✓ Daily comparison limit</li>
            <li className="muted">✗ Tonight's prop board with model probabilities</li>
            <li className="muted">✗ Pre-built parlays + parlay builder</li>
            <li className="muted">✗ Saved parlays + AI analysis</li>
            <li className="muted">✗ Favorites + line override</li>
          </ul>
          {!isPro && (
            <div className="pricing-cta-block">
              <Link to="/nba/compare" className="cta">Use Compare</Link>
              <span className="muted small">You're already on Free</span>
            </div>
          )}
        </div>

        <div className="pricing-tier featured">
          <div className="pricing-tier-badge">RECOMMENDED</div>
          <div className="pricing-tier-name">Pro</div>
          <div className="pricing-tier-price">
            <span className="pricing-amt">$19.99</span>
            <span className="pricing-per">/ month</span>
          </div>
          <ul className="pricing-features">
            <li>✓ <strong>Everything in Free</strong></li>
            <li>✓ <strong>Slate</strong> — tonight's full prop board with model probability on every line</li>
            <li>✓ Pre-built parlays at sizes 2–6 + Wild Card longshot</li>
            <li>✓ 6-leg parlay builder with combined hit probability</li>
            <li>✓ Live line override — recompute probability against your sportsbook's number</li>
            <li>✓ Save favorite players + favorite team</li>
            <li>✓ Save parlays to history</li>
            <li>✓ AI "Why?" insight on every prop</li>
            <li>✓ AI parlay analysis (powered by Gemini)</li>
            <li>✓ Unlimited comparisons (no daily limit)</li>
          </ul>
          {isPro ? (
            <div className="pricing-cta-block">
              <span className="pricing-current-badge">✓ Your current plan</span>
              <Link to="/nba/slate" className="cta primary">Open Slate →</Link>
            </div>
          ) : (
            <div className="pricing-cta-block">
              <a
                className="cta primary"
                href="mailto:info@vcvservices.com?subject=StatEdge%20Pro%20signup"
              >
                Get Pro
              </a>
              <details className="plan-unlock">
                <summary>Have an unlock code?</summary>
                <div className="plan-unlock-row">
                  <input
                    type="text"
                    placeholder="STATEDGE-XXXXX"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') tryUnlock(); }}
                  />
                  <button type="button" onClick={tryUnlock}>Unlock</button>
                </div>
                {codeError && <p className="error" style={{ marginTop: 6 }}>{codeError}</p>}
              </details>
            </div>
          )}
        </div>
      </div>

      <div className="pricing-faq">
        <h2>Frequently asked</h2>
        <div className="pricing-faq-grid">
          <div>
            <h3>Is StatEdge a betting platform?</h3>
            <p className="muted">
              No. StatEdge provides statistical projections and historical
              analysis only. No money changes hands on this site. We never
              say a line "will hit" — only what the data shows as a
              probability lean.
            </p>
          </div>
          <div>
            <h3>Where do the lines come from?</h3>
            <p className="muted">
              Lines are published daily by our team using sources like
              PrizePicks's public board. Sportsbooks move lines through the
              day, so you can override any number on Slate to match your
              book and the probability recomputes locally.
            </p>
          </div>
          <div>
            <h3>How is hit probability calculated?</h3>
            <p className="muted">
              A layered model: baselines per data window (season, last-10,
              last-5, vs-opponent, home/away, usage), eight context
              multipliers (minutes, injury, defense, pace, rest, etc),
              distribution-based probability with per-stat std-dev floors,
              and a conservative lean threshold that returns "No Clear
              Edge" when the signal is weak.
            </p>
          </div>
          <div>
            <h3>Can I cancel anytime?</h3>
            <p className="muted">
              Yes. Reach us at info@vcvservices.com and we'll cancel your
              subscription on the spot — you keep access through the end of
              the billing period.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
