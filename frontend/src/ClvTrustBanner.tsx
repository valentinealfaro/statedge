// ClvTrustBanner — Phase 111, sport-aware in Phase 120.
//
// The institutional truth metric. Closing line value (CLV) is the
// cleanest answer to "are these projections any good?" — independent
// of game-outcome variance. Long-run ≥55% beat rate on real volume
// = real edge.
//
// Three windows side-by-side (7d / 30d / season-to-date). When a
// `sport` prop is provided, the banner filters its scoreboard to
// that sport — Slate pages get sport-specific receipts; Home and
// Dashboard get the cross-sport aggregate.
//
// Banner silently hides when no projection has graded for the
// selected scope yet — better than showing "—%" with low denominator.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getClvTrustScore, type ClvTrustScoreResponse, type ClvTrustWindow } from './api';

type Sport = 'mlb' | 'nba' | 'wnba' | 'mma';

type SportFilteredView = {
  beatRate: number | null;
  beatMarket: number;
  withClosing: number;
};

type Props = {
  // When set, the banner reports only this sport's beat rate. Without
  // it, the banner reports cross-sport aggregate and shows per-sport
  // chips at the bottom.
  sport?: Sport;
};

export function ClvTrustBanner({ sport }: Props = {}) {
  const [data, setData] = useState<ClvTrustScoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getClvTrustScore()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error || !data) return null;

  // Resolve per-window scope: when `sport` is set, dig per-sport stats
  // out of each window's bySport[]. When unset, fall through to the
  // cross-sport top-level totals.
  const w7  = scopeWindow(data.window7d, sport);
  const w30 = scopeWindow(data.window30d, sport);
  const wSn = scopeWindow(data.seasonToDate, sport);

  const hasAny =
    w7.withClosing > 0 || w30.withClosing > 0 || wSn.withClosing > 0;
  if (!hasAny) return null;

  const seasonAboveBar = wSn.beatRate !== null && wSn.beatRate >= 55;
  // 'mma' is internal; users see 'UFC'. Mirrors the SPORT_LABEL maps
  // in StarredPage / NavSearch / News etc.
  const sportLabel = sport ? (sport === 'mma' ? 'UFC' : sport.toUpperCase()) : null;
  const eyebrow = sportLabel
    ? `STATEDGE ${sportLabel} · TRUTH METRIC`
    : 'STATEDGE TRUTH METRIC';
  const blurb = sportLabel
    ? `How often our published ${sportLabel} projections beat the market's eventual closing line. Independent of game outcomes — pure process accuracy.`
    : 'How often our published projections beat the market\'s eventual closing line. Independent of game outcomes — pure process accuracy. Every published prop is graded against later snapshots; we publish the math.';

  return (
    <section
      className="fade-up"
      style={{
        position: 'relative',
        margin: '24px auto',
        maxWidth: 1100,
        padding: 26,
        background: `
          radial-gradient(ellipse 50% 80% at 0% 0%, rgba(102,187,106,0.10) 0%, transparent 60%),
          radial-gradient(ellipse 50% 80% at 100% 100%, rgba(122,162,255,0.08) 0%, transparent 60%),
          linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
          var(--surface-1)
        `,
        border: '1px solid rgba(102,187,106,0.30)',
        borderRadius: 14,
        boxShadow: '0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 40px rgba(102,187,106,0.10), 0 4px 14px rgba(0,0,0,0.35)',
        overflow: 'hidden',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(102,187,106,0.55), rgba(122,162,255,0.55), transparent)',
      }} />
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div>
          <div style={{
            fontSize: 11, fontWeight: 800, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
          }}>
            {eyebrow}
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
        <div style={{ display: 'flex', gap: 14, fontSize: 12, fontWeight: 700, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link to="/elite" style={{
            color: '#0d1117',
            textDecoration: 'none',
            background: 'linear-gradient(135deg, #ffd54f 0%, #f9a825 100%)',
            padding: '4px 10px',
            borderRadius: 4,
          }}>
            ★ Today's play →
          </Link>
          <Link to="/clv" style={{ color: '#7aa2ff', textDecoration: 'none' }}>
            CLV report →
          </Link>
          <Link to="/calibration" style={{ color: '#7aa2ff', textDecoration: 'none' }}>
            Calibration →
          </Link>
        </div>
      </div>

      <p className="muted small" style={{ margin: '0 0 16px', fontSize: 12, lineHeight: 1.5 }}>
        {blurb}
      </p>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}>
        <WindowCard label="Last 7 Days"     view={w7}  accent />
        <WindowCard label="Last 30 Days"    view={w30}        />
        <WindowCard label="Season to Date"  view={wSn}        />
      </div>

      {/* Cross-sport breakdown chips — only render when NOT scoped
          to a single sport (avoids redundancy on slate pages). */}
      {!sport && data.seasonToDate.bySport.length > 0 && (
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

// Resolve which numbers a given window contributes — full cross-sport
// roll-up vs the row for a specific sport.
function scopeWindow(win: ClvTrustWindow, sport: Sport | undefined): SportFilteredView {
  if (!sport) {
    return {
      beatRate: win.beatRate,
      beatMarket: win.beatMarket,
      withClosing: win.withClosing,
    };
  }
  const row = win.bySport.find((s) => s.sport === sport);
  if (!row) return { beatRate: null, beatMarket: 0, withClosing: 0 };
  return {
    beatRate: row.beatRate,
    beatMarket: row.beatMarket,
    withClosing: row.withClosing,
  };
}

function WindowCard({ label, view, accent }: { label: string; view: SportFilteredView; accent?: boolean }) {
  const rate = view.beatRate;
  const above = rate !== null && rate >= 55;
  const at    = rate !== null && rate >= 50 && rate < 55;
  const color = rate === null ? 'rgba(255,255,255,0.5)'
    : above ? '#66bb6a'
    : at    ? '#ffd54f'
    : '#ef5350';
  return (
    <div style={{
      position: 'relative',
      padding: 16,
      background: 'linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 30%), rgba(0,0,0,0.30)',
      border: `1px solid ${accent ? 'rgba(102,187,106,0.35)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 10,
      boxShadow: accent ? '0 6px 18px rgba(102,187,106,0.10)' : 'none',
      overflow: 'hidden',
    }}>
      <span aria-hidden style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: accent
          ? 'linear-gradient(90deg, transparent, rgba(102,187,106,0.50), transparent)'
          : 'linear-gradient(90deg, transparent, rgba(255,255,255,0.10), transparent)',
      }} />
      <div style={{
        fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
        <span style={{
          fontSize: 36, fontWeight: 900, color, lineHeight: 1,
          letterSpacing: '-0.03em',
          textShadow: rate !== null ? `0 0 22px ${color}55` : 'none',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {rate !== null ? `${rate.toFixed(1)}%` : '—'}
        </span>
      </div>
      <div className="muted small" style={{ fontSize: 11, marginTop: 6, color: 'rgba(255,255,255,0.6)' }}>
        {view.withClosing > 0
          ? `${view.beatMarket} of ${view.withClosing} props beat the close`
          : 'No graded props yet'}
      </div>
    </div>
  );
}
