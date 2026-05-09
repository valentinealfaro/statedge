// ESPN athlete-bio fetcher — Phase 106b.
//
// Pulls the public athlete page from ESPN's site API to get the
// fields that turn a player log page into a real player profile:
// headshot, position, jersey, height, weight, birthdate (→ age),
// draft year + round + pick, experience, college, and birthplace.
//
// We hit ESPN by athlete id, not by name — so callers must already
// know the id. For NBA + WNBA (and MMA fighters), the id is the
// ESPN athlete id we already store in our scoreboard / boxscore
// pipeline. For MLB we don't have ESPN ids for everyone; bio is
// best-effort and skipped when no espnAthleteId is present.
//
// Cached 24h in-memory — bios change rarely.

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { fetchedAt: number; bio: EspnAthleteBio | null }>();

export type EspnAthleteBio = {
  id: string;
  fullName: string;
  displayName: string;
  jersey: string | null;
  position: string | null;          // "PG", "SF", "P", "RHP", etc.
  team: { id: string; abbreviation: string; displayName: string } | null;
  headshotUrl: string | null;
  heightInches: number | null;      // ESPN ships in inches
  heightDisplay: string | null;     // "6' 10""
  weightLbs: number | null;
  birthDate: string | null;         // ISO YYYY-MM-DD
  age: number | null;
  birthPlace: string | null;        // "Toulouse, France"
  experience: string | null;        // "1st Year", "5th Year", "Veteran"
  college: string | null;
  draft: { year: number; round: number; pick: number } | null;
};

type SportSlug = 'basketball/nba' | 'basketball/wnba' | 'baseball/mlb' | 'mma/ufc';

export async function fetchEspnAthleteBio(
  espnAthleteId: string,
  sportSlug: SportSlug,
): Promise<EspnAthleteBio | null> {
  if (!espnAthleteId) return null;
  const cacheKey = `${sportSlug}::${espnAthleteId}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.bio;
  }

  const url = `${ESPN_BASE}/${sportSlug}/athletes/${encodeURIComponent(espnAthleteId)}`;
  let json: unknown;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'StatEdgeBot/1.0' } });
    if (!res.ok) {
      cache.set(cacheKey, { fetchedAt: Date.now(), bio: null });
      return null;
    }
    json = await res.json();
  } catch (err) {
    console.warn('espnBio fetch failed', (err as Error).message);
    return null;
  }

  const bio = parseAthleteBio(json, espnAthleteId);
  cache.set(cacheKey, { fetchedAt: Date.now(), bio });
  return bio;
}

// ESPN ships athlete data nested under different keys depending on
// when it was scraped — sometimes top-level, sometimes under
// .athlete. We project from both shapes.
function parseAthleteBio(raw: unknown, fallbackId: string): EspnAthleteBio | null {
  const j = raw as Record<string, unknown> | null;
  if (!j || typeof j !== 'object') return null;
  const a = ((j['athlete'] as Record<string, unknown>) ?? j) as Record<string, unknown>;

  const id = String(a['id'] ?? fallbackId);
  const fullName = String(a['fullName'] ?? a['displayName'] ?? '');
  if (!fullName) return null;

  const teamObj = a['team'] as Record<string, unknown> | undefined;
  const team = teamObj
    ? {
        id: String(teamObj['id'] ?? ''),
        abbreviation: String(teamObj['abbreviation'] ?? ''),
        displayName: String(teamObj['displayName'] ?? ''),
      }
    : null;

  const headshot = a['headshot'] as Record<string, unknown> | undefined;
  const headshotUrl = headshot ? (typeof headshot['href'] === 'string' ? headshot['href'] : null) : null;

  const positionObj = a['position'] as Record<string, unknown> | undefined;
  const position = positionObj ? String(positionObj['abbreviation'] ?? positionObj['name'] ?? '') || null : null;

  const heightInches = numOrNull(a['height']);
  const heightDisplay = typeof a['displayHeight'] === 'string' ? (a['displayHeight'] as string) : null;
  const weightLbs = numOrNull(a['weight']);

  const birthDate = typeof a['dateOfBirth'] === 'string' ? (a['dateOfBirth'] as string).slice(0, 10) : null;
  const age = birthDate ? computeAge(birthDate) : numOrNull(a['age']);

  const birthPlaceObj = a['birthPlace'] as Record<string, unknown> | undefined;
  const birthPlace = birthPlaceObj
    ? joinNonEmpty([
        String(birthPlaceObj['city'] ?? ''),
        String(birthPlaceObj['state'] ?? ''),
        String(birthPlaceObj['country'] ?? ''),
      ], ', ')
    : null;

  const experienceObj = a['experience'] as Record<string, unknown> | undefined;
  const experience = experienceObj ? (typeof experienceObj['displayValue'] === 'string' ? (experienceObj['displayValue'] as string) : null) : null;

  const collegeObj = a['college'] as Record<string, unknown> | undefined;
  const college = collegeObj ? (typeof collegeObj['name'] === 'string' ? (collegeObj['name'] as string) : null) : null;

  const draftObj = a['draft'] as Record<string, unknown> | undefined;
  let draft: EspnAthleteBio['draft'] = null;
  if (draftObj) {
    const year = numOrNull(draftObj['year']);
    const round = numOrNull(draftObj['round']);
    const pick = numOrNull(draftObj['selection']);
    if (year && round && pick) {
      draft = { year, round, pick };
    }
  }

  return {
    id,
    fullName,
    displayName: String(a['displayName'] ?? fullName),
    jersey: typeof a['jersey'] === 'string' ? (a['jersey'] as string) : null,
    position,
    team,
    headshotUrl,
    heightInches,
    heightDisplay,
    weightLbs,
    birthDate,
    age,
    birthPlace: birthPlace && birthPlace.length > 0 ? birthPlace : null,
    experience,
    college,
    draft,
  };
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (typeof v === 'number' ? v : NaN);
  return Number.isFinite(n) ? n : null;
}

function computeAge(birthDateIso: string): number | null {
  const b = new Date(birthDateIso);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < b.getUTCMonth() ||
    (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

function joinNonEmpty(parts: string[], sep: string): string {
  return parts.filter((p) => p && p.trim().length > 0).join(sep);
}
