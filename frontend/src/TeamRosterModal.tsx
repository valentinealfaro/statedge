import { useEffect, useState } from 'react';
import {
  getTeamRoster,
  type RosterPlayer,
  type Team,
} from './api';
import { PlayerAvatar, TeamLogo } from './Avatar';
import { Skeleton } from './Skeleton';

type Props = {
  team: Team;
  opponent: Team;
  onPick: (player: RosterPlayer) => void;
  onClose: () => void;
};

// Picker modal that shows a team's full active roster sorted by
// minutes-played this season, so the rotation comes up first. Used
// from /slate Build mode when a user clicks a team in the today's-
// games rail — replaces the type-the-name flow with a one-click pick.
export function TeamRosterModal({ team, opponent, onPick, onClose }: Props) {
  const [players, setPlayers] = useState<RosterPlayer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTeamRoster(team.id)
      .then((d) => setPlayers(d.players))
      .catch((e) => setError((e as Error).message));
  }, [team.id]);

  // Close on Escape so power users don't have to mouse the X.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="roster-modal" onClick={(e) => e.stopPropagation()}>
        <div className="roster-modal-head">
          <TeamLogo abbr={team.abbreviation} name={team.fullName} size="lg" />
          <div className="roster-modal-title">
            <div className="roster-modal-team">{team.fullName}</div>
            <div className="muted small">vs {opponent.abbreviation} · pick a player</div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {error && <p className="error">{error}</p>}

        {!players && !error && (
          <div className="roster-list">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="roster-row">
                <Skeleton width={40} height={40} radius="50%" />
                <div style={{ flex: 1 }}>
                  <Skeleton width="60%" height={14} />
                  <Skeleton width="40%" height={11} style={{ marginTop: 4 }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {players && (
          <div className="roster-list">
            {players.length === 0 && (
              <p className="muted small">No active players found for this team.</p>
            )}
            {players.map((p) => (
              <button
                key={p.id}
                className="roster-row"
                onClick={() => { onPick(p); onClose(); }}
              >
                <PlayerAvatar playerId={p.id} name={p.fullName} size="lg" />
                <div className="roster-row-body">
                  <div className="roster-row-name">{p.fullName}</div>
                  {p.gamesPlayed > 0 ? (
                    <div className="muted small">
                      {p.ppg.toFixed(1)} pts · {p.rpg.toFixed(1)} reb · {p.apg.toFixed(1)} ast
                      <span style={{ marginLeft: 8 }}>· {p.gamesPlayed} games</span>
                    </div>
                  ) : (
                    <div className="muted small">No cached games this season</div>
                  )}
                </div>
                <span className="roster-row-pick">Pick →</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
