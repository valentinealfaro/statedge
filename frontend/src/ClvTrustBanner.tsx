// ClvTrustBanner — Phase 111.
//
// The institutional truth metric, visible on the home page. Closing
// line value (CLV) is the cleanest answer to "are these projections
// any good?" — independent of game-outcome variance, you either got
// a better number than the market eventually settled on or you
// didn't. Long-run ≥55% beat rate on a real volume = real edge.
//
// We publish three windows side-by-side (7d / 30d / season-to-date)
// because trust is built by transparency, not point estimates. The
// banner silently hides if no projection has graded yet — better
// than displaying "—%" with low denominator.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getClvTrustScore, type ClvTrustScoreResponse, type ClvTrustWindow } from './api';

export function ClvTrustBanner() {
  const [data, setData] = useState<ClvTrustScoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getClvTrustScore()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error || !data) return null;

  // No data anywhere → don't show the banner. We'd rather hide than
  // display empty boxes that broadcast "we have nothing."
  const hasAny =
    (data.window7d.withClosing ?? 0) > 0 ||
    (data.window30d.withClosing ?? 0) > 0 ||
    (data.seasonToDate.withClosing ?? 0) > 0;
  if (!hasAny) return null;

  const seasonRate = data.seasonToDate.beatRate;
  const seasonAboveBar = seasonRate !== null && seasonRate >= 55;

  return (
    <section
      style={{
        margin: '24px auto',
        maxWidth: 1100,
        padding: 24,
        background: 'linear-gradient(135deg, rgba(102,187,106,0.06) 0%, rgba(122,162,255,0.06) 100%)',
        border: '1px solid rgba(102,187,106,0.25)',
        borderRadius: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div>
          <div style={{
            fontSize: 11, fontWeight: 800, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
          }}>
            STATEDGE TRUTH METRIC
          </div>
          <h2 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 800 }}>
            Closing Line Value
            {seasonAboveBar && (
              <span style={{
                marginLeft: 10, fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
                color: '#66bb6a', padding: '2px 8px',
                background: 'rgba(102,187,106,0.12)', borderRadius: 3,
                textTransform: 'uppercase', verticalAlign: 'middle',
              }}>
                ✓ above 55% bar
              </span>
            )}
          </h2>
        </div>
        <div style={{ display: 'flex', gap: 14, fontSize: 12, fontWeight: 700 }}>
          <Link to="/clv" style={{ color: '#7aa2ff', textDecoration: 'none' }}>
            CLV report →
          </Link>
          <Link to="/calibration" style={{ color: '#7aa2ff', textDecoration: 'none' }}>
            Calibration →
          </Link>
        </div>
      </div>

      <p className="muted small" style={{ margin: '0 0 16px', fontSize: 12, lineHeight: 1.5 }}>
        How often our published projections beat the market's eventual closing line. Independent of game outcomes — pure process accuracy. Every published prop is graded against later snapshots; we publish the math.
      </p>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}>
        <WindowCard label="Last 7 Days"          win={data.window7d}    accent />
        <WindowCard label="Last 30 Days"         win={data.window30d}            />
        <WindowCard label="Season to Date"       win={data.seasonToDate}         />
      </div>

      {data.seasonToDate.bySport.length > 0 && (
        <div style={{ marginTop: 14, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {data.seasonToDate.bySport.map((s) => (
            <div key={s.sport} style={{
              fontSize: 11, color: 'rgba(255,255,255,0.6)',
              padding: '4px 10px', background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4,
            }}>
              <strong style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.sport}</strong>
              {' '}
              {s.beatRate !== null ? `${s.beatRate.toFixed(1)}%` : '—'}
              {' '}
              <span style={{ opacity: 0.6 }}>({s.beatMarket}/{s.withClosing})</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function WindowCard({ label, win, accent }: { label: string; win: ClvTrustWindow; accent?: boolean }) {
  const rate = win.beatRate;
  const above = rate !== null && rate >= 55;
  const at    = rate !== null && rate >= 50 && rate < 55;
  const color = rate === null ? 'rgba(255,255,255,0.5)'
    : above ? '#66bb6a'
    : at    ? '#ffd54f'
    : '#ef5350';
  return (
    <div style={{
      padding: 14,
      background: 'rgba(0,0,0,0.25)',
      border: `1px solid ${accent ? 'rgba(102,187,106,0.3)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 8,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)',
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
        <span style={{ fontSize: 32, fontWeight: 800, color, lineHeight: 1 }}>
          {rate !== null ? `${rate.toFixed(1)}%` : '—'}
        </span>
      </div>
      <div className="muted small" style={{ fontSize: 11, marginTop: 4 }}>
        {win.withClosing > 0
          ? `${win.beatMarket} of ${win.withClosing} props beat the close`
          : 'No graded props yet'}
      </div>
    </div>
  );
}
