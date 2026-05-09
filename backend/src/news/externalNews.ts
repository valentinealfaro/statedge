// External news fetcher — Phase 105.
//
// Pulls headlines from Google News' public RSS feed for a player or
// keyword. Used on the player profile page so users see "what the
// world is saying about Wembanyama" alongside our own analysis.
//
// We deliberately don't store these headlines — they're a passthrough.
// Stale headlines on a player page would be worse than no headlines.
// Cached for 10 minutes to keep upstream load down.

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { fetchedAt: number; items: ExternalHeadline[] }>();

export type ExternalHeadline = {
  title: string;
  link: string;
  source: string | null;
  publishedAt: string | null;
};

export async function fetchGoogleNewsHeadlines(
  query: string,
  opts?: { limit?: number },
): Promise<ExternalHeadline[]> {
  const limit = Math.min(20, Math.max(1, opts?.limit ?? 8));
  const cacheKey = `gnews::${query.toLowerCase()}::${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.items;
  }

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  let xml = '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StatEdgeBot/1.0)' },
    });
    if (!res.ok) return [];
    xml = await res.text();
  } catch (err) {
    console.warn('googleNews fetch failed', (err as Error).message);
    return [];
  }

  const items = parseRssItems(xml).slice(0, limit);
  cache.set(cacheKey, { fetchedAt: Date.now(), items });
  return items;
}

// Lightweight RSS item extractor. Google News RSS is well-formed and
// uses a small subset of the RSS spec, so a regex pass is fine. Each
// item looks like:
//
//   <item>
//     <title>Headline ... - SourceName</title>
//     <link>https://...</link>
//     <pubDate>Sat, 09 May 2026 14:32:00 GMT</pubDate>
//     <source url="https://...">SourceName</source>
//     <description>...</description>
//   </item>
function parseRssItems(xml: string): ExternalHeadline[] {
  const out: ExternalHeadline[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1] ?? '';
    const title = pickTag(block, 'title');
    const link = pickTag(block, 'link');
    const pubDate = pickTag(block, 'pubDate');
    // <source url="...">SourceName</source> — name lives between tags
    const sourceMatch = block.match(/<source\b[^>]*>([\s\S]*?)<\/source>/);
    const source = sourceMatch ? unescapeXml(sourceMatch[1]?.trim() ?? '') : null;
    if (!title || !link) continue;
    out.push({
      title: stripSourceSuffix(title, source),
      link,
      source: source && source.length > 0 ? source : null,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
    });
  }
  return out;
}

function pickTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = block.match(re);
  if (!m || !m[1]) return '';
  return unescapeXml(m[1].trim()).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

// Google News appends " - SourceName" to every title. When we already
// have the source as a separate field, dropping the suffix keeps the
// headline clean.
function stripSourceSuffix(title: string, source: string | null): string {
  if (!source) return title;
  const suffix = ` - ${source}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}
