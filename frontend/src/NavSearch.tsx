import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchPlayers, type Player } from './api';
import { PlayerAvatar } from './Avatar';

// Compact "jump to player" search that lives in the navbar. Always
// visible on Compare/Standings/Game pages so a user can pivot from
// anything to anyone in two keystrokes.
export function NavSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Player[]>([]);
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
        const list = await searchPlayers(q, ctrl.signal);
        setResults(list.slice(0, 6));
      } catch { /* ignore */ }
      finally { setLoading(false); }
    }, 200);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [query]);

  // Close the dropdown on outside click. Keeps the input visible but
  // hides the result tray so the rest of the page is reachable.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function pick(p: Player) {
    setOpen(false);
    setQuery('');
    setResults([]);
    navigate(`/compare?m=last10&pid=${p.id}`);
  }

  return (
    <div className="nav-search" ref={wrapRef}>
      <input
        type="search"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Find a player…"
        aria-label="Find a player"
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
            <button key={p.id} className="nav-search-row" onClick={() => pick(p)}>
              <PlayerAvatar playerId={p.id} name={p.fullName} size="md" />
              <span className="nav-search-name">{p.fullName}</span>
              <span className="nav-search-team">{p.teamAbbreviation ?? '—'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
