// Image URL helpers for article generation — Phase 104.
//
// Player headshots and team logos. We use the same CDN URLs the
// Avatar components use on the frontend; these are public CDN
// resources owned by MLB / NBA / ESPN that are explicitly served
// for editorial use. No API keys, no rate limits, no cost.

export function mlbPlayerHeadshotUrl(playerId: number): string {
  return `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:action:headshot:silo:current.png/w_213,q_auto:best/v1/people/${playerId}/headshot/67/current`;
}

export function mlbTeamLogoUrl(abbr: string): string {
  return `https://a.espncdn.com/i/teamlogos/mlb/500/${abbr.toLowerCase()}.png`;
}

export function nbaPlayerHeadshotUrl(playerId: number): string {
  return `https://cdn.nba.com/headshots/nba/latest/1040x760/${playerId}.png`;
}

export function nbaTeamLogoUrl(abbr: string): string {
  return `https://a.espncdn.com/i/teamlogos/nba/500/${abbr.toLowerCase()}.png`;
}

export function wnbaPlayerHeadshotUrl(playerId: number | string): string {
  return `https://a.espncdn.com/i/headshots/wnba/players/full/${playerId}.png`;
}

export function wnbaTeamLogoUrl(abbr: string): string {
  return `https://a.espncdn.com/i/teamlogos/wnba/500/${abbr.toLowerCase()}.png`;
}
