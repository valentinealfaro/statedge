import { useState } from 'react';
import { PlayerSearch } from './PlayerSearch';
import { TeamPicker } from './TeamPicker';
import { ComparisonView } from './ComparisonView';
import { PlayerVsPlayerView } from './PlayerVsPlayerView';
import { TeamVsTeamView } from './TeamVsTeamView';
import type { Player, Team } from './api';

type Mode = 'pvt' | 'pvp' | 'tvt';

const MODE_LABELS: Record<Mode, string> = {
  pvt: 'Player vs Team',
  pvp: 'Player vs Player',
  tvt: 'Team vs Team',
};

export function App() {
  const [mode, setMode] = useState<Mode>('pvt');

  // PvT
  const [player, setPlayer] = useState<Player | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  // PvP
  const [pA, setPA] = useState<Player | null>(null);
  const [pB, setPB] = useState<Player | null>(null);
  // TvT
  const [tA, setTA] = useState<Team | null>(null);
  const [tB, setTB] = useState<Team | null>(null);

  function reset() {
    setPlayer(null);
    setTeam(null);
    setPA(null);
    setPB(null);
    setTA(null);
    setTB(null);
  }

  function changeMode(m: Mode) {
    setMode(m);
    reset();
  }

  return (
    <div className="app">
      <h1>StatEdge</h1>
      <p className="tag">NBA stats comparison — MVP</p>

      <div className="mode-tabs">
        {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
          <button
            key={m}
            className={m === mode ? 'mode-tab active' : 'mode-tab'}
            onClick={() => changeMode(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {mode === 'pvt' && (
        <>
          <PlayerSearch selected={player} onSelect={setPlayer} />
          {player && <TeamPicker selected={team} onSelect={setTeam} />}
          {player && team && <ComparisonView player={player} team={team} />}
        </>
      )}

      {mode === 'pvp' && (
        <>
          <h2>1. Player A</h2>
          <PlayerSearch selected={pA} onSelect={setPA} />
          {pA && (
            <>
              <h2>2. Player B</h2>
              <PlayerSearch selected={pB} onSelect={setPB} />
            </>
          )}
          {pA && pB && <PlayerVsPlayerView a={pA} b={pB} />}
        </>
      )}

      {mode === 'tvt' && (
        <>
          <h2>1. Team A</h2>
          <TeamPicker selected={tA} onSelect={setTA} />
          {tA && (
            <>
              <h2>2. Team B</h2>
              <TeamPicker selected={tB} onSelect={setTB} />
            </>
          )}
          {tA && tB && <TeamVsTeamView a={tA} b={tB} />}
        </>
      )}

      {(player || team || pA || pB || tA || tB) && (
        <button className="reset" onClick={reset}>
          Start over
        </button>
      )}
    </div>
  );
}
