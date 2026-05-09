// PastElitePlays — Phase 141.
//
// Historical track record on /elite. Pulls the last N elite_play
// articles from the news store (auto-generated whenever the cross-
// sport endpoint produces a ticket) and renders a compact list:
// date, grade, headline (title), and a link to the full breakdown.
//
// Builds institutional credibility — users see the engine has been
// publishing picks day after day, not just "look at today." Self-
// hides until at least one historical pick exists.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listArticles, type Article } from './api';

export function PastElitePlays() {
  const [articles, setArticles] = useState<Article[] | null>(null);

  useEffect(() => {
    listArticles({ kind: 'elite_play', limit: 14 })
      .then((r) => setArticles(r.articles))
      .catch(() => setArticles([]));
  }, []);

  if (!articles || articles.length === 0) return null;

  // The current (most-recent) play is rendered above this section
  // by the main Elite page, so skip it in the history list.
  const past = articles.slice(1);
  if (past.length === 0) return null;

  return (
    <section style={{
      marginTop: 32, padding: 20,
      background: 'rgba(0,0,0,0.2)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>
          Past Elite plays
        </h2>
        <Link to="/news?kind=elite_play" style={{ fontSize: 11, fontWeight: 700, color: '#7aa2ff', textDecoration: 'none' }}>
          All Elite articles →
        </Link>
      </div>

      <p className="muted small" style={{ margin: '0 0 14px', fontSize: 12, lineHeight: 1.5 }}>
        Every Elite ticket the engine has produced. Each article carries the full leg
        breakdown + tier label + grade as it was published. Track-record context for
        users evaluating whether to trust today's play.
      </p>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {past.map((a) => <PastPlayItem key={a.id} article={a} />)}
      </ul>
    </section>
  );
}

function PastPlayItem({ article }: { article: Article }) {
  // Title comes through as: "Today's Elite Play · A · 8.2× MLB + NBA"
  // Best-effort split for the compact list.
  const segments = article.title.split('·').map((s) => s.trim());
  const grade = segments[1] ?? '';
  const detail = segments.slice(2).join(' · ');

  const gradeColor = grade.startsWith('A+') ? '#66bb6a'
    : grade.startsWith('A')  ? '#7aa2ff'
    : grade.startsWith('B')  ? '#ffd54f'
    : 'rgba(255,255,255,0.65)';

  const date = new Date(article.publishedAt).toLocaleDateString([], {
    month: 'short', day: 'numeric',
  });

  return (
    <li>
      <Link
        to={`/news/${article.slug}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '10px 12px',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderLeft: `3px solid ${gradeColor}`,
          borderRadius: 5,
          color: 'inherit', textDecoration: 'none',
        }}
      >
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
          color: 'rgba(255,255,255,0.55)',
          minWidth: 56, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}>
          {date}
        </div>
        <div style={{
          fontSize: 18, fontWeight: 900, color: gradeColor,
          minWidth: 36,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}>
          {grade.replace(/^Today's Elite Play · /, '') || '—'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {detail || article.summary}
          </div>
          <div className="muted small" style={{ fontSize: 11, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {article.summary}
          </div>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#7aa2ff', whiteSpace: 'nowrap' }}>
          View →
        </div>
      </Link>
    </li>
  );
}
