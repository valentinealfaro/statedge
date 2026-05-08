import { useState } from 'react';

// NBA's CDN serves player headshots at this path. `playerId` is the same
// numeric id we already use across the API. Some players (rookies, retired,
// freshly-traded) may not have an image — onError swaps in initials.
function playerHeadshotUrl(playerId: number): string {
  return `https://cdn.nba.com/headshots/nba/latest/260x190/${playerId}.png`;
}

// ESPN's logo CDN uses the standard 3-letter abbreviation. More forgiving
// than NBA's id-based URL for legacy / relocated franchises.
function teamLogoUrl(abbr: string): string {
  return `https://a.espncdn.com/i/teamlogos/nba/500/${abbr.toLowerCase()}.png`;
}

// MLB's CDN — same pattern mlb.com uses on its own player pages.
// 213×213 transparent-background headshot, the same shot ESPN, FanGraphs,
// and PrizePicks pull from. Player ids match statsapi.mlb.com ids — i.e.
// the same numeric `playerId` we already use across our backend.
function mlbPlayerHeadshotUrl(playerId: number): string {
  return `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:action:headshot:silo:current.png/w_213,q_auto:best/v1/people/${playerId}/headshot/67/current`;
}

// ESPN's MLB logo CDN. Same convention as NBA — 3-letter team abbr.
function mlbTeamLogoUrl(abbr: string): string {
  return `https://a.espncdn.com/i/teamlogos/mlb/500/${abbr.toLowerCase()}.png`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

type PlayerAvatarProps = { playerId: number; name: string; size?: 'md' | 'lg' };

export function PlayerAvatar({ playerId, name, size = 'md' }: PlayerAvatarProps) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className={`avatar avatar-fallback ${size}`} aria-label={name}>
        {initials(name)}
      </div>
    );
  }
  return (
    <img
      className={`avatar player ${size}`}
      src={playerHeadshotUrl(playerId)}
      alt={name}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}

type TeamLogoProps = { abbr: string; name: string; size?: 'md' | 'lg' };

export function TeamLogo({ abbr, name, size = 'md' }: TeamLogoProps) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className={`avatar avatar-fallback ${size}`} aria-label={name}>
        {abbr}
      </div>
    );
  }
  return (
    <img
      className={`avatar team ${size}`}
      src={teamLogoUrl(abbr)}
      alt={name}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}

// ---------- MLB versions ----------
//
// Identical contracts to the NBA components — same sizes, same fallback
// to initials/abbr — so MLB pages can drop them in wherever the NBA
// code uses PlayerAvatar/TeamLogo.

export function MlbPlayerAvatar({ playerId, name, size = 'md' }: PlayerAvatarProps) {
  const [failed, setFailed] = useState(false);
  if (failed || !playerId) {
    return (
      <div className={`avatar avatar-fallback ${size}`} aria-label={name}>
        {initials(name)}
      </div>
    );
  }
  return (
    <img
      className={`avatar player ${size}`}
      src={mlbPlayerHeadshotUrl(playerId)}
      alt={name}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}

export function MlbTeamLogo({ abbr, name, size = 'md' }: TeamLogoProps) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className={`avatar avatar-fallback ${size}`} aria-label={name}>
        {abbr}
      </div>
    );
  }
  return (
    <img
      className={`avatar team ${size}`}
      src={mlbTeamLogoUrl(abbr)}
      alt={name}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}
