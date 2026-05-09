// WNBA Slate History — Phase 93. Date-by-date track record of past
// published slates. Reads /api/wnba/slate/history (Phase 93 endpoint)
// which aggregates from wnba_projection_history.
//
// Mission alignment: accountability surface — we don't hide the
// 4-and-12 days; users see the full receipt.

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

type StatTypeBucket = {
  stat: string;
  direction: 'OVER' | 'UNDER';
  legs: number;
  hits: number;
  misses: number;
  pending: number;
  hitRate: number | null;
};

type HistoryResponse = {
  windowDays: number;
  days: DayBucket[];
  byStatType?: StatTypeBucket[];
  disclaimer: string;
};

export function WnbaSlateHistory() {
  useTitle(['WNBA Slate History']);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<30 | 90 | 180>(30);

  useEffect(() => {
    setData(null);
    setError(null);
    fetch(`${API_BASE}/api/wnba/slate/history?windowDays=${windowDays}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [windowDays]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>WNBA · Slate History</h1>
        <p className="muted small">
          Past published slates with hit-rate tracking. Each row is one
          calendar day; legs are graded against actual game outcomes
          once games finalize. The model's accountability surface —
          you see the wins and the losses, no cherry-picking.
        </p>

        <div className="mlb-line-row" style={{ marginTop: 8 }}>
          <div className="mlb-direction-toggle">
            {[30, 90, 180].map((w) => (
              <button
                key={w}
                type="button"
                className={`mlb-dir-btn ${windowDays === w ? 'active' : ''}`}
                onClick={() => setWindowDays(w as 30 | 90 | 180)}
              >
                Last {w} days
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mlb-info-banner mlb-info-error" style={{ marginTop: 16 }}>
            {error}
          </div>
        )}

        {!data && !error && <Skeleton width="100%" height={360} style={{ marginTop: 16 }} />}

        {data && data.days.length === 0 && (
          <div className="mlb-info-banner" style={{ marginTop: 16 }}>
            No graded slates in the last {windowDays} days yet.
          </div>
        )}

        {data && data.days.length > 0 && (
          <>
            <h2 style={{ marginTop: 24 }}>Day-by-day</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {data.days.map((d) => (
                <DayRow key={d.date} day={d} />
              ))}
            </div>

            {data.byStatType && data.byStatType.length > 0 && (
              <>
                <h2 style={{ marginTop: 32 }}>By stat & direction</h2>
                <p className="muted small" style={{ marginTop: 0 }}>
                  Where the model is edge-positive vs negative across
                  the window. Buckets with &lt;5 settled legs are
                  shown last (sample too thin to trust).
                </p>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                    gap: 8,
                    marginTop: 8,
                  }}
                >
                  {data.byStatType.map((b, i) => <StatBucket key={i} bucket={b} />)}
                </div>
              </>
            )}

            <p className="mlb-disclaimer" style={{ marginTop: 32 }}>{data.disclaimer}</p>
          </>
        )}
      </div>
    </div>
  );
}

function DayRow({ day }: { day: DayBucket }) {
  const hitColor = day.hitRate === null ? 'rgba(255,255,255,0.5)'
    : day.hitRate >= 60 ? '#66bb6a'
    : day.hitRate <= 40 ? '#ef5350'
    : '#7aa2ff';
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderLeft: '3px solid #b388ff',
        borderRadius: 6,
        padding: '10px 14px',
        display: 'flex',
        gap: 16,
        alignItems: 'baseline',
        flexWrap: 'wrap',
      }}
    >
      <strong style={{ fontSize: 14, fontWeight: 800 }}>{day.date}</strong>
      <span className="muted small">{day.totalLegs} legs · {day.gradedLegs} graded</span>
      <span style={{ color: '#66bb6a', fontWeight: 700 }}>{day.hits} hit</span>
      <span style={{ color: '#ef5350', fontWeight: 700 }}>{day.misses} miss</span>
      {day.pending > 0 && (
        <span className="muted small">{day.pending} pending</span>
      )}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'baseline' }}>
        <span className="muted small">Hit rate</span>
        <strong style={{ fontSize: 16, color: hitColor }}>
          {day.hitRate === null ? '—' : `${day.hitRate.toFixed(1)}%`}
        </strong>
      </span>
    </div>
  );
}

function StatBucket({ bucket }: { bucket: StatTypeBucket }) {
  const settled = bucket.hits + bucket.misses;
  const thin = settled < 5;
  const hitColor = bucket.hitRate === null ? 'rgba(255,255,255,0.5)'
    : bucket.hitRate >= 60 ? '#66bb6a'
    : bucket.hitRate <= 40 ? '#ef5350'
    : '#7aa2ff';
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 6,
        padding: 10,
        opacity: thin ? 0.6 : 1,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
        {bucket.stat} {bucket.direction === 'OVER' ? '↑' : '↓'}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 18, color: hitColor }}>
          {bucket.hitRate === null ? '—' : `${bucket.hitRate.toFixed(0)}%`}
        </strong>
        <span className="muted small">
          {bucket.hits}/{settled}
        </span>
      </div>
      {thin && (
        <div className="muted small" style={{ fontSize: 10, marginTop: 2 }}>
          thin sample
        </div>
      )}
    </div>
  );
}

// Suppress unused-import linter — keep Link available for future
// links into individual day detail pages.
void Link;
