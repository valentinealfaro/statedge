// HomeEliteTeaser — Phase 135.
//
// "Today's play" surfaced on the home page as a compact teaser that
// links into /elite for the full ticket. Loads the cross-sport
// endpoint and renders just the headline (grade + payout + leg
// count) so users see the institutional play without leaving Home.
//
// Self-hides while loading and on error — Home should never broadcast
// a stuck-loading state. The full Elite page handles loading copy
// when the user actually clicks through.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getCrossSportEliteToday, type CrossSportEliteTicket } from './api';

export function HomeEliteTeaser() {
  const [ticket, setTicket] = useState<CrossSportEliteTicket | null | undefined>(undefined);

  useEffect(() => {
    getCrossSportEliteToday()
      .then((r) => setTicket(r.ticket))
      .catch(() => setTicket(null));
  }, []);

  // Hide while loading or on failure — keep Home clean
  if (ticket === undefined) return null;
  if (!ticket) return null;

  const gradeColor = ticket.grade === 'A+' ? '#66bb6a' : ticket.grade === 'A' ? '#7aa2ff' : '#ffd54f';
  const sportsLabel = ticket.sportsCovered.length > 1
    ? ticket.sportsCovered.map((s) => s.toUpperCase()).join(' + ')
    : ticket.sportsCovered[0]?.toUpperCase() ?? '';

  return (
    <Link
      to="/elite"
      className="elite-teaser fade-up"
      style={{
        position: 'relative',
        display: 'block',
        margin: '24px auto',
        maxWidth: 1100,
        padding: '22px 26px',
        background: `
          radial-gradient(ellipse 30% 80% at 0% 50%, rgba(255,213,79,0.10) 0%, transparent 60%),
          radial-gradient(ellipse 30% 80% at 100% 50%, rgba(102,187,106,0.06) 0%, transparent 60%),
          linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 30%),
          var(--surface-1)
        `,
        border: `1px solid ${gradeColor}40`,
        borderRadius: 14,
        textDecoration: 'none',
        color: 'inherit',
        transition: 'transform 200ms cubic-bezier(0.4,0,0.2,1), border-color 200ms, box-shadow 200ms',
        boxShadow: `0 1px 0 rgba(255,255,255,0.05) inset, 0 8px 24px ${gradeColor}1a, 0 2px 6px rgba(0,0,0,0.35)`,
        overflow: 'hidden',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        background: `linear-gradient(90deg, transparent 0%, ${gradeColor}11 50%, transparent 100%)`,
        opacity: 0.5,
      }} />
      <span aria-hidden style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: 1,
        background: `linear-gradient(90deg, transparent, ${gradeColor}80, transparent)`,
      }} />
      <div style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: 'auto auto 1fr auto',
        gap: 24,
        alignItems: 'center',
      }}>
        {/* Eyebrow + brand */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 800, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: '#ffd54f',
          }}>
            ★ STATEDGE ELITE
          </div>
          <div style={{ fontSize: 11, marginTop: 2, color: 'rgba(255,255,255,0.6)' }}>
            Today's play · Cross-sport
          </div>
        </div>

        {/* Grade */}
        <div style={{
          fontSize: 56, fontWeight: 900, lineHeight: 1, color: gradeColor,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          textShadow: `0 0 24px ${gradeColor}55`,
          letterSpacing: '-0.04em',
        }}>
          {ticket.grade}
        </div>

        {/* Stats */}
        <div style={{ display: 'flex', gap: 18, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>
              {ticket.combinedFairPayout.toFixed(1)}×
            </div>
            <div className="muted small" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 }}>
              fair payout
            </div>
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1, color: 'rgba(255,255,255,0.85)' }}>
              {ticket.combinedProbability.toFixed(1)}%
            </div>
            <div className="muted small" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 }}>
              combined hit
            </div>
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1, color: '#66bb6a' }}>
              {ticket.tier === '3-leg' ? '3 legs' : '2 legs'}
            </div>
            <div className="muted small" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 }}>
              {sportsLabel}
            </div>
          </div>
        </div>

        {/* CTA */}
        <div style={{
          fontSize: 13, fontWeight: 800,
          color: '#ffd54f',
          padding: '8px 14px',
          background: 'rgba(255,213,79,0.1)',
          border: '1px solid rgba(255,213,79,0.4)',
          borderRadius: 6,
          whiteSpace: 'nowrap',
        }}>
          See the play →
        </div>
      </div>
    </Link>
  );
}
