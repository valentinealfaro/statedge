// News / article types — Phase 104.
//
// The auto-generated content engine. Every article comes from data we
// already collect — slate publishes, market snapshots, projection
// history, live boxscores, CLV results, failure archetypes. No
// scraped or rewritten content; everything is original analysis from
// our own data layer.
//
// Article identity is the `slug` — derived deterministically from
// (kind, date, primary-subject) so re-running the generator UPSERTs
// instead of creating duplicates. Lets us iterate articles (add a
// YouTube highlight when it lands an hour after game-end, etc.)
// without polluting the table.

export type ArticleKind =
  | 'top_mispricings'        // Tonight's top dislocations across all sports
  | 'trap_watch'             // Public-facing trap candidates per sport
  | 'why_market_wrong'       // Single-player deep-dive on a top dislocation
  | 'clv_recap'              // Daily CLV report (yesterday's results)
  | 'edge_preview'           // Today's edge preview per sport
  | 'big_game'               // Player went off — auto-recap with highlight
  | 'fight_night'            // UFC card recap — main event + finishes + title fights
  | 'line_steam'             // Intraday line movement — market is reacting to info
  | 'power_rankings'         // Weekly per-sport rankings: standing + recent form
  | 'situation_report';      // Reserved for Phase 103g situation clustering

export type ArticleSport = 'mlb' | 'nba' | 'wnba' | 'mma' | 'cross';

// What we persist + render. Markdown body so we can render rich layouts
// without a CMS. `hero_image_url` is the image used in cards + OG meta.
// `video_youtube_id` is set on big-game articles when the YouTube
// search succeeds; null when no video has posted yet (catch-up cron
// retries the search next morning).
export type Article = {
  id: number;
  slug: string;
  kind: ArticleKind;
  sport: ArticleSport;
  title: string;
  summary: string;            // 1-2 sentences for cards / social previews
  bodyMd: string;             // full markdown content
  heroImageUrl: string | null;
  videoYoutubeId: string | null;
  relatedPlayerId: string | null;   // text — NBA + MLB numeric, WNBA already string
  relatedGameKey: string | null;
  publishedAt: string;
  updatedAt: string;
  expiresAt: string | null;   // when content becomes stale (nullable)
};

// What article-template functions return — the generator stitches
// these into INSERT/UPDATE statements. ID + createdAt are assigned
// by the DB on insert.
export type ArticleDraft = Omit<Article, 'id' | 'updatedAt' | 'publishedAt'> & {
  publishedAt?: string;
};

// Helpers for slug generation. Same date format throughout: YYYY-MM-DD
// in ET (matches our slate-day convention).
export function articleSlug(opts: {
  kind: ArticleKind;
  date: string;
  sport?: ArticleSport;
  subject?: string;       // player name, game key, etc. — slug-safe form
}): string {
  const parts: string[] = [opts.kind.replace(/_/g, '-')];
  if (opts.subject) parts.push(slugify(opts.subject));
  if (opts.sport && opts.sport !== 'cross') parts.push(opts.sport);
  parts.push(opts.date);
  return parts.join('-');
}

export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
