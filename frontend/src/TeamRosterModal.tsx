import { useEffect, useState } from 'react';
import {
  getTeamRoster,
  searchPlayers,
  type Player,
  type RosterPlayer,
  type Team,
} from './api';
import { PlayerAvatar, TeamLogo } from './Avatar';
import { Skeleton } from './Skeleton';

type Props = {
  // Both teams in the matchup. The user can pick from either roster;
  // we derive opponent automatically based on which side they pick.
  home: Team;
  away: Team;
  // Called with the picked player + the opponent that should be set on
  // the slot (the team they did NOT pick from).
  onPick: (player: Player | RosterPlayer, opponent: Team) => void;
  onClose: () => void;
};

// Game-picker modal: shows BOTH teams' rosters side-by-side, sorted by
// minutes-played this season, so the rotation comes up first. If the
// backend's roster endpoint isn't available (stale Vercel deploy) we
// fall back to a player-search input the user can type into — keeps the
// flow unblocked even when the backend is behind.
export function TeamRosterModal({ home, away, onPick, onClose }: Props) {
  const [homeRoster, setHomeRoster] = useState<RosterPlayer[] | null>(null);
  const [awayRoster, setAwayRoster] = useState<RosterPlayer[] | null>(null);
  const [rosterFailed, setRosterFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getTeamRoster(home.id), getTeamRoster(away.id)])
      .then(([h, a]) => {
        if (cancelled) return;
        setHomeRoster(h.players);
        setAwayRoster(a.players);
      })
      .catch(() => {
        if (cancelled) return;
        // Backend likely missing the /roster endpoint — fall back to
        // search-by-name. Both rosters get null, search input renders.
        setRosterFailed(true);
      });
    return () => { cancelled = true; };
  }, [home.id, away.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="game-modal" onClick={(e) => e.stopPropagation()}>
        <div className="game-modal-head">
          <div className="game-modal-title">
            <TeamLogo abbr={away.abbreviation} name={away.fullName} size="lg" />
            <span className="game-modal-vs">@</span>
            <TeamLogo abbr={home.abbreviation} name={home.fullName} size="lg" />
            <div className="game-modal-text">
              <div className="game-modal-matchup">
                {away.abbreviation} @ {home.abbreviation}
              </div>
              <div className="muted small">Pick any player from either team</div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {rosterFailed ? (
          <RosterSearchFallback home={home} away={away} onPick={onPick} onClose={onClose} />
        ) : (
          <div className="game-rosters">
            <RosterColumn
              team={away}
              opponent={home}
              players={awayRoster}
              onPick={onPick}
              onClose={onClose}
            />
            <RosterColumn
              team={home}
              opponent={away}
              players={homeRoster}
              onPick={onPick}
              onClose={onClose}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function RosterColumn({
  team,
  opponent,
  players,
  onPick,
  onClose,
}: {
  team: Team;
  opponent: Team;
  players: RosterPlayer[] | null;
  onPick: (player: RosterPlayer, opponent: Team) => void;
  onClose: () => void;
}) {
  return (
    <div className="game-roster-col">
      <div className="game-roster-col-head">
        <TeamLogo abbr={team.abbreviation} name={team.fullName} size="md" />
        <span className="game-roster-col-name">{team.abbreviation}</span>
      </div>

      {!players ? (
        <div className="roster-list">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="roster-row">
              <Skeleton width={32} height={32} radius="50%" />
              <div style={{ flex: 1 }}>
                <Skeleton width="60%" height={12} />
                <Skeleton width="40%" height={10} style={{ marginTop: 4 }} />
              </div>
            </div>
          ))}
        </div>
      ) : players.length === 0 ? (
        <p className="muted small" style={{ padding: 12 }}>
          No active players cached for this team.
        </p>
      ) : (
        <div className="roster-list">
          {players.map((p, i) => (
            <button
              key={p.id}
              className={`roster-row ${i < 5 ? 'starter' : ''}`}
              onClick={() => { onPick(p, opponent); onClose(); }}
            >
              <PlayerAvatar playerId={p.id} name={p.fullName} size="lg" />
              <div className="roster-row-body">
                <div className="roster-row-name">{p.fullName}</div>
                {p.gamesPlayed > 0 ? (
                  <div className="roster-row-stats">
                    <span><strong>{p.ppg.toFixed(1)}</strong> ppg</span>
                    <span className="dot">·</span>
                    <span><strong>{p.rpg.toFixed(1)}</strong> reb</span>
                    <span className="dot">·</span>
                    <span><strong>{p.apg.toFixed(1)}</strong> ast</span>
                    <span className="roster-row-gp">{p.gamesPlayed}g</span>
                  </div>
                ) : (
                  <div className="roster-row-stats muted">no cached games this season</div>
                )}
              </div>
              <span className="roster-row-pick" aria-hidden>→</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Stale-backend fallback: search-by-name with a small filter to either
// team. We can't sort by minutes (search doesn't return stats) but at
// least the user isn't blocked.
function RosterSearchFallback({
  home,
  away,
  onPick,
  onClose,
}: {
  home: Team;
  away: Team;
  onPick: (player: Player, opponent: Team) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Player[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    const ctrl = new AbortController();
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const list = await searchPlayers(q, ctrl.signal);
        // Keep only players on either side of this game.
        const filtered = list.filter(
          (p) =>
            p.teamAbbreviation === home.abbreviation ||
            p.teamAbbreviation === away.abbreviation,
        );
        setResults(filtered.slice(0, 12));
      } catch { /* ignore */ }
      finally { setSearching(false); }
    }, 200);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [query, home.abbreviation, away.abbreviation]);

  return (
    <div className="game-fallback">
      <p className="muted small" style={{ padding: '8px 12px 0' }}>
        Roster API unavailable — search by name (filters to {away.abbreviation} or {home.abbreviation}):
      </p>
      <input
        autoFocus
        type="search"
        className="manual-slot-input"
        style={{ margin: 12 }}
        placeholder="Type a player name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query.trim().length >= 2 && (
        <div className="roster-list" style={{ padding: '0 12px 12px' }}>
          {searching && results.length === 0 && (
            <div className="muted small" style={{ padding: 8 }}>Searching…</div>
          )}
          {!searching && results.length === 0 && (
            <div className="muted small" style={{ padding: 8 }}>
              No matches on either team.
            </div>
          )}
          {results.map((p) => {
            const onTeam = p.teamAbbreviation === home.abbreviation ? home : away;
            const opp = onTeam.id === home.id ? away : home;
            return (
              <button
                key={p.id}
                className="roster-row"
                onClick={() => { onPick(p, opp); onClose(); }}
              >
                <PlayerAvatar playerId={p.id} name={p.fullName} size="md" />
                <div className="roster-row-body">
                  <div className="roster-row-name">{p.fullName}</div>
                  <div className="muted small">{p.teamAbbreviation ?? '—'}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
