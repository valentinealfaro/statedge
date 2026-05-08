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

type DayBucket = {
  date: string;
  totalLegs: number;
  gradedLegs: number;
  hits: number;
  misses: number;
  pending: number;
  hitRate: number | null;
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
