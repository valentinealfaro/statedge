// ESPN UFC scoreboard fetcher — Phase 107a.
//
// MMA replaces WNBA as the third sport per the sport-priorities
// decision. The Odds API already maps 'mma' → 'mma_mixed_martial_arts',
// so Market Brain ingestion plumbing reuses without changes; what we
// don't yet have is anything to SHOW for the sport. This client gives
// us upcoming UFC events + completed event results from ESPN's public
// site API. PPV and Fight Night cards both surface here.
//
// ESPN endpoints used:
//   /scoreboard?dates=YYYYMMDD-YYYYMMDD  → range listing
//   /summary?event=:eventId              → fight card + results

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc';

export type UfcFighter = {
  id: string;
  displayName: string;
  shortName: string;
  headshot: string | null;
  record: string | null;       // "27-2-0"
  flag: string | null;
};

export type UfcFight = {
  id: string;
  date: string;                  // ISO datetime
  state: 'pre' | 'in' | 'post';
  status: string;                // "STATUS_FINAL", "STATUS_SCHEDULED"
  weightClass: string | null;    // "Lightweight", "Welterweight"
  isMain: boolean;
  isTitle: boolean;
  fighters: { red: UfcFighter | null; blue: UfcFighter | null };
  result: {
    winnerId: string | null;
    method: string | null;       // "KO/TKO", "Submission", "Decision - Unanimous"
    round: number | null;
    time: string | null;         // "MM:SS"
  } | null;
};

export type UfcEvent = {
  id: string;
  name: string;                  // "UFC 320: Fighter A vs Fighter B"
  shortName: string;
  date: string;
  status: string;
  state: 'pre' | 'in' | 'post';
  venue: { fullName: string; city: string | null; country: string | null } | null;
  fights: UfcFight[];
};

export async function fetchUfcScoreboard(opts?: { startDate?: string; endDate?: string }): Promise<UfcEvent[]> {
  const start = (opts?.startDate ?? defaultRangeStart()).replace(/-/g, '');
  const end = (opts?.endDate ?? defaultRangeEnd()).replace(/-/g, '');
  const url = `${ESPN}/scoreboard?dates=${start}-${end}&limit=100`;
  let json: unknown;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'StatEdgeBot/1.0' } });
    if (!res.ok) throw new Error(`ESPN UFC scoreboard ${res.status}`);
    json = await res.json();
  } catch (err) {
    console.warn('ufc scoreboard fetch failed', (err as Error).message);
    return [];
  }
  return projectScoreboard(json);
}

// Range default — past 7 days (so completed fights show) through next
// 60 days (covers a full PPV cycle).
function defaultRangeStart(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}
function defaultRangeEnd(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 60);
  return d.toISOString().slice(0, 10);
}

// ESPN's MMA scoreboard nests fights under each event's competitions
// array. Each event = a card, each competition = a fight.
function projectScoreboard(raw: unknown): UfcEvent[] {
  const j = raw as Record<string, unknown> | null;
  const events = (j?.['events'] ?? []) as Array<Record<string, unknown>>;
  return events.map(projectEvent);
}

function projectEvent(e: Record<string, unknown>): UfcEvent {
  const status = e['status'] as Record<string, unknown> | undefined;
  const stateRaw = ((status?.['type'] as Record<string, unknown> | undefined)?.['state'] ?? 'pre') as string;
  const competitions = (e['competitions'] ?? []) as Array<Record<string, unknown>>;
  const venueObj = competitions[0]?.['venue'] as Record<string, unknown> | undefined;
  const venueAddress = venueObj?.['address'] as Record<string, unknown> | undefined;

  return {
    id: String(e['id'] ?? ''),
    name: String(e['name'] ?? ''),
    shortName: String(e['shortName'] ?? ''),
    date: String(e['date'] ?? ''),
    status: String(((status?.['type'] as Record<string, unknown>)?.['name']) ?? ''),
    state: stateRaw === 'in' ? 'in' : stateRaw === 'post' ? 'post' : 'pre',
    venue: venueObj
      ? {
          fullName: String(venueObj['fullName'] ?? ''),
          city: typeof venueAddress?.['city'] === 'string' ? (venueAddress['city'] as string) : null,
          country: typeof venueAddress?.['country'] === 'string' ? (venueAddress['country'] as string) : null,
        }
      : null,
    fights: competitions.map(projectFight),
  };
}

function projectFight(c: Record<string, unknown>): UfcFight {
  const status = c['status'] as Record<string, unknown> | undefined;
  const stateRaw = ((status?.['type'] as Record<string, unknown> | undefined)?.['state'] ?? 'pre') as string;

  const competitors = ((c['competitors'] ?? []) as Array<Record<string, unknown>>);
  const red = competitors.find((x) => x['order'] === 1 || x['homeAway'] === 'home') ?? competitors[0];
  const blue = competitors.find((x) => x['order'] === 2 || x['homeAway'] === 'away') ?? competitors[1];

  const note = c['note'] as string | undefined;
  const type = c['type'] as Record<string, unknown> | undefined;

  // Result — populated for completed fights. ESPN ships this differently
  // than basketball: there's a `winner` flag on each competitor, plus
  // a `notes` array describing method + round + time.
  const winner = competitors.find((x) => x['winner'] === true);
  const notes = ((c['notes'] ?? []) as Array<Record<string, unknown>>);
  const methodNote = notes[0]?.['headline'] as string | undefined;

  let result: UfcFight['result'] = null;
  if (stateRaw === 'post') {
    result = {
      winnerId: winner ? String((winner['athlete'] as Record<string, unknown> | undefined)?.['id'] ?? '') : null,
      method: methodNote ?? null,
      round: typeof status?.['period'] === 'number' ? (status['period'] as number) : null,
      time: typeof status?.['displayClock'] === 'string' ? (status['displayClock'] as string) : null,
    };
  }

  return {
    id: String(c['id'] ?? ''),
    date: String(c['date'] ?? ''),
    state: stateRaw === 'in' ? 'in' : stateRaw === 'post' ? 'post' : 'pre',
    status: String(((status?.['type'] as Record<string, unknown>)?.['name']) ?? ''),
    weightClass: typeof type?.['text'] === 'string' ? (type['text'] as string) : null,
    isMain: typeof note === 'string' && /main/i.test(note),
    isTitle: typeof note === 'string' && /title|championship/i.test(note),
    fighters: {
      red: red ? projectFighter(red) : null,
      blue: blue ? projectFighter(blue) : null,
    },
    result,
  };
}

function projectFighter(c: Record<string, unknown>): UfcFighter {
  const a = (c['athlete'] ?? {}) as Record<string, unknown>;
  const flag = a['flag'] as Record<string, unknown> | undefined;
  const records = (c['records'] as Array<Record<string, unknown>> | undefined) ?? [];
  const headshot = a['headshot'] as Record<string, unknown> | undefined;
  // Note: ESPN's MMA scoreboard puts the athlete id on the OUTER
  // competitor (`c.id`), not on the inner `competitor.athlete` object
  // (which only carries displayName/shortName/flag). Reading `a.id`
  // would get undefined. The competitor.id IS the athlete id since
  // each MMA competitor IS an athlete (type: 'athlete').
  const competitorId = c['id'];
  return {
    id: String(competitorId ?? a['id'] ?? ''),
    displayName: String(a['displayName'] ?? ''),
    shortName: String(a['shortName'] ?? ''),
    headshot: typeof headshot?.['href'] === 'string' ? (headshot['href'] as string) : null,
    record: records[0] ? String(records[0]['summary'] ?? '') : null,
    flag: typeof flag?.['href'] === 'string' ? (flag['href'] as string) : null,
  };
}

// ─── Fighter bio + this-fight live stats ─────────────────────────
//
// ESPN's /apis/common/v3/sports/mma/ufc/fightcenter/{eventId}?fightId=
// endpoint returns the same data the UFC fightcenter web page renders:
// bio (height/weight/age/reach/stance/headshot/flag/country/weightClass)
// + per-fighter live in-fight stats (knockdowns, sig strikes, takedowns,
// head/body/leg strike splits, time in control).
//
// Career averages (SIG STR LPM / accuracy / takedown avg / etc.) are
// NOT exposed on any public ESPN MMA endpoint — they're computed by
// ESPN's frontend from career fight aggregation. So this engine pivots
// to live in-fight stats: more useful for a live-tracked product, and
// they actually exist in the data.

export type UfcFighterBio = {
  id: string;
  displayName: string;
  height: string | null;
  weight: string | null;
  age: number | null;
  reach: string | null;
  stance: string | null;
  weightClass: string | null;
  flag: string | null;
  flagAlt: string | null;
  country: string | null;
  headshot: string | null;
  record: string | null;
  // Per-fight live stats — populated when ESPN's competitor.stats
  // array carries them (during/after the fight). Null pre-fight.
  liveStats: UfcFighterLiveStats | null;
};

export type UfcFighterLiveStats = {
  knockdowns: number | null;
  sigStrikesLanded: number | null;
  sigStrikesAttempted: number | null;
  totalStrikesLanded: number | null;
  totalStrikesAttempted: number | null;
  headStrikesLanded: number | null;
  bodyStrikesLanded: number | null;
  legStrikesLanded: number | null;
  takedownsLanded: number | null;
  takedownsAttempted: number | null;
  submissionAttempts: number | null;
  // Time-in-control reported in seconds.
  timeInControlSec: number | null;
};

export type UfcFightCenterFighter = {
  fighter: UfcFighterBio;
  side: 'red' | 'blue';
  isWinner: boolean;
};

export type UfcFightCenterResult = {
  red: UfcFighterBio | null;
  blue: UfcFighterBio | null;
};

export async function fetchUfcFightCenter(
  eventId: string,
  fightId: string,
): Promise<UfcFightCenterResult> {
  if (!eventId || !fightId) return { red: null, blue: null };
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/mma/ufc/fightcenter/${encodeURIComponent(eventId)}?fightId=${encodeURIComponent(fightId)}`;
  let json: Record<string, unknown>;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'StatEdgeBot/1.0' } });
    if (!res.ok) return { red: null, blue: null };
    json = await res.json() as Record<string, unknown>;
  } catch {
    return { red: null, blue: null };
  }

  // Walk every card (main / prelims1 / prelims2) → competitions[] until
  // we find the matching fight id. Each segment is keyed differently
  // depending on the event so we iterate values.
  const cards = (json['cards'] ?? {}) as Record<string, unknown>;
  for (const segName of Object.keys(cards)) {
    const seg = cards[segName] as Record<string, unknown> | undefined;
    if (!seg) continue;
    const comps = (seg['competitions'] ?? []) as Array<Record<string, unknown>>;
    for (const comp of comps) {
      if (String(comp['id'] ?? '') !== fightId) continue;
      const competitors = (comp['competitors'] ?? []) as Array<Record<string, unknown>>;
      // ESPN doesn't tag corners as red/blue explicitly on MMA; we use
      // `order` (1 = red, 2 = blue) which is consistent with their UI.
      const red  = competitors.find((c) => c['order'] === 1) ?? competitors[0];
      const blue = competitors.find((c) => c['order'] === 2) ?? competitors[1];
      return {
        red:  red  ? projectFightCenterCompetitor(red) : null,
        blue: blue ? projectFightCenterCompetitor(blue) : null,
      };
    }
  }
  return { red: null, blue: null };
}

function projectFightCenterCompetitor(c: Record<string, unknown>): UfcFighterBio {
  const a = (c['athlete'] ?? {}) as Record<string, unknown>;
  const flag = a['flag'] as Record<string, unknown> | undefined;
  const headshot = a['headshot'] as Record<string, unknown> | undefined;
  const stance = a['stance'] as Record<string, unknown> | undefined;
  const weightClass = a['weightClass'] as Record<string, unknown> | undefined;
  const stats = (c['stats'] ?? []) as Array<Record<string, unknown>>;
  return {
    id: String(a['id'] ?? c['id'] ?? ''),
    displayName: String(a['displayName'] ?? ''),
    height: stringOrNull(a['displayHeight']),
    weight: stringOrNull(a['displayWeight']),
    age: typeof a['age'] === 'number' ? (a['age'] as number) : null,
    reach: stringOrNull(a['displayReach']),
    stance: stringOrNull(stance?.['text']),
    weightClass: stringOrNull(weightClass?.['text']),
    flag: typeof flag?.['href'] === 'string' ? (flag['href'] as string) : null,
    flagAlt: typeof flag?.['alt'] === 'string' ? (flag['alt'] as string) : null,
    country: stringOrNull(a['country']),
    headshot: typeof headshot?.['href'] === 'string' ? (headshot['href'] as string) : null,
    record: stringOrNull(c['displayRecord']),
    liveStats: stats.length > 0 ? extractLiveStats(stats) : null,
  };
}

function extractLiveStats(stats: Array<Record<string, unknown>>): UfcFighterLiveStats {
  const byName = new Map<string, Record<string, unknown>>();
  for (const s of stats) byName.set(String(s['name'] ?? '').toLowerCase(), s);

  // ESPN's combat stats come as "landed/attempted" in displayValue (the
  // numeric `value` is just landed). Parse the displayValue when we
  // need both numbers.
  const split = (key: string): [number | null, number | null] => {
    const s = byName.get(key.toLowerCase());
    if (!s) return [null, null];
    const dv = String(s['displayValue'] ?? '');
    const slash = dv.indexOf('/');
    if (slash > 0) {
      const a = Number(dv.slice(0, slash));
      const b = Number(dv.slice(slash + 1));
      return [Number.isFinite(a) ? a : null, Number.isFinite(b) ? b : null];
    }
    const v = typeof s['value'] === 'number' ? s['value'] : Number(s['value']);
    return [Number.isFinite(v) ? v : null, null];
  };

  const single = (key: string): number | null => {
    const s = byName.get(key.toLowerCase());
    if (!s) return null;
    const v = typeof s['value'] === 'number' ? s['value'] : Number(s['value']);
    return Number.isFinite(v) ? v : null;
  };

  const [sigL, sigA] = split('sigStrikes');
  const [totL, totA] = split('totalStrikes');
  const [headL] = split('headStrikes');
  const [bodyL] = split('bodyStrikes');
  const [legL] = split('legStrikes');
  const [tdL, tdA] = split('takedowns');

  return {
    knockdowns: single('knockDowns'),
    sigStrikesLanded: sigL,
    sigStrikesAttempted: sigA,
    totalStrikesLanded: totL,
    totalStrikesAttempted: totA,
    headStrikesLanded: headL,
    bodyStrikesLanded: bodyL,
    legStrikesLanded: legL,
    takedownsLanded: tdL,
    takedownsAttempted: tdA,
    submissionAttempts: single('submissions'),
    timeInControlSec: single('timeInControl'),
  };
}

function stringOrNull(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v;
  return null;
}
