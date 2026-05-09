// HomeHero — Phase 132. The "site looks generic" fix.
//
// Replaces the centered logo + tagline + 4-CTA layout with a
// Bloomberg-style data-first hero. The single biggest signal we
// have is the CLV beat rate — leading with it makes the page
// instantly distinctive ("no other sports site shows this") and
// reinforces the brand promise on the first 200ms of attention.
//
// Falls back gracefully when no graded data exists yet — we don't
// fabricate a number; the layout collapses to a tagline-led version.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getClvTrustScore, type ClvTrustScoreResponse } from './api';

export function HomeHero() {
  const [clv, setClv] = useState<ClvTrustScoreResponse | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    getClvTrustScore().then(setClv).catch(() => setClv(null));
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const headline = clv?.window30d;
  const seasonRate = clv?.seasonToDate.beatRate;
  const hasData = headline && headline.withClosing > 0;

  return (
    <header style={{
      position: 'relative',
      maxWidth: 1100,
      margin: '0 auto',
      padding: '48px 24px 32px',
    }}>
      {/* Top strip — terminal-style metadata: brand mark + live time */}
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, marginBottom: 32,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        paddingBottom: 12,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}>
          STATEDGE · QUANTITATIVE SPORTS INTELLIGENCE
        </div>
        <div style={{
          fontSize: 11, fontWeight: 600,
          color: 'rgba(255,255,255,0.5)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{
            display: 'inline-block', width: 7, height: 7, borderRadius: 3.5,
            background: '#66bb6a',
          }} />
          LIVE · {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {now.toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </div>
      </div>

      {/* Headline — split. Left: "We beat the market." Right: stat */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: 32, alignItems: 'center',
        marginBottom: 28,
      }}>
        <div>
          <h1 style={{
            margin: 0, fontSize: 'clamp(34px, 6vw, 56px)',
            fontWeight: 900, lineHeight: 1.05,
            letterSpacing: '-0.03em',
          }}>
            {hasData ? <>We beat the market.</> : <>Find your edge.</>}
          </h1>
          <p style={{
            margin: '14px 0 0',
            fontSize: 16, lineHeight: 1.55,
            color: 'rgba(255,255,255,0.75)',
            maxWidth: 520,
          }}>
            {hasData ? (
              <>
                NBA · MLB · UFC. Projections, fragility, calibration — and the receipts.
                Every published prop is graded. We publish the math.
              </>
            ) : (
              <>
                NBA · MLB · UFC. Projections, fragility, calibration. Every published
                prop gets graded against the market's eventual close. The receipts populate
                as the model produces them.
              </>
            )}
          </p>
        </div>

        {hasData && (
          <div style={{
            textAlign: 'right',
            paddingLeft: 32,
            borderLeft: '1px solid rgba(255,255,255,0.1)',
            minWidth: 180,
          }}>
            <div style={{
              fontSize: 10, fontWeight: 800, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              marginBottom: 8,
            }}>
              CLV · 30d
            </div>
            <div style={{
              fontSize: 'clamp(56px, 9vw, 92px)',
              fontWeight: 900, lineHeight: 1,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: rateColor(headline.beatRate),
              letterSpacing: '-0.04em',
            }}>
              {headline.beatRate !== null ? `${headline.beatRate.toFixed(1)}%` : '—'}
            </div>
            <div style={{
              fontSize: 11, marginTop: 8,
              color: 'rgba(255,255,255,0.55)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}>
              {headline.beatMarket} of {headline.withClosing} props beat the close
              {seasonRate !== null && seasonRate !== undefined && (
                <>
                  <br />
                  season-to-date: <strong style={{ color: 'rgba(255,255,255,0.85)' }}>{seasonRate.toFixed(1)}%</strong>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* CTAs — restrained, sport-color-coded, terminal feel */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <CtaButton to="/elite" gold>★ Elite</CtaButton>
        <CtaButton to="/dashboard" accent="#7aa2ff">Command Center →</CtaButton>
        <CtaButton to="/clv" accent="#66bb6a">Truth Metric →</CtaButton>
        <CtaButton to="/methodology">Methodology</CtaButton>
        <span style={{ flex: 1 }} />
        <CtaButton to="/nba/compare" accent="#7aa2ff" subtle>NBA</CtaButton>
        <CtaButton to="/mlb/slate" accent="#66bb6a" subtle>MLB</CtaButton>
        <CtaButton to="/mma/scoreboard" accent="#ef5350" subtle>UFC</CtaButton>
      </div>

      <p style={{
        marginTop: 16, fontSize: 11,
        color: 'rgba(255,255,255,0.4)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}>
        Statistics + analysis only. No betting advice. No odds posted.
      </p>
    </header>
  );
}

function CtaButton({ to, children, accent, gold, subtle }: {
  to: string;
  children: React.ReactNode;
  accent?: string;
  gold?: boolean;
  subtle?: boolean;
}) {
  let bg: string;
  let color: string;
  let border: string;
  if (gold) {
    bg = 'linear-gradient(135deg, #ffd54f 0%, #f9a825 100%)';
    color = '#0d1117';
    border = 'transparent';
  } else if (subtle && accent) {
    bg = 'transparent';
    color = accent;
    border = `${accent}55`;
  } else if (accent) {
    bg = `${accent}15`;
    color = accent;
    border = `${accent}40`;
  } else {
    bg = 'rgba(255,255,255,0.04)';
    color = 'rgba(255,255,255,0.85)';
    border = 'rgba(255,255,255,0.12)';
  }
  return (
    <Link to={to} style={{
      padding: '8px 14px',
      background: bg,
      color,
      border: `1px solid ${border}`,
      borderRadius: 6,
      fontSize: 13,
      fontWeight: 700,
      textDecoration: 'none',
      letterSpacing: '0.02em',
      transition: 'transform 120ms, filter 120ms',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </Link>
  );
}

function rateColor(rate: number | null): string {
  if (rate === null) return 'rgba(255,255,255,0.4)';
  if (rate >= 55) return '#66bb6a';
  if (rate >= 50) return '#ffd54f';
  return '#ef5350';
}
