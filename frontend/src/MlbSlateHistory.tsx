// MLB Slate History — date-by-date track record of past published
// slates. Reads /api/mlb/slate/history (Phase 24 endpoint) which
// aggregates from mlb_projection_history.
//
// Mission alignment: accountability is the whole point. We don't
// hide the days the model went 4-and-12; users see the receipt.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '') as string;

type CardBucket = {
  cardType: string;
  legs: number;
  hits: number;
  misses: number;
  pending: number;
  cleared: boolean | null;
};

type DayBucket = {
  date: string;
  totalLegs: number;
  gradedLegs: number;
  hits: number;
  misses: number;
  pending: number;
  hitRate: number | null;
  byCardType?: Record<string, CardBucket>;
};

type HistoryResponse = {
  windowDays: number;
  days: DayBucket[];
  disclaimer: string;
};

export function MlbSlateHistory() {
  useTitle(['MLB Slate History']);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<30 | 90 | 180>(30);

  useEffect(() => {
    setData(null);
    setError(null);
    fetch(`${API_BASE}/api/mlb/slate/history?windowDays=${windowDays}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [windowDays]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>MLB · Slate History</h1>
        <p className="muted small">
          Past published slates with hit-rate tracking. Each row is one
          calendar day; legs are graded against actual game outcomes
          once games finalize. The model's accountability surface —
          you see the wins and the losses, no cherry-picking.
        </p>

        <div className="mlb-line-row" style={{ marginTop: 8 }}>
          <div className="mlb-direction-toggle">
            {([30, 90, 180] as const).map((w) => (
              <button
                key={w}
                type="button"
                className={`mlb-dir-btn ${windowDays === w ? 'active' : ''}`}
                onClick={() => setWindowDays(w)}
              >
                Last {w} days
              </button>
            ))}
          </div>
        </div>

        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        {!data && !error && <Skeleton width="100%" height={240} style={{ marginTop: 20 }} />}

        {data && data.days.length === 0 && (
          <div className="mlb-info-banner" style={{ marginTop: 16 }}>
            <strong>No slate history yet.</strong> Past published slates will
            appear here once they accumulate. Each card-leg from /mlb/slate
            gets recorded when the day's slate is first viewed; grading
            happens automatically as games finalize over the next 24-48 hrs.
          </div>
        )}

        {data && data.days.length > 0 && <HistoryTable days={data.days} />}

        {data && (
          <p className="mlb-disclaimer">{data.disclaimer}</p>
        )}
      </div>
    </div>
  );
}

// Standard card-type ordering — keeps the rollup table consistent
// even when a particular card type is missing from a given window.
const CARD_TYPE_ORDER = ['Best 2', 'Best 3', 'Best 4', 'Best 5', 'Best 6', 'Wild Card'];

function HistoryTable({ days }: { days: DayBucket[] }) {
  // Cumulative aggregates across the visible window.
  const totals = days.reduce(
    (acc, d) => ({
      totalLegs: acc.totalLegs + d.totalLegs,
      gradedLegs: acc.gradedLegs + d.gradedLegs,
      hits: acc.hits + d.hits,
      misses: acc.misses + d.misses,
      pending: acc.pending + d.pending,
    }),
    { totalLegs: 0, gradedLegs: 0, hits: 0, misses: 0, pending: 0 },
  );
  const cumulativeHitRate =
    totals.gradedLegs > 0
      ? Math.round((totals.hits / totals.gradedLegs) * 1000) / 10
      : null;

  // Card-type rollup across the entire window: how many days did
  // each card type CLEAR (every leg hit) vs DIE (any leg missed)?
  // This is the metric that matters for parlay players — leg hit rate
  // doesn't pay; whole-card clearance does.
  const cardRollup = new Map<string, { cleared: number; dead: number; pending: number; days: number }>();
  for (const d of days) {
    if (!d.byCardType) continue;
    for (const [name, card] of Object.entries(d.byCardType)) {
      const r = cardRollup.get(name) ?? { cleared: 0, dead: 0, pending: 0, days: 0 };
      r.days += 1;
      if (card.cleared === true) r.cleared += 1;
      else if (card.cleared === false) r.dead += 1;
      else r.pending += 1;
      cardRollup.set(name, r);
    }
  }
  const orderedCards = [
    ...CARD_TYPE_ORDER.filter((n) => cardRollup.has(n)),
    ...[...cardRollup.keys()].filter((n) => !CARD_TYPE_ORDER.includes(n)),
  ];

  return (
    <>
      <div className="mlb-projection" style={{ marginTop: 16 }}>
        <div className="mlb-projection-head">
          <h3>Window totals</h3>
          <span className="muted small">{days.length} days</span>
        </div>
        <div className="mlb-projection-grid">
          <div className="mlb-stat" title="Total card-legs published in this window">
            <span className="mlb-stat-label">Legs</span>
            <span className="mlb-stat-value">{totals.totalLegs}</span>
          </div>
          <div className="mlb-stat" title="Legs whose games have finalized and been graded">
            <span className="mlb-stat-label">Graded</span>
            <span className="mlb-stat-value">{totals.gradedLegs}</span>
          </div>
          <div className="mlb-stat" title="Legs that hit their line in the chosen direction">
            <span className="mlb-stat-label">Hits</span>
            <span className="mlb-stat-value">{totals.hits}</span>
          </div>
          <div className="mlb-stat" title="Legs that did not hit">
            <span className="mlb-stat-label">Misses</span>
            <span className="mlb-stat-value">{totals.misses}</span>
          </div>
          <div className="mlb-stat" title="Legs with no actual data yet (games still pending or sync lag)">
            <span className="mlb-stat-label">Pending</span>
            <span className="mlb-stat-value">{totals.pending}</span>
          </div>
          <div className="mlb-stat" title="Bayesian-smoothed hit rate would lift this near 50% with thin samples; this is the raw number.">
            <span className="mlb-stat-label">Hit rate</span>
            <span className="mlb-stat-value">
              {cumulativeHitRate !== null ? `${cumulativeHitRate.toFixed(1)}%` : '—'}
            </span>
          </div>
        </div>
      </div>

      {orderedCards.length > 0 && (
        <div className="mlb-context" style={{ marginTop: 12 }} title="Per-card-type clearance rate. Cleared = every leg in that card hit. Dead = at least one leg missed (parlay killed).">
          <div className="mlb-context-heading">
            Card-type track record <span className="muted small">— whole-card clearance, the only metric that pays</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="mlb-standings-table" style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th>Card</th>
                  <th className="num">Days</th>
                  <th className="num">Cleared</th>
                  <th className="num">Dead</th>
                  <th className="num">Pending</th>
                  <th className="num">Clear rate</th>
                </tr>
              </thead>
              <tbody>
                {orderedCards.map((name) => {
                  const r = cardRollup.get(name)!;
                  const settled = r.cleared + r.dead;
                  const clearRate = settled > 0 ? Math.round((r.cleared / settled) * 1000) / 10 : null;
                  return (
                    <tr key={name}>
                      <td><strong>{name}</strong></td>
                      <td className="num">{r.days}</td>
                      <td className="num" style={{ color: r.cleared > 0 ? 'var(--hot, #66bb6a)' : undefined }}>{r.cleared}</td>
                      <td className="num" style={{ color: r.dead > 0 ? '#ef5350' : undefined }}>{r.dead}</td>
                      <td className="num">{r.pending}</td>
                      <td className="num">
                        {clearRate !== null ? `${clearRate.toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mlb-context" style={{ marginTop: 12 }}>
        <div className="mlb-context-heading">Day by day</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="mlb-standings-table" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Legs</th>
                <th className="num">Graded</th>
                <th className="num">Hits</th>
                <th className="num">Misses</th>
                <th className="num">Pending</th>
                <th className="num">Hit %</th>
                <th>Cards</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td><strong>{d.date}</strong></td>
                  <td className="num">{d.totalLegs}</td>
                  <td className="num">{d.gradedLegs}</td>
                  <td className="num" style={{ color: d.hits > 0 ? 'var(--hot, #66bb6a)' : undefined }}>{d.hits}</td>
                  <td className="num" style={{ color: d.misses > 0 ? '#ef5350' : undefined }}>{d.misses}</td>
                  <td className="num">{d.pending}</td>
                  <td className="num">
                    {d.hitRate !== null ? `${d.hitRate.toFixed(1)}%` : '—'}
                  </td>
                  <td>
                    {d.byCardType && Object.keys(d.byCardType).length > 0 ? (
                      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                        {orderedCards
                          .filter((n) => d.byCardType![n])
                          .map((n) => {
                            const c = d.byCardType![n];
                            const color =
                              c.cleared === true ? '#66bb6a'
                              : c.cleared === false ? '#ef5350'
                              : '#7aa2ff';
                            const symbol =
                              c.cleared === true ? '✓'
                              : c.cleared === false ? '✗'
                              : '●';
                            const tooltip =
                              c.cleared === true ? `${n} CLEARED — all ${c.legs} legs hit`
                              : c.cleared === false ? `${n} DEAD — ${c.misses} of ${c.legs} legs missed (${c.hits} hit)`
                              : `${n} pending: ${c.hits} hit, ${c.misses} miss, ${c.pending} pending`;
                            return (
                              <span
                                key={n}
                                title={tooltip}
                                style={{ color, fontWeight: 700, fontSize: 11 }}
                              >
                                {symbol} {n.replace('Best ', 'B')}
                                {c.cleared === false && ` (${c.hits}/${c.legs})`}
                              </span>
                            );
                          })}
                      </span>
                    ) : (
                      <span className="muted small">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="muted small" style={{ marginTop: 12 }}>
        <Link to="/mlb/calibration" className="footer-link">
          See the calibration breakdown →
        </Link>
        {' · '}
        <Link to="/mlb/slate" className="footer-link">
          ← Back to today's slate
        </Link>
      </p>
    </>
  );
}
