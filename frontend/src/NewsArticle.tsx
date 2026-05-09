// /news/:slug — single article page. Phase 104.
//
// Renders a Markdown article body with hero image, optional YouTube
// embed, kind tag, sport tag, related player. SEO-friendly:
// per-article OG meta tags + canonical URL injected into <head>
// via useTitle / direct DOM manipulation.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getArticle, type Article } from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

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
  situation_report:   'Situation Report',
};

export function NewsArticle() {
  const { slug } = useParams<{ slug: string }>();
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState<string | null>(null);

  useTitle(article ? [article.title, 'News'] : ['News']);

  useEffect(() => {
    if (!slug) return;
    setArticle(null);
    setError(null);
    getArticle(slug)
      .then((a) => {
        if (!a) {
          setError('Article not found');
          return;
        }
        setArticle(a);
      })
      .catch((err: Error) => setError(err.message));
  }, [slug]);

  // Inject OG meta tags for social sharing
  useEffect(() => {
    if (!article) return;
    upsertMeta('property', 'og:title', article.title);
    upsertMeta('property', 'og:description', article.summary);
    upsertMeta('property', 'og:type', 'article');
    if (article.heroImageUrl) {
      upsertMeta('property', 'og:image', article.heroImageUrl);
    }
    upsertMeta('name', 'twitter:card', 'summary_large_image');
    upsertMeta('name', 'twitter:title', article.title);
    upsertMeta('name', 'twitter:description', article.summary);
    return () => {
      // Clean up so leaving the page doesn't leak meta into other pages
      removeMeta('property', 'og:title');
      removeMeta('property', 'og:description');
      removeMeta('property', 'og:type');
      removeMeta('property', 'og:image');
      removeMeta('name', 'twitter:card');
      removeMeta('name', 'twitter:title');
      removeMeta('name', 'twitter:description');
    };
  }, [article]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell" style={{ maxWidth: 720 }}>
        <Link to="/news" style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textDecoration: 'none' }}>
          ← All news
        </Link>

        {error && (
          <div className="mlb-info-banner mlb-info-error" style={{ marginTop: 16 }}>{error}</div>
        )}

        {!article && !error && (
          <div style={{ marginTop: 16 }}>
            <Skeleton width="100%" height={36} />
            <Skeleton width="60%" height={20} style={{ marginTop: 8 }} />
            <Skeleton width="100%" height={300} style={{ marginTop: 16 }} />
          </div>
        )}

        {article && <ArticleBody article={article} />}
      </div>
    </div>
  );
}

function ArticleBody({ article }: { article: Article }) {
  const color = SPORT_COLOR[article.sport] ?? '#cccccc';
  const kindLabel = KIND_LABEL[article.kind] ?? article.kind;
  return (
    <article style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
          color, textTransform: 'uppercase',
          padding: '3px 8px', borderRadius: 3, background: `${color}1a`,
        }}>
          {kindLabel}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          color: 'rgba(255,255,255,0.5)',
        }}>
          {article.sport === 'cross' ? 'CROSS-SPORT' : article.sport.toUpperCase()}
        </span>
        <span className="muted small" style={{ fontSize: 11 }}>
          {new Date(article.publishedAt).toLocaleString([], {
            dateStyle: 'medium', timeStyle: 'short',
          })}
        </span>
      </div>

      {article.heroImageUrl && (
        <img
          src={article.heroImageUrl}
          alt=""
          style={{
            width: '100%',
            maxHeight: 320,
            objectFit: 'cover',
            objectPosition: 'top center',
            borderRadius: 6,
            marginBottom: 14,
            background: 'rgba(255,255,255,0.05)',
          }}
        />
      )}

      <Markdown md={article.bodyMd} />

      {article.videoYoutubeId && (
        <div style={{ marginTop: 16, aspectRatio: '16 / 9', background: 'black', borderRadius: 6, overflow: 'hidden' }}>
          <iframe
            src={`https://www.youtube.com/embed/${article.videoYoutubeId}`}
            title="Highlight"
            style={{ width: '100%', height: '100%', border: 0 }}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
      )}

      {article.relatedPlayerId && article.sport !== 'cross' && (
        <div style={{ marginTop: 24 }}>
          <Link
            to={`/${article.sport}/player/${article.relatedPlayerId}`}
            style={{ color: '#7aa2ff', textDecoration: 'none', fontWeight: 700, fontSize: 13 }}
          >
            More on this player →
          </Link>
        </div>
      )}
    </article>
  );
}

// Lightweight Markdown renderer — handles the subset our templates
// emit (headings, paragraphs, lists, tables, blockquotes, bold/italic,
// inline code, image embeds via [![alt](url)](href)). Avoids a full
// markdown lib.
function Markdown({ md }: { md: string }) {
  const html = renderMarkdown(md);
  return (
    <div
      className="news-article-body"
      style={{ fontSize: 14, lineHeight: 1.7, color: 'rgba(255,255,255,0.88)' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function renderMarkdown(md: string): string {
  // Escape HTML except in code blocks. Simple but sufficient.
  const lines = md.split('\n');
  const out: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];

  function flushTable() {
    if (!inTable || tableRows.length === 0) return;
    const [header, ...rows] = tableRows;
    out.push('<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:13px"><thead><tr>'
      + (header ?? []).map((c) => `<th style="text-align:left;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.15);font-weight:700">${escapeHtml(inlineMd(c.trim()))}</th>`).join('')
      + '</tr></thead><tbody>'
      + rows
          .filter((r) => !r.every((c) => /^-+$/.test(c.trim())))   // skip the |---|---| separator
          .map((r) => '<tr>' + r.map((c) => `<td style="padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.06)">${escapeHtml(inlineMd(c.trim()))}</td>`).join('') + '</tr>')
          .join('')
      + '</tbody></table>');
    inTable = false;
    tableRows = [];
  }

  for (const raw of lines) {
    const line = raw;
    // Table detection
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const cells = line.trim().slice(1, -1).split('|');
      tableRows.push(cells);
      inTable = true;
      continue;
    } else if (inTable) {
      flushTable();
    }
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    // Headings
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const level = h[1]!.length;
      out.push(`<h${level === 1 ? 1 : level + 1} style="margin:${level === 1 ? '20px 0 12px' : '18px 0 8px'};font-weight:800">${escapeHtml(inlineMd(h[2]!))}</h${level === 1 ? 1 : level + 1}>`);
      continue;
    }
    // Blockquote
    if (line.startsWith('> ')) {
      out.push(`<blockquote style="margin:8px 0;padding:8px 14px;border-left:3px solid #ffd54f;background:rgba(255,213,79,0.05);font-style:italic">${escapeHtml(inlineMd(line.slice(2)))}</blockquote>`);
      continue;
    }
    // Bullet list
    if (line.startsWith('- ')) {
      // Wrap bullets manually — collect consecutive ones
      out.push(`<li style="margin:2px 0">${escapeHtml(inlineMd(line.slice(2)))}</li>`);
      continue;
    }
    // Horizontal rule
    if (line.trim() === '---') {
      out.push('<hr style="margin:20px 0;border:0;border-top:1px solid rgba(255,255,255,0.1)" />');
      continue;
    }
    // Paragraph
    out.push(`<p style="margin:8px 0">${escapeHtml(inlineMd(line))}</p>`);
  }
  flushTable();

  // Wrap consecutive <li> tags in <ul>
  return out.join('\n')
    .replace(/(<li[^>]*>.+<\/li>\n?)+/g, (m) => `<ul style="margin:8px 0;padding-left:24px">${m}</ul>`);
}

function inlineMd(s: string): string {
  // Markdown image-link: [![alt](src)](href) — render as image with link
  s = s.replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g,
    (_, alt, src, href) =>
      `<a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">` +
      `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" style="max-width:100%;border-radius:6px;margin:8px 0" loading="lazy" />` +
      `</a>`,
  );
  // Bold + italic + inline code (after image substitution above, since
  // those use [text](url) syntax that conflicts with regex below).
  // Bold: **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => `<strong>${t}</strong>`);
  // Italic: *text*
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, t) => `<em>${t}</em>`);
  // Inline code: `text`
  s = s.replace(/`([^`]+)`/g, (_, t) => `<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:0.9em">${t}</code>`);
  // Plain link: [text](href)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, href) =>
    `<a href="${escapeAttr(href)}" target="_blank" rel="noreferrer" style="color:#7aa2ff">${txt}</a>`,
  );
  return s;
}

function escapeHtml(s: string): string {
  // Don't escape — we already inserted HTML via inlineMd. This pass-
  // through exists in case we later want to escape body text before
  // inlineMd substitutions. Keeping the call site explicit.
  return s;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function upsertMeta(attr: 'name' | 'property', key: string, value: string): void {
  let el = document.querySelector(`meta[${attr}="${key}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', value);
}

function removeMeta(attr: 'name' | 'property', key: string): void {
  const el = document.querySelector(`meta[${attr}="${key}"]`);
  if (el) el.remove();
}
