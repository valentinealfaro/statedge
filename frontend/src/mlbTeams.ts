// Static MLB team-id → abbreviation/name map.
//
// MLB statsapi uses numeric team ids (108–158, with gaps). The
// scoreboard payloads, game logs, and lineup data carry these ids
// without team metadata, so the frontend has historically displayed
// raw "Opp 146" — useless to a human reader.
//
// 30-entry table is small and stable (no team has changed id in MLB's
// modern era). Embedding it here is cheaper than a backend lookup
// and never goes stale unless MLB expands.

type MlbTeam = {
  abbr: string;
  fullName: string;
  city: string;
};

export const MLB_TEAMS_BY_ID: Record<number, MlbTeam> = {
  108: { abbr: 'LAA', fullName: 'Los Angeles Angels',     city: 'Los Angeles' },
  109: { abbr: 'ARI', fullName: 'Arizona Diamondbacks',   city: 'Arizona' },
  110: { abbr: 'BAL', fullName: 'Baltimore Orioles',      city: 'Baltimore' },
  111: { abbr: 'BOS', fullName: 'Boston Red Sox',         city: 'Boston' },
  112: { abbr: 'CHC', fullName: 'Chicago Cubs',           city: 'Chicago' },
  113: { abbr: 'CIN', fullName: 'Cincinnati Reds',        city: 'Cincinnati' },
  114: { abbr: 'CLE', fullName: 'Cleveland Guardians',    city: 'Cleveland' },
  115: { abbr: 'COL', fullName: 'Colorado Rockies',       city: 'Colorado' },
  116: { abbr: 'DET', fullName: 'Detroit Tigers',         city: 'Detroit' },
  117: { abbr: 'HOU', fullName: 'Houston Astros',         city: 'Houston' },
  118: { abbr: 'KC',  fullName: 'Kansas City Royals',     city: 'Kansas City' },
  119: { abbr: 'LAD', fullName: 'Los Angeles Dodgers',    city: 'Los Angeles' },
  120: { abbr: 'WSH', fullName: 'Washington Nationals',   city: 'Washington' },
  121: { abbr: 'NYM', fullName: 'New York Mets',          city: 'New York' },
  133: { abbr: 'OAK', fullName: 'Oakland Athletics',      city: 'Oakland' },
  134: { abbr: 'PIT', fullName: 'Pittsburgh Pirates',     city: 'Pittsburgh' },
  135: { abbr: 'SD',  fullName: 'San Diego Padres',       city: 'San Diego' },
  136: { abbr: 'SEA', fullName: 'Seattle Mariners',       city: 'Seattle' },
  137: { abbr: 'SF',  fullName: 'San Francisco Giants',   city: 'San Francisco' },
  138: { abbr: 'STL', fullName: 'St. Louis Cardinals',    city: 'St. Louis' },
  139: { abbr: 'TB',  fullName: 'Tampa Bay Rays',         city: 'Tampa Bay' },
  140: { abbr: 'TEX', fullName: 'Texas Rangers',          city: 'Texas' },
  141: { abbr: 'TOR', fullName: 'Toronto Blue Jays',      city: 'Toronto' },
  142: { abbr: 'MIN', fullName: 'Minnesota Twins',        city: 'Minnesota' },
  143: { abbr: 'PHI', fullName: 'Philadelphia Phillies',  city: 'Philadelphia' },
  144: { abbr: 'ATL', fullName: 'Atlanta Braves',         city: 'Atlanta' },
  145: { abbr: 'CWS', fullName: 'Chicago White Sox',      city: 'Chicago' },
  146: { abbr: 'MIA', fullName: 'Miami Marlins',          city: 'Miami' },
  147: { abbr: 'NYY', fullName: 'New York Yankees',       city: 'New York' },
  158: { abbr: 'MIL', fullName: 'Milwaukee Brewers',      city: 'Milwaukee' },
};

export function mlbTeamAbbr(id: number | null | undefined): string | null {
  if (id == null) return null;
  return MLB_TEAMS_BY_ID[id]?.abbr ?? null;
}

export function mlbTeamFullName(id: number | null | undefined): string | null {
  if (id == null) return null;
  return MLB_TEAMS_BY_ID[id]?.fullName ?? null;
}
