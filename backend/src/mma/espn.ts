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
  return {
    id: String(a['id'] ?? ''),
    displayName: String(a['displayName'] ?? ''),
    shortName: String(a['shortName'] ?? ''),
    headshot: typeof headshot?.['href'] === 'string' ? (headshot['href'] as string) : null,
    record: records[0] ? String(records[0]['summary'] ?? '') : null,
    flag: typeof flag?.['href'] === 'string' ? (flag['href'] as string) : null,
  };
}
