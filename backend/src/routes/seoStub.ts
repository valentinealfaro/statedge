// SSR HTML stubs for social crawlers — Phase 106d.
//
// Twitter/X, Facebook, LinkedIn, Slack, Discord, and most other
// link-unfurlers do NOT execute JavaScript when fetching a URL for
// preview metadata. They fetch once, parse the response HTML for
// <meta property="og:..."> + <meta name="twitter:..."> tags, and
// move on. The SPA in production is a static index.html with
// generic StatEdge meta — every article URL would unfurl identically.
//
// This handler serves a lightweight HTML page with article-specific
// OG/Twitter Card meta. The frontend's vercel.json gates the rewrite
// to bot user-agents only (via a `has` header-match condition), so
// humans never reach this handler — they hit the SPA directly.
// Belt-and-suspenders: a UA double-check here also redirects any
// stray human request back to the SPA in case the rewrite gate is
// reconfigured.

import { Router } from 'express';
import { getArticleBySlug } from '../news/store.js';

export const seoStubRouter: Router = Router();

const SITE_URL = (process.env.SITE_URL ?? 'https://statedge-frontend.vercel.app').replace(/\/$/, '');

// Conservative bot detector. We err on the side of NOT serving the
// stub to humans (false negatives only deliver a fully-rendered SPA,
// which is fine). False positives for humans would feel broken.
//
// Crawlers that respect robots.txt almost universally identify
// themselves with one of these tokens. UA-string matching is good
// enough — we're not gating sensitive content, just choosing which
// of two valid responses to send.
const BOT_UA_PATTERNS = [
  /Twitterbot/i,
  /facebookexternalhit/i,
  /Facebot/i,
  /LinkedInBot/i,
  /Slackbot/i,
  /Discordbot/i,
  /TelegramBot/i,
  /WhatsApp/i,
  /SkypeUriPreview/i,
  /Googlebot/i,
  /Bingbot/i,
  /DuckDuckBot/i,
  /Applebot/i,
  /redditbot/i,
  /Pinterest/i,
  /vkShare/i,
  /Embedly/i,
  /Iframely/i,
];

function isBot(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return BOT_UA_PATTERNS.some((re) => re.test(userAgent));
}

seoStubRouter.get('/news/:slug', async (req, res) => {
  const ua = req.header('user-agent') ?? '';
  const slug = req.params.slug;

  // Humans bounce straight to the SPA. We don't try to render the
  // article body server-side — that's a much bigger engineering
  // commitment and the SPA already does it well.
  if (!isBot(ua)) {
    res.redirect(302, `${SITE_URL}/news/${encodeURIComponent(slug)}`);
    return;
  }

  let article;
  try {
    article = await getArticleBySlug(slug);
  } catch (err) {
    console.warn('seoStub: getArticleBySlug failed', (err as Error).message);
    article = null;
  }

  res.set('Content-Type', 'text/html; charset=utf-8');
  // Crawlers cache aggressively; let them — but allow re-validation
  // every 10 minutes so updates to the article (added video, edited
  // summary) propagate quickly.
  res.set('Cache-Control', 'public, max-age=600, s-maxage=600');

  if (!article) {
    res.status(404).send(notFoundHtml(slug));
    return;
  }

  res.send(articleStubHtml(article));
});

function articleStubHtml(article: {
  slug: string;
  title: string;
  summary: string;
  heroImageUrl: string | null;
  publishedAt: string;
  sport: string;
}): string {
  const url = `${SITE_URL}/news/${encodeURIComponent(article.slug)}`;
  const image = article.heroImageUrl ?? `${SITE_URL}/statedge-logo.png`;

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(article.title)} · StatEdge</title>`,
    `<link rel="canonical" href="${escapeAttr(url)}" />`,
    `<meta name="description" content="${escapeAttr(article.summary)}" />`,
    // Open Graph
    `<meta property="og:type" content="article" />`,
    `<meta property="og:title" content="${escapeAttr(article.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(article.summary)}" />`,
    `<meta property="og:image" content="${escapeAttr(image)}" />`,
    `<meta property="og:url" content="${escapeAttr(url)}" />`,
    `<meta property="og:site_name" content="StatEdge" />`,
    `<meta property="article:published_time" content="${escapeAttr(article.publishedAt)}" />`,
    `<meta property="article:section" content="${escapeAttr(
      article.sport === 'cross' ? 'Sports'
      : article.sport === 'mma' ? 'UFC'
      : article.sport.toUpperCase()
    )}" />`,
    // Twitter / X
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeAttr(article.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(article.summary)}" />`,
    `<meta name="twitter:image" content="${escapeAttr(image)}" />`,
    // Visible body — minimal but indexable. Search-engine bots
    // (Googlebot, Bingbot) read the body as well as the meta tags.
    '</head>',
    '<body>',
    `<h1>${escapeHtml(article.title)}</h1>`,
    `<p>${escapeHtml(article.summary)}</p>`,
    `<p><a href="${escapeAttr(url)}">Read on StatEdge</a></p>`,
    '</body>',
    '</html>',
  ].join('\n');
}

function notFoundHtml(slug: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8" />',
    `<title>Article not found · StatEdge</title>`,
    `<meta name="robots" content="noindex" />`,
    '</head><body>',
    `<p>No article found for slug: ${escapeHtml(slug)}</p>`,
    '</body></html>',
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
