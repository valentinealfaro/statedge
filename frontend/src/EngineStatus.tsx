// EngineStatus — Phase 122.
//
// The operational pulse. Bloomberg Terminals always show what's
// happening RIGHT NOW; this widget surfaces the same firehose for
// StatEdge — articles auto-generated, market snapshots captured,
// projections graded. Drops onto the Methodology page so users
// can verify the engine is actually running, not a static showcase.

import { useEffect, useState } from 'react';
import { getEngineStatus, type EngineStatusResponse } from './api';

const KIND_LABEL: Record<string, string> = {
  top_mispricings:    'Market Dislocations',
  trap_watch:         'Trap Watch',
  why_market_wrong:   'Edge Analysis',
  clv_recap:          'CLV Recap',
  edge_preview:       'Edge Preview',
  big_game:           'Big Game',
  fight_night:        'Fight Night',
  line_steam:         'Line Steam',
  power_rankings:     'Power Rankings',
  situation_report:   'Situation Report',
};

export function EngineStatus() {
  const [data, setData] = useState<EngineStatusResponse | null>(null);
  useEffect(() => {
    getEngineStatus()
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data) return null;

  const articleKinds = Object.entries(data.articles.byKind24h)
    .sort((a, b) => b[1] - a[1]);

  return (
    <section style={{
      marginTop: 32, padding: 20,
      background: 'rgba(122,162,255,0.04)',
      border: '1px solid rgba(122,162,255,0.2)',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>
          Engine status
          <span style={{
            display: 'inline-block', marginLeft: 8,
            width: 8, height: 8, borderRadius: 4,
            background: '#66bb6a', verticalAlign: 'middle',
          }} title="Live" />
        </h2>
        <span className="muted small" style={{ fontSize: 11 }}>
          Counts pulled live · refreshed on page load
        </span>
      </div>

      <p className="muted small" style={{ margin: '0 0 14px', fontSize: 12, lineHeight: 1.5 }}>
        Operational pulse — what the engine has been doing recently. Articles
        come from the auto-generation cron rhythm; market snapshots come from
        each PrizePicks paste + The Odds API pulls; projections graded means
        a prop has at least one later snapshot to grade against.
      </p>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}>
        <CategoryCard
          label="Articles published"
          value24h={data.articles.last24h}
          value7d={data.articles.last7d}
          valueAllTime={data.articles.allTime}
          mostRecent={data.articles.mostRecent}
          color="#66bb6a"
        />
        <CategoryCard
          label="Market snapshots captured"
          value24h={data.marketSnapshots.last24h}
          value7d={data.marketSnapshots.last7d}
          valueAllTime={data.marketSnapshots.allTime}
          mostRecent={data.marketSnapshots.mostRecent}
          color="#7aa2ff"
        />
        <CategoryCard
          label="Projections graded"
          value24h={null}
          value7d={data.projectionsGraded.last7d}
          valueAllTime={data.projectionsGraded.last30d}
          allTimeLabel="last 30 days"
          mostRecent={null}
          color="#ffd54f"
        />
      </div>

      {articleKinds.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted small" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 6 }}>
            Articles in last 24h, by kind
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {articleKinds.map(([kind, n]) => (
              <span key={kind} style={{
                fontSize: 11, fontWeight: 700,
                padding: '3px 8px',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 4,
                color: 'rgba(255,255,255,0.85)',
              }}>
                {KIND_LABEL[kind] ?? kind} <span style={{ opacity: 0.6 }}>· {n}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function CategoryCard({
  label, value24h, value7d, valueAllTime, allTimeLabel, mostRecent, color,
}: {
  label: string;
  value24h: number | null;
  value7d: number;
  valueAllTime: number;
  allTimeLabel?: string;
  mostRecent: string | null;
  color: string;
}) {
  return (
    <div style={{
      padding: 12,
      background: 'rgba(0,0,0,0.25)',
      border: `1px solid ${color}33`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 6,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
        {value24h !== null && (
          <Stat label="last 24h" value={value24h} primary color={color} />
        )}
        <Stat label="last 7d" value={value7d} />
        <Stat label={allTimeLabel ?? 'all time'} value={valueAllTime} />
      </div>
      {mostRecent && (
        <div className="muted small" style={{ fontSize: 10, marginTop: 8 }}>
          Last activity: {timeAgo(mostRecent)}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, primary, color }: { label: string; value: number; primary?: boolean; color?: string }) {
  return (
    <div>
      <div style={{
        fontSize: primary ? 22 : 14,
        fontWeight: 800,
        color: primary && color ? color : 'inherit',
        lineHeight: 1,
      }}>
        {value.toLocaleString()}
      </div>
      <div className="muted small" style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
