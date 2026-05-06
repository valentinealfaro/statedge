import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
import { getPlayerById, getTeams, type Player, type Team } from './api';

type Mode = 'pvt' | 'pvp' | 'tvt' | 'last10' | 'saved';

const MODE_LABELS: Record<Mode, string> = {
  pvt: 'Player vs Team',
  pvp: 'Player vs Player',
  tvt: 'Team vs Team',
  last10: 'Last 10 Games',
  saved: 'Saved',
};

const ALLOWED_MODES = new Set<Mode>(['pvt', 'pvp', 'tvt', 'last10', 'saved']);

export function Compare() {
  const { plan, canRunComparison } = usePlan();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialMode = (() => {
    const m = searchParams.get('m');
    return m && ALLOWED_MODES.has(m as Mode) ? (m as Mode) : 'pvt';
  })();

  const [mode, setModeState] = useState<Mode>(initialMode);
  const [player, setPlayerState] = useState<Player | null>(null);
  const [team, setTeamState] = useState<Team | null>(null);
  const [pA, setPAState] = useState<Player | null>(null);
  const [pB, setPBState] = useState<Player | null>(null);
  const [tA, setTAState] = useState<Team | null>(null);
  const [tB, setTBState] = useState<Team | null>(null);
  const [solo, setSoloState] = useState<Player | null>(null);
  const [hydrating, setHydrating] = useState(false);

  // One-time URL hydration on mount: if the URL carries entity ids, fetch
  // their metadata and populate state. Subsequent state changes drive the
  // URL (not the other way around) to keep the data flow one-directional.
  useEffect(() => {
    const m = searchParams.get('m');
    const pid = num(searchParams.get('pid'));
    const tid = num(searchParams.get('tid'));
    const pa = num(searchParams.get('pa'));
    const pb = num(searchParams.get('pb'));
    const ta = num(searchParams.get('ta'));
    const tb = num(searchParams.get('tb'));

    if (!pid && !tid && !pa && !pb && !ta && !tb) return;
    setHydrating(true);

    (async () => {
      try {
        const teams = (ta || tb || tid) ? await getTeams() : [];
        const lookupTeam = (id: number | null): Team | undefined =>
          id ? teams.find((t) => t.id === id) : undefined;

        if (m === 'pvt' || (pid && tid)) {
          if (pid) setPlayerState(await getPlayerById(pid));
          if (tid) setTeamState(lookupTeam(tid) ?? null);
        } else if (m === 'pvp' || (pa && pb)) {
          const [a, b] = await Promise.all([
            pa ? getPlayerById(pa) : null,
            pb ? getPlayerById(pb) : null,
          ]);
          if (a) setPAState(a);
          if (b) setPBState(b);
        } else if (m === 'tvt' || (ta && tb)) {
          if (ta) setTAState(lookupTeam(ta) ?? null);
          if (tb) setTBState(lookupTeam(tb) ?? null);
        } else if (m === 'last10' || pid) {
          if (pid) setSoloState(await getPlayerById(pid));
        }
      } finally {
        setHydrating(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // URL writers — every state mutation that changes "what comparison is on
  // screen" goes through one of these so the URL stays in sync.
  function syncUrl(next: {
    mode?: Mode;
    pid?: number | null;
    tid?: number | null;
    pa?: number | null;
    pb?: number | null;
    ta?: number | null;
    tb?: number | null;
  }) {
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (next.mode !== undefined) sp.set('m', next.mode);
        const setOrDelete = (k: string, v: number | null | undefined) => {
          if (v == null) sp.delete(k);
          else sp.set(k, String(v));
        };
        if ('pid' in next) setOrDelete('pid', next.pid);
        if ('tid' in next) setOrDelete('tid', next.tid);
        if ('pa'  in next) setOrDelete('pa',  next.pa);
        if ('pb'  in next) setOrDelete('pb',  next.pb);
        if ('ta'  in next) setOrDelete('ta',  next.ta);
        if ('tb'  in next) setOrDelete('tb',  next.tb);
        return sp;
      },
      { replace: true },
    );
  }

  function setPlayer(p: Player | null) {
    setPlayerState(p);
    syncUrl({ pid: p?.id ?? null });
  }
  function setTeam(t: Team | null) {
    setTeamState(t);
    syncUrl({ tid: t?.id ?? null });
  }
  function setPA(p: Player | null) {
    setPAState(p);
    syncUrl({ pa: p?.id ?? null });
  }
  function setPB(p: Player | null) {
    setPBState(p);
    syncUrl({ pb: p?.id ?? null });
  }
  function setTA(t: Team | null) {
    setTAState(t);
    syncUrl({ ta: t?.id ?? null });
  }
  function setTB(t: Team | null) {
    setTBState(t);
    syncUrl({ tb: t?.id ?? null });
  }
  function setSolo(p: Player | null) {
    setSoloState(p);
    // Last10 reuses `pid` since it's the only entity in that mode.
    syncUrl({ pid: p?.id ?? null });
  }

  function reset() {
    setPlayerState(null);
    setTeamState(null);
    setPAState(null);
    setPBState(null);
    setTAState(null);
    setTBState(null);
    setSoloState(null);
    syncUrl({ pid: null, tid: null, pa: null, pb: null, ta: null, tb: null });
  }

  function changeMode(m: Mode) {
    setModeState(m);
    reset();
    syncUrl({ mode: m });
  }

  function openSaved(item: SavedItem) {
    reset();
    switch (item.type) {
      case 'pvt':
        setModeState('pvt');
        setPlayerState(item.player);
        setTeamState(item.team);
        syncUrl({ mode: 'pvt', pid: item.player.id, tid: item.team.id });
        return;
      case 'pvp':
        setModeState('pvp');
        setPAState(item.a);
        setPBState(item.b);
        syncUrl({ mode: 'pvp', pa: item.a.id, pb: item.b.id });
        return;
      case 'tvt':
        setModeState('tvt');
        setTAState(item.a);
        setTBState(item.b);
        syncUrl({ mode: 'tvt', ta: item.a.id, tb: item.b.id });
        return;
      case 'last10':
        setModeState('last10');
        setSoloState(item.player);
        syncUrl({ mode: 'last10', pid: item.player.id });
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

      {hydrating && <p className="muted">Loading shared comparison…</p>}

      {nothingPicked && mode !== 'saved' && !hydrating && <RecentsRail onOpen={openSaved} />}

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

function num(s: string | null): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
