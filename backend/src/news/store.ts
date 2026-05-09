// Article persistence — Phase 104.
//
// `articles` table is wide + flat for direct querying. Schema mirrors
// the Article type 1:1. Idempotent upsert keyed on slug — re-running
// the generator updates instead of creating duplicates.
//
// Indexed for the read paths the news pages need:
//   - by published_at DESC for the index page
//   - by slug for individual article fetches
//   - by (sport, kind) for category filtering
//   - by related_player_id for "articles about this player" on player pages

import { getPool, isDbConfigured } from '../db.js';
import type { Article, ArticleDraft, ArticleKind, ArticleSport } from './types.js';

let articlesTableEnsured = false;

export async function ensureArticlesTable(): Promise<void> {
  if (articlesTableEnsured || !isDbConfigured()) {
    articlesTableEnsured = true;
    return;
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS articles (
      id                  BIGSERIAL PRIMARY KEY,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      slug                TEXT NOT NULL UNIQUE,
      kind                TEXT NOT NULL,
      sport               TEXT NOT NULL,
      title               TEXT NOT NULL,
      summary             TEXT NOT NULL,
      body_md             TEXT NOT NULL,
      hero_image_url      TEXT,
      video_youtube_id    TEXT,
      related_player_id   TEXT,
      related_game_key    TEXT,
      published_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at          TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS articles_recent_idx
      ON articles (published_at DESC);
    CREATE INDEX IF NOT EXISTS articles_kind_sport_idx
      ON articles (sport, kind, published_at DESC);
    CREATE INDEX IF NOT EXISTS articles_player_idx
      ON articles (related_player_id, published_at DESC);
  `);
  articlesTableEnsured = true;
}

// Upsert by slug. Re-running the generator updates the article
// (refreshing data, attaching a YouTube video that wasn't ready
// originally, etc.) without duplicating.
export async function upsertArticle(draft: ArticleDraft): Promise<Article> {
  await ensureArticlesTable();
  const pool = getPool();
  const now = new Date().toISOString();
  const publishedAt = draft.publishedAt ?? now;
  const { rows } = await pool.query<{
    id: number;
    slug: string;
    kind: string;
    sport: string;
    title: string;
    summary: string;
    body_md: string;
    hero_image_url: string | null;
    video_youtube_id: string | null;
    related_player_id: string | null;
    related_game_key: string | null;
    published_at: Date;
    updated_at: Date;
    expires_at: Date | null;
  }>(
    `INSERT INTO articles (
       slug, kind, sport, title, summary, body_md, hero_image_url,
       video_youtube_id, related_player_id, related_game_key,
       published_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (slug) DO UPDATE SET
       title             = EXCLUDED.title,
       summary           = EXCLUDED.summary,
       body_md           = EXCLUDED.body_md,
       hero_image_url    = COALESCE(EXCLUDED.hero_image_url, articles.hero_image_url),
       video_youtube_id  = COALESCE(EXCLUDED.video_youtube_id, articles.video_youtube_id),
       related_player_id = COALESCE(EXCLUDED.related_player_id, articles.related_player_id),
       related_game_key  = COALESCE(EXCLUDED.related_game_key, articles.related_game_key),
       expires_at        = EXCLUDED.expires_at,
       updated_at        = NOW()
     RETURNING *`,
    [
      draft.slug,
      draft.kind,
      draft.sport,
      draft.title,
      draft.summary,
      draft.bodyMd,
      draft.heroImageUrl,
      draft.videoYoutubeId,
      draft.relatedPlayerId,
      draft.relatedGameKey,
      publishedAt,
      draft.expiresAt,
    ],
  );
  return mapRow(rows[0]!);
}

// List recent articles for the news index. Bounded by the limit
// (default 50). Filterable by sport and kind.
export async function listArticles(opts?: {
  sport?: ArticleSport;
  kind?: ArticleKind;
  limit?: number;
  playerId?: string;
  gameKey?: string;
}): Promise<Article[]> {
  if (!isDbConfigured()) return [];
  await ensureArticlesTable();
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (opts?.sport) {
    where.push(`sport = $${args.length + 1}`);
    args.push(opts.sport);
  }
  if (opts?.kind) {
    where.push(`kind = $${args.length + 1}`);
    args.push(opts.kind);
  }
  if (opts?.playerId) {
    where.push(`related_player_id = $${args.length + 1}`);
    args.push(opts.playerId);
  }
  if (opts?.gameKey) {
    where.push(`related_game_key = $${args.length + 1}`);
    args.push(opts.gameKey);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit);
  const limitParam = args.length;
  const { rows } = await getPool().query(
    `SELECT * FROM articles ${whereSql} ORDER BY published_at DESC LIMIT $${limitParam}`,
    args,
  );
  return rows.map(mapRow);
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  if (!isDbConfigured()) return null;
  await ensureArticlesTable();
  const { rows } = await getPool().query(
    `SELECT * FROM articles WHERE slug = $1`,
    [slug],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

// Internal — turn a DB row into the Article type. Date columns come
// back as JS Date; we want ISO strings on the wire.
function mapRow(r: {
  id: number;
  slug: string;
  kind: string;
  sport: string;
  title: string;
  summary: string;
  body_md: string;
  hero_image_url: string | null;
  video_youtube_id: string | null;
  related_player_id: string | null;
  related_game_key: string | null;
  published_at: Date;
  updated_at: Date;
  expires_at: Date | null;
}): Article {
  return {
    id: r.id,
    slug: r.slug,
    kind: r.kind as ArticleKind,
    sport: r.sport as ArticleSport,
    title: r.title,
    summary: r.summary,
    bodyMd: r.body_md,
    heroImageUrl: r.hero_image_url,
    videoYoutubeId: r.video_youtube_id,
    relatedPlayerId: r.related_player_id,
    relatedGameKey: r.related_game_key,
    publishedAt: r.published_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    expiresAt: r.expires_at?.toISOString() ?? null,
  };
}
