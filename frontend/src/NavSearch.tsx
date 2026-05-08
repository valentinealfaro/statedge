import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  searchMlbPlayers,
  searchPlayers,
  type MlbSearchPlayer,
  type Player,
} from './api';
import { PlayerAvatar } from './Avatar';

// Compact "jump to player" search that lives in the navbar. Always
// visible on Compare/Standings/Game pages so a user can pivot from
// anything to anyone in two keystrokes.
//
// Sport-aware: on /mlb/* routes searches mlb_players and routes to
// /mlb/player/:id; on /nba/* (or default) searches NBA and routes
// to /nba/compare with the player pre-loaded.
type AnyPlayer =
  | (Player & { _sport: 'nba' })
  | (MlbSearchPlayer & { _sport: 'mlb' });

export function NavSearch() {
  const location = useLocation();
  const isMlb = location.pathname.startsWith('/mlb');
  const sport: 'mlb' | 'nba' = isMlb ? 'mlb' : 'nba';

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AnyPlayer[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return; }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        if (sport === 'mlb') {
          const list = await searchMlbPlayers(q);
          setResults(list.slice(0, 6).map((p) => ({ ...p, _sport: 'mlb' as const })));
        } else {
          const list = await searchPlayers(q, ctrl.signal);
          setResults(list.slice(0, 6).map((p) => ({ ...p, _sport: 'nba' as const })));
        }
      } catch { /* ignore */ }
      finally { setLoading(false); }
    }, 200);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [query, sport]);

  // Close the dropdown on outside click. Keeps the input visible but
  // hides the result tray so the rest of the page is reachable.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function pick(p: AnyPlayer) {
    setOpen(false);
    setQuery('');
    setResults([]);
    if (p._sport === 'mlb') {
      navigate(`/mlb/player/${p.id}`);
    } else {
      navigate(`/nba/compare?m=last10&pid=${p.id}`);
    }
  }

  function teamFor(p: AnyPlayer): string {
    if (p._sport === 'mlb') return p.team?.abbreviation ?? '—';
    return p.teamAbbreviation ?? '—';
  }

  return (
    <div className="nav-search" ref={wrapRef}>
      <input
        type="search"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={`Find an ${sport.toUpperCase()} player…`}
        aria-label={`Find an ${sport.toUpperCase()} player`}
      />
      {open && query.trim().length > 0 && (
        <div className="nav-search-results">
          {loading && results.length === 0 && (
            <div className="nav-search-empty">Searching…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="nav-search-empty">No matches</div>
          )}
          {results.map((p) => (
            <button key={`${p._sport}:${p.id}`} className="nav-search-row" onClick={() => pick(p)}>
              <PlayerAvatar playerId={p.id} name={p.fullName} size="md" />
              <span className="nav-search-name">{p.fullName}</span>
              <span className="nav-search-team">{teamFor(p)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
