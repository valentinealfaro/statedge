// MLB athlete bio via MLB Stats API /people endpoint — Phase 109a.
//
// MLB Stats API IDs aren't ESPN IDs, so the espnBio fetcher can't
// resolve MLB players. But MLB's own /people/:id endpoint returns
// the same fields ESPN's athlete endpoint does — and it's
// authoritative. We project the response into the same shape as
// EspnAthleteBio so the existing BioCard UI renders without changes.
//
// Cached 24h in-memory: bios change rarely.

import { mlbPlayerHeadshotUrl } from './images.js';

const STATS_API = 'https://statsapi.mlb.com/api/v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { fetchedAt: number; bio: MlbBioOut | null }>();

// Output shape — mirrors EspnAthleteBio so the frontend BioCard
// renders without a discriminated union.
export type MlbBioOut = {
  id: string;
  fullName: string;
  displayName: string;
  jersey: string | null;
  position: string | null;
  team: { id: string; abbreviation: string; displayName: string } | null;
  headshotUrl: string | null;
  heightInches: number | null;
  heightDisplay: string | null;
  weightLbs: number | null;
  birthDate: string | null;
  age: number | null;
  birthPlace: string | null;
  experience: string | null;       // "MLB debut: YYYY" — repurposed
  college: string | null;
  draft: { year: number; round: number; pick: number } | null;
};

// MLB Stats API response — only fields we project.
type MlbPeopleResponse = {
  people?: Array<{
    id?: number;
    fullName?: string;
    firstName?: string;
    lastName?: string;
    primaryNumber?: string;
    birthDate?: string;
    currentAge?: number;
    birthCity?: string;
    birthStateProvince?: string;
    birthCountry?: string;
    height?: string;
    weight?: number;
    mlbDebutDate?: string;
    primaryPosition?: { abbreviation?: string; name?: string };
    currentTeam?: { id?: number; name?: string; abbreviation?: string };
    draftYear?: number;
  }>;
};

export async function fetchMlbAthleteBio(playerId: string | number): Promise<MlbBioOut | null> {
  const idStr = String(playerId);
  const cached = cache.get(idStr);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.bio;
  }

  const url = `${STATS_API}/people/${encodeURIComponent(idStr)}?hydrate=currentTeam`;
  let json: MlbPeopleResponse;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'StatEdgeBot/1.0' } });
    if (!res.ok) {
      cache.set(idStr, { fetchedAt: Date.now(), bio: null });
      return null;
    }
    json = (await res.json()) as MlbPeopleResponse;
  } catch (err) {
    console.warn('mlbBio fetch failed', (err as Error).message);
    return null;
  }

  const person = json.people?.[0];
  if (!person?.id || !person.fullName) {
    cache.set(idStr, { fetchedAt: Date.now(), bio: null });
    return null;
  }

  const bio: MlbBioOut = {
    id: String(person.id),
    fullName: person.fullName,
    displayName: person.fullName,
    jersey: person.primaryNumber ?? null,
    position: person.primaryPosition?.abbreviation ?? person.primaryPosition?.name ?? null,
    team: person.currentTeam
      ? {
          id: String(person.currentTeam.id ?? ''),
          abbreviation: person.currentTeam.abbreviation ?? '',
          displayName: person.currentTeam.name ?? '',
        }
      : null,
    headshotUrl: mlbPlayerHeadshotUrl(person.id),
    heightInches: parseHeightToInches(person.height),
    heightDisplay: person.height ?? null,
    weightLbs: typeof person.weight === 'number' ? person.weight : null,
    birthDate: person.birthDate ?? null,
    age: typeof person.currentAge === 'number' ? person.currentAge : null,
    birthPlace: joinNonEmpty(
      [person.birthCity ?? '', person.birthStateProvince ?? '', person.birthCountry ?? ''],
      ', ',
    ),
    // Repurpose "experience" to show MLB debut year — closest analog
    // to what NBA/MMA bios show in this slot.
    experience: person.mlbDebutDate ? `Debut ${person.mlbDebutDate.slice(0, 4)}` : null,
    college: null,                         // /people doesn't return college
    draft: typeof person.draftYear === 'number'
      ? { year: person.draftYear, round: 0, pick: 0 }
      : null,
  };

  cache.set(idStr, { fetchedAt: Date.now(), bio });
  return bio;
}

// MLB ships height as `"6' 1\""` — parse to integer inches so the
// frontend can fall back to it when heightDisplay is missing.
function parseHeightToInches(s: string | undefined): number | null {
  if (!s) return null;
  const match = s.match(/(\d+)\s*'\s*(\d+)/);
  if (!match) return null;
  const feet = Number(match[1]);
  const inches = Number(match[2]);
  if (!Number.isFinite(feet) || !Number.isFinite(inches)) return null;
  return feet * 12 + inches;
}

function joinNonEmpty(parts: string[], sep: string): string | null {
  const filtered = parts.filter((p) => p && p.trim().length > 0);
  return filtered.length > 0 ? filtered.join(sep) : null;
}
