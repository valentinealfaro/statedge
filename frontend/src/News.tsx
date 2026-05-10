// /news — Phase 104 news index page.
//
// Lists recent auto-generated articles, filterable by sport. Each
// article links to its detail page. Hero image + summary + kind tag
// form the card. Prioritizes "today's content" — older articles
// drop down the page naturally via published_at DESC ordering.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listArticles, type Article } from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

type SportFilter = 'all' | 'mlb' | 'nba' | 'wnba' | 'mma';

const SPORT_COLOR: Record<string, string> = {
  cross: '#ffd54f',
  mlb:   '#66bb6a',
  nba:   '#7aa2ff',
  wnba:  '#b388ff',
  mma:   '#ef5350',
};

// User-facing labels — 'mma' is internal, the audience-facing label
// is 'UFC' (matches the pill / NavBar / CSV exports). Mirrors the
// SPORT_LABEL maps in StarredPage / NavSearch.
const SPORT_LABEL: Record<string, string> = {
  all:  'All',
  nba:  'NBA',
  mlb:  'MLB',
  mma:  'UFC',
  wnba: 'WNBA',
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
  elite_play:         '★ Elite Play',
  situation_report:   'Situation Report',
};

export function News() {
  useTitle(['News']);
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sportFilter, setSportFilter] = useState<SportFilter>('all');

  useEffect(() => {
    setArticles(null);
    setError(null);
    listArticles({
      sport: sportFilter === 'all' ? undefined : sportFilter,
      limit: 50,
    })
      .then((r) => setArticles(r.articles))
      .catch((err: Error) => setError(err.message));
  }, [sportFilter]);

  const counts = useMemo(() => {
    if (!articles) return null;
    const out: Record<string, number> = { all: articles.length };
    for (const a of articles) out[a.sport] = (out[a.sport] ?? 0) + 1;
    return out;
  }, [articles]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>News</h1>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 16 }}>
          Auto-generated analysis from the StatEdge model — market dislocations,
          trap watch, big-game recaps, CLV reports. Original content from our
          own data, no scraping.
        </p>

        <div role="tablist" style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
          {/* Tab order tracks the 2026-05-09 sport-priorities decision:
              All · NBA · MLB · UFC (focus sports) · WNBA (maintenance). */}
          {(['all', 'nba', 'mlb', 'mma', 'wnba'] as const).map((tab) => {
            const active = sportFilter === tab;
            const color = tab === 'all' ? '#cccccc' : SPORT_COLOR[tab];
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSportFilter(tab)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 4,
                  border: `1px solid ${active ? color : 'rgba(255,255,255,0.1)'}`,
                  background: active ? `${color}1a` : 'transparent',
                  color: active ? color : 'rgba(255,255,255,0.65)',
                  fontWeight: 700,
                  fontSize: 12,
                  letterSpacing: '0.04em',
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                }}
              >
                {SPORT_LABEL[tab]}
                {counts && counts[tab] !== undefined && (
                  <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 500 }}>{counts[tab]}</span>
                )}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="mlb-info-banner mlb-info-error">News load failed: {error}</div>
        )}

        {!articles && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Skeleton width="100%" height={120} />
            <Skeleton width="100%" height={120} />
            <Skeleton width="100%" height={120} />
          </div>
        )}

        {articles && articles.length === 0 && (
          <div
            style={{
              padding: '32px 16px',
              background: 'rgba(255,255,255,0.02)',
              border: '1px dashed rgba(255,255,255,0.1)',
              borderRadius: 6,
              textAlign: 'center',
            }}
            className="muted small"
          >
            No articles published yet. Articles auto-generate at slate publish + after big games settle.
          </div>
        )}

        {articles && articles.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {articles.map((a) => <ArticleCard key={a.id} article={a} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function ArticleCard({ article }: { article: Article }) {
  const color = SPORT_COLOR[article.sport] ?? '#cccccc';
  const kindLabel = KIND_LABEL[article.kind] ?? article.kind;
  return (
    <Link
      to={`/news/${article.slug}`}
      className="news-card"
      style={{
        position: 'relative',
        display: 'flex',
        gap: 14,
        padding: 14,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 30%), var(--surface-1)',
        border: `1px solid ${color}30`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 10,
        textDecoration: 'none',
        color: 'inherit',
        boxShadow: '0 1px 0 rgba(255,255,255,0.04) inset, 0 4px 14px rgba(0,0,0,0.30)',
        transition: 'transform 200ms cubic-bezier(0.4,0,0.2,1), border-color 200ms, box-shadow 200ms',
      }}
    >
      {article.heroImageUrl && (
        <img
          src={article.heroImageUrl}
          alt=""
          loading="lazy"
          style={{
            width: 100,
            height: 100,
            objectFit: 'cover',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.05)',
            flexShrink: 0,
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 4px 10px rgba(0,0,0,0.25)',
          }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4, flexWrap: 'wrap' }}>
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
            {article.sport === 'cross'
              ? 'CROSS-SPORT'
              : (SPORT_LABEL[article.sport] ?? article.sport.toUpperCase())}
          </span>
          <span className="muted small" style={{ fontSize: 11 }}>
            {timeAgo(article.publishedAt)}
          </span>
        </div>
        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 800, lineHeight: 1.3 }}>
          {article.title}
        </h3>
        <p className="muted small" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
          {article.summary}
        </p>
      </div>
    </Link>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
