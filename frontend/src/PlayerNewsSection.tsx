// PlayerNewsSection — Phase 105.
//
// Drops onto a player log page. Three columns of context:
//   1. StatEdge articles about this player (auto-generated)
//   2. External news headlines (Google News passthrough)
//   3. Social / reference search links
//
// The whole section silently no-ops when the bundle is empty — better
// than a "no news" placeholder cluttering the page for journeymen who
// don't make headlines.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getPlayerNewsBundle, type PlayerProfileBundle } from './api';

type Props = {
  sport: 'mlb' | 'nba' | 'wnba' | 'mma';
  playerId: string | number;
  playerName: string;
};

export function PlayerNewsSection({ sport, playerId, playerName }: Props) {
  const [bundle, setBundle] = useState<PlayerProfileBundle | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!playerId || !playerName) return;
    setLoading(true);
    getPlayerNewsBundle({ sport, id: playerId, name: playerName })
      .then(setBundle)
      .catch(() => setBundle(null))
      .finally(() => setLoading(false));
  }, [sport, playerId, playerName]);

  if (loading && !bundle) return null;
  if (!bundle) return null;

  const hasArticles = bundle.articles.length > 0;
  const hasExternal = bundle.externalHeadlines.length > 0;
  const hasLinks = bundle.searchLinks.length > 0;
  if (!hasArticles && !hasExternal && !hasLinks) return null;

  return (
    <section style={{ marginTop: 24, padding: 16, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>
        News & Links
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16, marginTop: 12 }}>
        <div>
          <SectionLabel>StatEdge Analysis</SectionLabel>
          {hasArticles ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {bundle.articles.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <Link to={`/news/${a.slug}`} style={{ color: '#7aa2ff', textDecoration: 'none', fontSize: 13, lineHeight: 1.4, fontWeight: 600 }}>
                    {a.title}
                  </Link>
                  <div className="muted small" style={{ fontSize: 11, marginTop: 2 }}>
                    {timeAgo(a.publishedAt)}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyMsg>No StatEdge articles yet. They'll appear after the next slate publish or big game.</EmptyMsg>
          )}
        </div>

        <div>
          <SectionLabel>Around the Web</SectionLabel>
          {hasExternal ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {bundle.externalHeadlines.slice(0, 6).map((h) => (
                <li key={h.link}>
                  <a href={h.link} target="_blank" rel="noreferrer" style={{ color: 'rgba(255,255,255,0.85)', textDecoration: 'none', fontSize: 13, lineHeight: 1.4, fontWeight: 500 }}>
                    {h.title}
                  </a>
                  <div className="muted small" style={{ fontSize: 11, marginTop: 2 }}>
                    {h.source ?? 'Source'}{h.publishedAt ? ` · ${timeAgo(h.publishedAt)}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyMsg>No recent headlines.</EmptyMsg>
          )}
        </div>

        <div>
          <SectionLabel>Search the Web</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {bundle.searchLinks.map((l) => (
              <a
                key={l.url}
                href={l.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-block',
                  padding: '6px 10px',
                  background: l.kind === 'social' ? 'rgba(122,162,255,0.08)' : 'rgba(255,213,79,0.08)',
                  border: `1px solid ${l.kind === 'social' ? 'rgba(122,162,255,0.3)' : 'rgba(255,213,79,0.3)'}`,
                  borderRadius: 4,
                  color: l.kind === 'social' ? '#7aa2ff' : '#ffd54f',
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  textDecoration: 'none',
                }}
              >
                {l.label} →
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', marginBottom: 8 }}>
      {children}
    </div>
  );
}

function EmptyMsg({ children }: { children: React.ReactNode }) {
  return (
    <div className="muted small" style={{ fontSize: 12, fontStyle: 'italic', lineHeight: 1.4 }}>
      {children}
    </div>
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
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}
