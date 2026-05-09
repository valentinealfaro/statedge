// LatestNewsRail — Phase 108a.
//
// Compact 4-up rail of the most-recent auto-generated articles. Drops
// onto the home page (and optionally sport hubs) to put news content
// where users actually land. Hides itself when no articles exist —
// silent rather than empty placeholder.
//
// Optional `sport` filter narrows to one league. Without it, shows
// the latest across all sports — first thing a returning user sees
// is "what's new since I was last here."

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listArticles, type Article } from './api';

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
  situation_report:   'Situation Report',
};

type Props = {
  sport?: 'mlb' | 'nba' | 'wnba' | 'mma';
  // Sorted team-pair like "BOS-NYY" — matches articles.related_game_key
  // shape produced by templates.gameKeyFromGame. Game-detail pages
  // pass this so the rail shows only articles about that matchup.
  gameKey?: string;
  limit?: number;
  heading?: string;
};

export function LatestNewsRail({ sport, gameKey, limit = 4, heading }: Props) {
  const [articles, setArticles] = useState<Article[] | null>(null);
  useEffect(() => {
    listArticles({ sport, gameKey, limit })
      .then((r) => setArticles(r.articles))
      .catch(() => setArticles([]));
  }, [sport, gameKey, limit]);

  // Silent until loaded; silent forever if nothing to show.
  if (!articles || articles.length === 0) return null;

  return (
    <section style={{ margin: '32px auto', maxWidth: 1200, padding: '0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>
          {heading ?? (sport ? `${sport.toUpperCase()} Latest` : 'Latest from the Engine')}
        </h2>
        <Link to="/news" style={{ fontSize: 12, fontWeight: 700, color: '#7aa2ff', textDecoration: 'none' }}>
          All news →
        </Link>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${articles.length === 1 ? '100%' : '260px'}, 1fr))`,
        gap: 12,
      }}>
        {articles.map((a) => <RailCard key={a.id} article={a} />)}
      </div>
    </section>
  );
}

function RailCard({ article }: { article: Article }) {
  const color = SPORT_COLOR[article.sport] ?? '#cccccc';
  const kindLabel = KIND_LABEL[article.kind] ?? article.kind;
  return (
    <Link
      to={`/news/${article.slug}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${color}33`,
        borderTop: `3px solid ${color}`,
        borderRadius: 6,
        textDecoration: 'none',
        color: 'inherit',
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      {article.heroImageUrl && (
        <img
          src={article.heroImageUrl}
          alt=""
          loading="lazy"
          style={{ width: '100%', height: 110, objectFit: 'cover', background: 'rgba(255,255,255,0.05)' }}
        />
      )}
      <div style={{ padding: 10, flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 9, fontWeight: 800, letterSpacing: '0.08em',
            color, textTransform: 'uppercase',
          }}>
            {kindLabel}
          </span>
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
            color: 'rgba(255,255,255,0.5)',
          }}>
            {article.sport === 'cross' ? 'CROSS' : article.sport.toUpperCase()}
          </span>
        </div>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 800, lineHeight: 1.3 }}>
          {article.title}
        </h3>
        <p className="muted small" style={{ margin: '4px 0 0', fontSize: 11, lineHeight: 1.4, flex: 1 }}>
          {article.summary.length > 110 ? article.summary.slice(0, 110) + '…' : article.summary}
        </p>
        <div className="muted small" style={{ fontSize: 10, marginTop: 6 }}>
          {timeAgo(article.publishedAt)}
        </div>
      </div>
    </Link>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
