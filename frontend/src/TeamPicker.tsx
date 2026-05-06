import { useEffect, useState } from 'react';
import { getTeams, type Team } from './api';
import { TeamLogo } from './Avatar';

type Props = {
  selected: Team | null;
  onSelect: (t: Team | null) => void;
};

export function TeamPicker({ selected, onSelect }: Props) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTeams().then(setTeams).catch((e) => setError((e as Error).message));
  }, []);

  if (selected) {
    return (
      <div className="picked">
        <TeamLogo abbr={selected.abbreviation} name={selected.fullName} size="md" />
        <span className="label">Opponent</span>
        <span className="name">{selected.fullName}</span>
        <button className="link" onClick={() => onSelect(null)}>
          change
        </button>
      </div>
    );
  }

  return (
    <div className="step">
      <h2>2. Pick an opponent team</h2>
      {error && <p className="error">{error}</p>}
      <div className="team-grid">
        {teams.map((t) => (
          <button key={t.id} className="team-tile" onClick={() => onSelect(t)}>
            <TeamLogo abbr={t.abbreviation} name={t.fullName} size="md" />
            <span className="abbr">{t.abbreviation}</span>
            <span className="full">{t.fullName}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
