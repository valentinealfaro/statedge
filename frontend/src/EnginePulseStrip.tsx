// EnginePulseStrip — Phase 125.
//
// Bloomberg-Terminal pattern: every visitor should see the engine
// pulse, not just users who navigate to the Methodology page. This
// is a compact horizontal strip that drops under the hero on Home.
// Three live chips: latest article, articles published today,
// snapshots captured today. Each chip is click-through to the
// relevant page.
//
// Self-hides when no data lands — better than a row of "—" for the
// few seconds before fetches resolve.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getEngineStatus,
  getMlbDailySlate,
  getTodaySlate,
  listArticles,
  type Article,
  type EngineStatusResponse,
} from './api';

const SPORT_COLOR: Record<string, string> = {
  cross: '#ffd54f',
  mlb:   '#66bb6a',
  nba:   '#7aa2ff',
  wnba:  '#b388ff',
  mma:   '#ef5350',
};

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
};

export function EnginePulseStrip() {
  const [status, setStatus] = useState<EngineStatusResponse | null>(null);
  const [latest, setLatest] = useState<Article | null>(null);
  const [nbaSlateAt, setNbaSlateAt] = useState<string | null>(null);
  const [mlbSlateAt, setMlbSlateAt] = useState<string | null>(null);

  useEffect(() => {
    getEngineStatus().then(setStatus).catch(() => setStatus(null));
    listArticles({ limit: 1 })
      .then((r) => setLatest(r.articles[0] ?? null))
      .catch(() => setLatest(null));
    getTodaySlate('balanced')
      .then((r) => setNbaSlateAt(r.slate?.updatedAt ?? null))
      .catch(() => setNbaSlateAt(null));
    getMlbDailySlate()
      .then((r) => setMlbSlateAt(r.slate?.updatedAt ?? null))
      .catch(() => setMlbSlateAt(null));
  }, []);

  // Don't render until at least one data source resolves and has
  // something meaningful. The strip is high-visibility chrome —
  // empty state is worse than no state.
  const hasArticles = status && status.articles.allTime > 0;
  const hasSnapshots = status && status.marketSnapshots.allTime > 0;
  const hasSlates = nbaSlateAt !== null || mlbSlateAt !== null;
  if (!hasArticles && !hasSnapshots && !latest && !hasSlates) return null;

  return (
    <section
      style={{
        position: 'relative',
        margin: '12px auto 0',
        maxWidth: 1100,
        padding: '12px 16px',
        background: `
          linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
          var(--surface-1)
        `,
        border: '1px solid rgba(122,162,255,0.20)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        flexWrap: 'wrap',
        fontSize: 12,
        overflow: 'hidden',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(102,187,106,0.55), transparent)',
      }} />
      <span style={{
        fontSize: 9, fontWeight: 800, letterSpacing: '0.10em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.60)',
        whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span className="live-pulse" style={{
          display: 'inline-block', width: 7, height: 7, borderRadius: 3.5,
          background: '#66bb6a',
        }} title="Engine running" />
        Engine pulse
      </span>

      {nbaSlateAt && (
        <Link
          to="/nba/slate"
          style={{
            color: 'inherit', textDecoration: 'none',
            fontSize: 11, whiteSpace: 'nowrap', display: 'flex', alignItems: 'baseline', gap: 4,
          }}
          title={`NBA slate last updated ${new Date(nbaSlateAt).toLocaleString()}`}
        >
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', color: '#7aa2ff', textTransform: 'uppercase' }}>NBA</span>
          <span className="muted small" style={{ fontSize: 10 }}>{timeAgo(nbaSlateAt)}</span>
        </Link>
      )}

      {mlbSlateAt && (
        <Link
          to="/mlb/slate"
          style={{
            color: 'inherit', textDecoration: 'none',
            fontSize: 11, whiteSpace: 'nowrap', display: 'flex', alignItems: 'baseline', gap: 4,
          }}
          title={`MLB slate last updated ${new Date(mlbSlateAt).toLocaleString()}`}
        >
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', color: '#66bb6a', textTransform: 'uppercase' }}>MLB</span>
          <span className="muted small" style={{ fontSize: 10 }}>{timeAgo(mlbSlateAt)}</span>
        </Link>
      )}

      {latest && (
        <Link
          to={`/news/${latest.slug}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            color: 'inherit', textDecoration: 'none',
            minWidth: 0, flex: '1 1 280px',
          }}
        >
          <span style={{
            fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
            color: SPORT_COLOR[latest.sport] ?? '#cccccc',
            textTransform: 'uppercase', whiteSpace: 'nowrap',
          }}>
            {KIND_LABEL[latest.kind] ?? latest.kind} · {
              latest.sport === 'cross' ? 'XS'
              : latest.sport === 'mma' ? 'UFC'
              : latest.sport.toUpperCase()
            }
          </span>
          <span style={{
            fontSize: 12, fontWeight: 600,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            flex: 1, minWidth: 0,
          }}>
            {latest.title}
          </span>
          <span className="muted small" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
            {timeAgo(latest.publishedAt)}
          </span>
        </Link>
      )}

      {status && status.articles.last24h > 0 && (
        <Link to="/news" style={{
          color: 'inherit', textDecoration: 'none',
          fontSize: 11, whiteSpace: 'nowrap', display: 'flex', alignItems: 'baseline', gap: 4,
        }}>
          <strong style={{ color: '#66bb6a' }}>{status.articles.last24h}</strong>
          <span className="muted small" style={{ fontSize: 10 }}>articles · 24h</span>
        </Link>
      )}

      {status && status.marketSnapshots.last24h > 0 && (
        <Link to="/methodology" style={{
          color: 'inherit', textDecoration: 'none',
          fontSize: 11, whiteSpace: 'nowrap', display: 'flex', alignItems: 'baseline', gap: 4,
        }}>
          <strong style={{ color: '#7aa2ff' }}>{status.marketSnapshots.last24h.toLocaleString()}</strong>
          <span className="muted small" style={{ fontSize: 10 }}>snapshots · 24h</span>
        </Link>
      )}

      <Link
        to="/methodology"
        style={{
          marginLeft: 'auto',
          fontSize: 11, fontWeight: 700, color: '#7aa2ff',
          textDecoration: 'none', whiteSpace: 'nowrap',
        }}
      >
        Engine status →
      </Link>
    </section>
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
