// BeatRateTrend — Phase 127.
//
// 12-week beat-rate time series. Extracted from ClvAudit so it can
// drop on Methodology + Calibration audit + future surfaces. Self-
// contained: fetches its own data, self-hides when the entire window
// is empty.
//
// Each column = one ISO week. Bar height = beat rate (0–100%). Color
// codes the institutional bar: green ≥55, yellow 50–55, red <50.
// Empty weeks render as gaps so the timeline never lies about
// continuity.

import { useEffect, useState } from 'react';
import { getClvTrend, type ClvWeekBucket } from './api';

type Props = {
  weeks?: number;
  heading?: string;
  blurb?: string;
};

export function BeatRateTrend({ weeks = 12, heading = 'Beat Rate · Last 12 Weeks', blurb }: Props) {
  const [data, setData] = useState<ClvWeekBucket[] | null>(null);

  useEffect(() => {
    getClvTrend({ weeks })
      .then((r) => setData(r.weeks))
      .catch(() => setData([]));
  }, [weeks]);

  if (!data || !data.some((w) => w.withClosing > 0)) return null;

  const max = 100;
  const defaultBlurb =
    'Cross-sport beat rate per ISO week. Each bar is one week\'s batch of graded props; ' +
    'green = ≥55%, yellow = 50–55%, red = below 50%. The dotted line marks 50%. Empty ' +
    'weeks show as gaps — we don\'t infer between samples.';

  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>
        {heading}
      </h2>
      <p className="muted small" style={{ margin: '0 0 12px', fontSize: 12, lineHeight: 1.5 }}>
        {blurb ?? defaultBlurb}
      </p>
      <div style={{
        position: 'relative', height: 140,
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 6, padding: '12px 12px 24px',
        display: 'flex', alignItems: 'flex-end', gap: 4,
      }}>
        {/* 50% reference line */}
        <div style={{
          position: 'absolute', left: 12, right: 12,
          top: '50%', height: 1,
          borderTop: '1px dashed rgba(255,255,255,0.18)',
        }} />
        {/* 55% institutional bar */}
        <div style={{
          position: 'absolute', left: 12, right: 12,
          top: `${100 - 55}%`, height: 1,
          borderTop: '1px dashed rgba(102,187,106,0.35)',
        }} />
        {data.map((w) => {
          const rate = w.beatRate;
          const heightPct = rate === null ? 0 : (rate / max) * 100;
          const color = rate === null ? 'rgba(255,255,255,0.08)'
            : rate >= 55 ? '#66bb6a'
            : rate >= 50 ? '#ffd54f'
            : '#ef5350';
          const dateStr = w.weekStart.slice(5);
          return (
            <div
              key={w.weekStart}
              title={rate !== null
                ? `Week of ${w.weekStart}: ${rate.toFixed(1)}% (${w.beatMarket}/${w.withClosing})`
                : `Week of ${w.weekStart}: no graded props`
              }
              style={{
                flex: 1, height: '100%', position: 'relative',
                display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
                cursor: rate !== null ? 'help' : 'default',
              }}
            >
              <div style={{
                width: '100%',
                height: `${heightPct}%`,
                background: color,
                borderRadius: '2px 2px 0 0',
                opacity: rate === null ? 0.3 : 0.85,
                minHeight: rate === null ? 1 : 4,
              }} />
              <div style={{
                position: 'absolute', bottom: -18, left: 0, right: 0,
                fontSize: 9, color: 'rgba(255,255,255,0.45)',
                textAlign: 'center', fontWeight: 600,
              }}>
                {dateStr}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
