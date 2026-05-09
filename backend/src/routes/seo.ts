// SEO endpoints — Phase 104h.
//
// /sitemap.xml — XML sitemap that lists every public route plus
// every article. Search engines fetch this to discover content.
//
// /rss.xml — RSS 2.0 feed of recent articles. Feed readers and
// content aggregators consume this. Both endpoints are mounted at
// the express app root (NOT under /api) so the public URLs are
// /sitemap.xml and /rss.xml as conventional. Vercel rewrites on
// the frontend domain proxy these paths to the backend.
//
// Note on URL choices: every URL in these feeds points at the
// FRONTEND origin (where humans actually land), not the backend
// API. SITE_URL env var overrides the default for non-prod.

import { Router } from 'express';
import { listArticles } from '../news/store.js';

export const seoRouter: Router = Router();

const SITE_URL = (process.env.SITE_URL ?? 'https://statedge-frontend.vercel.app').replace(/\/$/, '');

// Static routes that should appear in the sitemap. The article URLs
// get appended dynamically below. Slate / compare / standings change
// daily; news index changes whenever a new article publishes.
const STATIC_PATHS: Array<{ path: string; changefreq: string; priority: number }> = [
  { path: '/',                    changefreq: 'daily',  priority: 1.0 },
  { path: '/news',                changefreq: 'hourly', priority: 0.9 },
  { path: '/pricing',             changefreq: 'monthly', priority: 0.5 },
  { path: '/nba/compare',         changefreq: 'daily',  priority: 0.7 },
  { path: '/nba/slate',           changefreq: 'hourly', priority: 0.8 },
  { path: '/nba/standings',       changefreq: 'daily',  priority: 0.6 },
  { path: '/mlb/compare',         changefreq: 'daily',  priority: 0.7 },
  { path: '/mlb/slate',           changefreq: 'hourly', priority: 0.8 },
  { path: '/mlb/standings',       changefreq: 'daily',  priority: 0.6 },
];

seoRouter.get('/sitemap.xml', async (_req, res) => {
  try {
    const articles = await listArticles({ limit: 200 });
    const now = new Date().toISOString();

    const urls: string[] = [];

    for (const s of STATIC_PATHS) {
      urls.push(
        `<url>` +
          `<loc>${escapeXml(SITE_URL + s.path)}</loc>` +
          `<lastmod>${now}</lastmod>` +
          `<changefreq>${s.changefreq}</changefreq>` +
          `<priority>${s.priority.toFixed(1)}</priority>` +
        `</url>`,
      );
    }

    for (const a of articles) {
      urls.push(
        `<url>` +
          `<loc>${escapeXml(`${SITE_URL}/news/${a.slug}`)}</loc>` +
          `<lastmod>${a.updatedAt}</lastmod>` +
          `<changefreq>weekly</changefreq>` +
          `<priority>0.7</priority>` +
        `</url>`,
      );
    }

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.join('\n') +
      `\n</urlset>\n`;

    res.set('Content-Type', 'application/xml; charset=utf-8');
    // Sitemaps are reasonably cacheable since they only change when
    // new articles publish (every few hours). 5 minutes keeps it
    // close to fresh without hammering the DB on each crawl.
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.send(xml);
  } catch (err) {
    console.error('sitemap.xml failed', err);
    res.status(500).send('<?xml version="1.0"?><error/>');
  }
});

seoRouter.get('/rss.xml', async (_req, res) => {
  try {
    const articles = await listArticles({ limit: 50 });
    const buildDate = new Date().toUTCString();

    const items = articles.map((a) => {
      const link = `${SITE_URL}/news/${a.slug}`;
      return (
        `<item>` +
          `<title>${escapeXml(a.title)}</title>` +
          `<link>${escapeXml(link)}</link>` +
          `<guid isPermaLink="true">${escapeXml(link)}</guid>` +
          `<pubDate>${new Date(a.publishedAt).toUTCString()}</pubDate>` +
          `<description>${escapeXml(a.summary)}</description>` +
          `<category>${escapeXml(a.sport.toUpperCase())}</category>` +
          (a.heroImageUrl
            ? `<enclosure url="${escapeXml(a.heroImageUrl)}" type="image/jpeg"/>`
            : '') +
        `</item>`
      );
    }).join('\n');

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
      `<channel>\n` +
        `<title>StatEdge News</title>\n` +
        `<link>${SITE_URL}/news</link>\n` +
        `<atom:link href="${SITE_URL}/rss.xml" rel="self" type="application/rss+xml"/>\n` +
        `<description>Quantitative sports intelligence — market dislocations, trap watch, big-game recaps. Auto-generated from the StatEdge model.</description>\n` +
        `<language>en-us</language>\n` +
        `<lastBuildDate>${buildDate}</lastBuildDate>\n` +
        items + '\n' +
      `</channel>\n` +
      `</rss>\n`;

    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.send(xml);
  } catch (err) {
    console.error('rss.xml failed', err);
    res.status(500).send('<?xml version="1.0"?><error/>');
  }
});

// Robots.txt — points at the sitemap and allows everything. No
// gating on /admin since admin endpoints require a header secret
// anyway; crawlers that hit them will get 401s and learn to skip.
seoRouter.get('/robots.txt', (_req, res) => {
  const body =
    `User-agent: *\n` +
    `Allow: /\n` +
    `\n` +
    `Sitemap: ${SITE_URL}/sitemap.xml\n`;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(body);
});

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
