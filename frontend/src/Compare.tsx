import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PlayerSearch } from './PlayerSearch';
import { TeamPicker } from './TeamPicker';
import { ComparisonView } from './ComparisonView';
import { PlayerVsPlayerView } from './PlayerVsPlayerView';
import { TeamVsTeamView } from './TeamVsTeamView';
import { Last10View } from './Last10View';
import { FreshnessBanner } from './FreshnessBanner';
import { PlanGate } from './PlanGate';
import { RecentsRail } from './RecentsRail';
import { SavedList } from './SavedList';
import { usePlan } from './plan';
import type { SavedItem } from './saved';
import type { Player, Team } from './api';

type Mode = 'pvt' | 'pvp' | 'tvt' | 'last10' | 'saved';

const MODE_LABELS: Record<Mode, string> = {
  pvt: 'Player vs Team',
  pvp: 'Player vs Player',
  tvt: 'Team vs Team',
  last10: 'Last 10 Games',
  saved: 'Saved',
};

export function Compare() {
  const { plan, canRunComparison } = usePlan();
  const [mode, setMode] = useState<Mode>('pvt');
  const [player, setPlayer] = useState<Player | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [pA, setPA] = useState<Player | null>(null);
  const [pB, setPB] = useState<Player | null>(null);
  const [tA, setTA] = useState<Team | null>(null);
  const [tB, setTB] = useState<Team | null>(null);
  const [solo, setSolo] = useState<Player | null>(null);

  function reset() {
    setPlayer(null);
    setTeam(null);
    setPA(null);
    setPB(null);
    setTA(null);
    setTB(null);
    setSolo(null);
  }

  function changeMode(m: Mode) {
    setMode(m);
    reset();
  }

  function openSaved(item: SavedItem) {
    reset();
    switch (item.type) {
      case 'pvt':
        setPlayer(item.player);
        setTeam(item.team);
        setMode('pvt');
        return;
      case 'pvp':
        setPA(item.a);
        setPB(item.b);
        setMode('pvp');
        return;
      case 'tvt':
        setTA(item.a);
        setTB(item.b);
        setMode('tvt');
        return;
      case 'last10':
        setSolo(item.player);
        setMode('last10');
        return;
    }
  }

  // Show the recents rail above the search prompts only when nothing has
  // been picked yet — once a comparison is up, the rail is just noise.
  const nothingPicked =
    !player && !team && !pA && !pB && !tA && !tB && !solo;

  // Free users don't get the Saved tab — saving is a Pro feature.
  const visibleModes = (Object.keys(MODE_LABELS) as Mode[]).filter(
    (m) => m !== 'saved' || plan === 'pro',
  );

  return (
    <div className="app">
      <Link to="/" className="brand">StatEdge</Link>
      <p className="tag">NBA stats comparison</p>
      <FreshnessBanner />
      <PlanGate />

      <div className="mode-tabs">
        {visibleModes.map((m) => (
          <button
            key={m}
            className={m === mode ? 'mode-tab active' : 'mode-tab'}
            onClick={() => changeMode(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {nothingPicked && mode !== 'saved' && <RecentsRail onOpen={openSaved} />}

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
          {pA && pB && canRunComparison && <PlayerVsPlayerView a={pA} b={pB} />}
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
          {tA && tB && canRunComparison && <TeamVsTeamView a={tA} b={tB} />}
        </>
      )}

      {mode === 'last10' && (
        <>
          <PlayerSearch selected={solo} onSelect={setSolo} />
          {solo && canRunComparison && <Last10View player={solo} />}
        </>
      )}

      {mode === 'saved' && (
        <>
          <h2>Your saved comparisons</h2>
          <SavedList onOpen={openSaved} />
        </>
      )}

      {(player || team || pA || pB || tA || tB || solo) && mode !== 'saved' && (
        <button className="reset" onClick={reset}>
          Start over
        </button>
      )}
    </div>
  );
}
