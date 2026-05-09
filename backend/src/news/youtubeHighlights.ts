// YouTube highlight finder — Phase 104.
//
// After a "big game" is detected, search YouTube for an official
// highlight clip and return the videoId for embedding. Filtered to a
// whitelist of verified league + national-broadcaster channels so
// random uploads (which often get DMCA'd within hours) don't end up
// embedded in our articles and break later.
//
// Cost: YouTube Data API v3 search = 100 quota units per call. Free
// tier is 10,000 units/day. We do ~5-15 big-game searches per night
// + some catch-ups in the morning — well under 1% of the cap.
//
// Setup: requires YOUTUBE_API_KEY env var. Without it, the function
// returns null and articles publish without video sections.

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

// Whitelist of YouTube channel IDs we trust to embed. Restricted to
// official league channels + major national broadcasters whose
// uploads stay live. Adding more later is cheap; over-broad now
// risks embedding clips that get pulled.
const TRUSTED_CHANNELS: Record<string, { name: string; sports: Array<'mlb' | 'nba' | 'wnba' | 'mma'> }> = {
  // Leagues
  'UCoLrcjPV5PbUrUyXq5mjc_A': { name: 'NBA',         sports: ['nba'] },
  'UCDkkdtOcwDqxlk-IdNNxlXQ': { name: 'MLB',         sports: ['mlb'] },
  'UC0SYXz-OFHEaIORnxsHsBzg': { name: 'WNBA',        sports: ['wnba'] },
  'UCvRgWQSFWFE3VLfCWh-PbVQ': { name: 'UFC',         sports: ['mma'] },
  // Big national broadcasters (cover all sports)
  'UCiWLfSweyRNmLpgEHekhoAg': { name: 'ESPN',        sports: ['mlb', 'nba', 'wnba', 'mma'] },
  'UC8WdXUfZjMCC_Nf6_CFqWxA': { name: 'FOX Sports',  sports: ['mlb', 'nba'] },
  'UC36L_R3CWBxV6LQyKBFcSdQ': { name: 'The Athletic',sports: ['mlb', 'nba'] },
  // Single-team channels would explode the list — skip for v1.
  // Official league channels usually cover all teams' big moments.
};

export type YoutubeHighlight = {
  videoId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
};

// Find a highlight video for a player's big game. Returns null when
//   - YOUTUBE_API_KEY isn't set
//   - search returns 0 trusted-channel results
//   - all results are too old (e.g. archive footage matching the player name)
export async function findBigGameHighlight(opts: {
  playerName: string;
  team: string | null;
  gameDate: string;       // YYYY-MM-DD
  sport: 'mlb' | 'nba' | 'wnba' | 'mma';
}): Promise<YoutubeHighlight | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  // Build search query. Player + 'highlights' + sport keyword.
  const sportKeyword = opts.sport === 'mlb' ? 'MLB' : opts.sport === 'nba' ? 'NBA' : opts.sport === 'wnba' ? 'WNBA' : 'UFC';
  const q = `${opts.playerName} highlights ${sportKeyword}`;

  // Restrict to videos published in the last 36 hours (gives the
  // game-end → upload window slack but excludes archive footage
  // that matches the player name).
  const publishedAfter = new Date(Date.now() - 36 * 3600 * 1000).toISOString();

  const params = new URLSearchParams({
    key: apiKey,
    part: 'snippet',
    q,
    type: 'video',
    order: 'date',
    maxResults: '10',
    publishedAfter,
    safeSearch: 'none',
  });

  let results: Array<{
    videoId: string;
    title: string;
    channelId: string;
    channelTitle: string;
    publishedAt: string;
  }>;
  try {
    const res = await fetch(`${YT_BASE}/search?${params.toString()}`);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      items?: Array<{
        id: { videoId: string };
        snippet: {
          title: string;
          channelId: string;
          channelTitle: string;
          publishedAt: string;
        };
      }>;
    };
    results = (json.items ?? []).map((it) => ({
      videoId: it.id.videoId,
      title: it.snippet.title,
      channelId: it.snippet.channelId,
      channelTitle: it.snippet.channelTitle,
      publishedAt: it.snippet.publishedAt,
    }));
  } catch (err) {
    console.warn('youtube highlight search failed:', (err as Error).message);
    return null;
  }

  // Filter to trusted channels + matching sport.
  const trusted = results.filter((r) => {
    const channel = TRUSTED_CHANNELS[r.channelId];
    return channel && channel.sports.includes(opts.sport);
  });
  if (trusted.length === 0) return null;

  // Prefer videos whose title mentions the player's last name (filters
  // out generic "NBA Top 10" reels that match the player on tag).
  const lastName = opts.playerName.split(/\s+/).slice(-1)[0]?.toLowerCase();
  const playerSpecific = trusted.filter((r) =>
    lastName && r.title.toLowerCase().includes(lastName),
  );
  const pick = playerSpecific[0] ?? trusted[0];
  if (!pick) return null;
  return {
    videoId: pick.videoId,
    title: pick.title,
    channelTitle: pick.channelTitle,
    publishedAt: pick.publishedAt,
  };
}
