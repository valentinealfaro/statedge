// Global cross-sport intelligence search — Phase 83. Searches NBA +
// MLB + WNBA in parallel, returns results grouped by sport, with
// sport-colored section headers. Each result routes to that sport's
// canonical player surface.
//
// Mission: one search box, every player. The institutional terminal
// vibe — type a name, jump to the data.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  searchMlbPlayers,
  searchPlayers,
  searchWnbaPlayers,
  type MlbSearchPlayer,
  type Player,
  type WnbaSearchPlayer,
} from './api';
import { MlbPlayerAvatar, PlayerAvatar, WnbaPlayerAvatar } from './Avatar';

type Sport = 'nba' | 'mlb' | 'wnba';

const SPORT_COLOR: Record<Sport, string> = {
  nba:  '#7aa2ff',
  mlb:  '#66bb6a',
  wnba: '#b388ff',
};

type SearchState = {
  nba: Player[];
  mlb: MlbSearchPlayer[];
  wnba: WnbaSearchPlayer[];
};

export function NavSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchState>({ nba: [], mlb: [], wnba: [] });
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults({ nba: [], mlb: [], wnba: [] }); return; }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      const [nbaR, mlbR, wnbaR] = await Promise.allSettled([
        searchPlayers(q, ctrl.signal).catch(() => []),
        searchMlbPlayers(q).catch(() => []),
        searchWnbaPlayers(q, ctrl.signal).catch(() => []),
      ]);
      if (ctrl.signal.aborted) return;
      setResults({
        nba:  nbaR.status === 'fulfilled' ? nbaR.value.slice(0, 5) : [],
        mlb:  mlbR.status === 'fulfilled' ? mlbR.value.slice(0, 5) : [],
        wnba: wnbaR.status === 'fulfilled' ? wnbaR.value.slice(0, 5) : [],
      });
      setLoading(false);
    }, 220);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [query]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function pickNba(p: Player) {
    setOpen(false); setQuery(''); setResults({ nba: [], mlb: [], wnba: [] });
    navigate(`/nba/compare?m=last10&pid=${p.id}`);
  }
  function pickMlb(p: MlbSearchPlayer) {
    setOpen(false); setQuery(''); setResults({ nba: [], mlb: [], wnba: [] });
    navigate(`/mlb/player/${p.id}`);
  }
  function pickWnba(p: WnbaSearchPlayer) {
    setOpen(false); setQuery(''); setResults({ nba: [], mlb: [], wnba: [] });
    navigate(`/wnba/compare?aid=${encodeURIComponent(p.id)}`);
  }

  const totalResults = results.nba.length + results.mlb.length + results.wnba.length;
  const showTray = open && query.trim().length >= 2;

  return (
    <div className="nav-search" ref={wrapRef}>
      <input
        type="search"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search any player…"
        aria-label="Search any player across NBA, MLB, WNBA"
      />
      {showTray && (
        <div className="nav-search-results" style={{ maxHeight: 480, overflowY: 'auto' }}>
          {loading && totalResults === 0 && (
            <div className="nav-search-empty">Searching all sports…</div>
          )}
          {!loading && totalResults === 0 && (
            <div className="nav-search-empty">No matches across NBA, MLB, or WNBA</div>
          )}

          {results.nba.length > 0 && (
            <SportSection sport="nba" count={results.nba.length}>
              {results.nba.map((p) => (
                <button key={`nba:${p.id}`} className="nav-search-row" onClick={() => pickNba(p)}>
                  <PlayerAvatar playerId={p.id} name={p.fullName} size="md" />
                  <span className="nav-search-name">{p.fullName}</span>
                  <span className="nav-search-team">{p.teamAbbreviation ?? '—'}</span>
                </button>
              ))}
            </SportSection>
          )}

          {results.mlb.length > 0 && (
            <SportSection sport="mlb" count={results.mlb.length}>
              {results.mlb.map((p) => (
                <button key={`mlb:${p.id}`} className="nav-search-row" onClick={() => pickMlb(p)}>
                  <MlbPlayerAvatar playerId={p.id} name={p.fullName} size="md" />
                  <span className="nav-search-name">{p.fullName}</span>
                  <span className="nav-search-team">{p.team?.abbreviation ?? '—'}</span>
                </button>
              ))}
            </SportSection>
          )}

          {results.wnba.length > 0 && (
            <SportSection sport="wnba" count={results.wnba.length}>
              {results.wnba.map((p) => (
                <button key={`wnba:${p.id}`} className="nav-search-row" onClick={() => pickWnba(p)}>
                  <WnbaPlayerAvatar playerId={p.id} name={p.displayName} size="md" />
                  <span className="nav-search-name">{p.displayName}</span>
                  <span className="nav-search-team">{p.team ?? '—'}</span>
                </button>
              ))}
            </SportSection>
          )}
        </div>
      )}
    </div>
  );
}

function SportSection({ sport, count, children }: { sport: Sport; count: number; children: React.ReactNode }) {
  const color = SPORT_COLOR[sport];
  return (
    <div>
      <div
        style={{
          padding: '6px 10px',
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color,
          background: `${color}11`,
          borderTop: `1px solid ${color}22`,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>{sport.toUpperCase()}</span>
        <span style={{ color: 'rgba(255,255,255,0.4)' }}>{count}</span>
      </div>
      {children}
    </div>
  );
}
