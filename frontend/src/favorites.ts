// User favorites — players and team — persisted in localStorage and
// keyed by signed-in uid (via userKey) so different users on the
// same browser don't see each other's pins.

import { useEffect, useState } from 'react';
import { onUidChange, userKey } from './userKey';

const PLAYERS_KEY = 'fav:players';   // number[]   — NBA player ids
const TEAM_KEY = 'fav:team';         // string|null — NBA team abbreviation

function readPlayers(): number[] {
  try {
    const raw = localStorage.getItem(userKey(PLAYERS_KEY));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

function writePlayers(ids: number[]): void {
  try {
    localStorage.setItem(userKey(PLAYERS_KEY), JSON.stringify(ids));
  } catch { /* ignore */ }
}

function readTeam(): string | null {
  try {
    return localStorage.getItem(userKey(TEAM_KEY));
  } catch {
    return null;
  }
}

function writeTeam(abbr: string | null): void {
  try {
    if (abbr) localStorage.setItem(userKey(TEAM_KEY), abbr);
    else localStorage.removeItem(userKey(TEAM_KEY));
  } catch { /* ignore */ }
}

export type FavoritesAPI = {
  players: number[];
  team: string | null;
  isFavoritePlayer: (id: number) => boolean;
  toggleFavoritePlayer: (id: number) => void;
  isFavoriteTeam: (abbr: string) => boolean;
  setFavoriteTeam: (abbr: string | null) => void;
};

export function useFavorites(): FavoritesAPI {
  const [players, setPlayers] = useState<number[]>(() => readPlayers());
  const [team, setTeam] = useState<string | null>(() => readTeam());

  // Re-read when the signed-in user changes — switching account
  // should immediately swap the favorites view to the new user's set.
  useEffect(() => {
    return onUidChange(() => {
      setPlayers(readPlayers());
      setTeam(readTeam());
    });
  }, []);

  function toggleFavoritePlayer(id: number) {
    setPlayers((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      writePlayers(next);
      return next;
    });
  }

  function setFavoriteTeam(abbr: string | null) {
    setTeam(abbr);
    writeTeam(abbr);
  }

  return {
    players,
    team,
    isFavoritePlayer: (id) => players.includes(id),
    toggleFavoritePlayer,
    isFavoriteTeam: (abbr) => team === abbr,
    setFavoriteTeam,
  };
}
