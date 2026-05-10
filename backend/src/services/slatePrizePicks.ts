// Fetches the current NBA prop board from PrizePicks's public JSON API.
//
// CAVEAT: This is an undocumented endpoint and using it is technically
// against PrizePicks's terms of service. We:
//   - call it server-side only (Vercel IPs may get blocked at any time)
//   - filter to single-stat NBA only (no combos, no live, no promos)
//   - drop any caching layer's grip with no-store
//   - degrade gracefully — the upload fallback exists for when this
//     stops working
//
// If you'd rather not rely on PP at all, set DISABLE_PP_AUTOFETCH=1 in
// the env and the route will short-circuit to "use upload instead".

const PP_URL = 'https://api.prizepicks.com/projections';
const NBA_LEAGUE_ID = 7;

export type PpRawLine = {
  ppId: string;                 // projection id (so dedup is stable)
  playerName: string;
  team: string;                 // team abbreviation per PP
  position: string;
  imageUrl: string | null;
  statType: string;             // raw "Points" / "Pts+Rebs+Asts" etc.
  line: number;
  startTime: string | null;
  description: string | null;   // usually "AWAY/HOME"
  isLive: boolean;
  // Iter 21 (user 2026-05-10): PrizePicks tags each prop with an
  // odds_type attribute that controls the per-leg payout multiplier
  // and the bookable side. Pre-iter-21 we ignored this entirely,
  // which made every NBA prop show up in our system as a standard
  // 'both' prop (isDemon=false, isGoblin=false), and the iter-11
  // demon-only Insane filter rejected everything. Now we pass it
  // through so the slate pipeline can correctly tag direction.
  //   'demon'    → over-only, raised line, ~1.5× payout boost
  //   'goblin'   → under-only, shaved line, ~0.85× payout cut
  //   'standard' → standard prop (or any other / unknown value)
  oddsType: 'demon' | 'goblin' | 'standard';
};

type Resource = {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data?: { type: string; id: string } | null }>;
};

type PpResponse = {
  data: Resource[];
  included: Resource[];
};

export type FetchOpts = {
  signal?: AbortSignal;
};

export async function fetchPrizePicksNba(opts: FetchOpts = {}): Promise<PpRawLine[]> {
  if (process.env.DISABLE_PP_AUTOFETCH === '1') {
    throw new Error('PrizePicks auto-fetch disabled by DISABLE_PP_AUTOFETCH env flag');
  }
  const url = `${PP_URL}?league_id=${NBA_LEAGUE_ID}&per_page=500&single_stat=true`;
  const res = await fetch(url, {
    headers: {
      // PrizePicks requires a User-Agent header. We identify as a normal
      // browser since they don't publish a programmatic UA.
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) StatEdgeServer/1.0',
      Accept: 'application/json',
    },
    cache: 'no-store',
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`PrizePicks ${res.status}`);
  const j = (await res.json()) as PpResponse;

  const playersById = new Map<string, Resource>();
  for (const r of j.included) {
    if (r.type === 'new_player') playersById.set(r.id, r);
  }

  const out: PpRawLine[] = [];
  for (const proj of j.data) {
    if (proj.type !== 'projection') continue;
    const a = proj.attributes;

    // Skip multi-player combos and oddballs — we can only compute hit
    // probability for a single player against a known stat.
    if ((a.event_type as string) === 'combo') continue;
    if ((a.projection_type as string) !== 'Single Stat') continue;
    if (a.is_promo === true) continue;

    const playerId = proj.relationships?.new_player?.data?.id;
    if (!playerId) continue;
    const player = playersById.get(playerId);
    if (!player) continue;
    const pa = player.attributes;

    const playerName = String(pa.display_name ?? pa.name ?? '').trim();
    if (!playerName) continue;
    if (pa.combo === true) continue;          // some players are combo-only entities

    const rawOddsType = String(a.odds_type ?? 'standard').toLowerCase();
    const oddsType: 'demon' | 'goblin' | 'standard' =
      rawOddsType === 'demon' ? 'demon'
      : rawOddsType === 'goblin' ? 'goblin'
      : 'standard';

    out.push({
      ppId: proj.id,
      playerName,
      team: String(pa.team ?? '').trim(),
      position: String(pa.position ?? '').trim(),
      imageUrl: pa.image_url ? String(pa.image_url) : null,
      statType: String(a.stat_type ?? '').trim(),
      line: Number(a.line_score ?? 0),
      startTime: a.start_time ? String(a.start_time) : null,
      description: a.description ? String(a.description) : null,
      isLive: a.is_live === true,
      oddsType,
    });
  }

  return out;
}
