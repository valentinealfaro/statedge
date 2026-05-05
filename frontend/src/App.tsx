import { useState } from 'react';
import { PlayerSearch } from './PlayerSearch';
import { TeamPicker } from './TeamPicker';
import { ComparisonView } from './ComparisonView';
import type { Player, Team } from './api';

export function App() {
  const [player, setPlayer] = useState<Player | null>(null);
  const [team, setTeam] = useState<Team | null>(null);

  return (
    <div className="app">
      <h1>StatEdge</h1>
      <p className="tag">NBA Player vs Team — MVP</p>

      <PlayerSearch selected={player} onSelect={setPlayer} />
      {player && <TeamPicker selected={team} onSelect={setTeam} />}
      {player && team && <ComparisonView player={player} team={team} />}

      {(player || team) && (
        <button
          className="reset"
          onClick={() => {
            setPlayer(null);
            setTeam(null);
          }}
        >
          Start over
        </button>
      )}
    </div>
  );
}
