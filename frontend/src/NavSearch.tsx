// Global cross-sport intelligence search — Phase 83 + Phase 91.
// Searches NBA + MLB + WNBA in parallel for player matches, AND on
// focus (empty input) surfaces "trending edges across tonight's
// slates" — search is now a discovery surface, not just lookup.
//
// Mission: one search box, every player. Plus institutional terminal
// behavior — when nothing typed, show what's hot tonight.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getMlbDailySlate,
  getTodaySlate,
  getWnbaSlate,
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

type TrendingEdge = {
  sport: Sport;
  playerName: string;
  team: string | null;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  edgePercent: number;
  href: string;
};

export function NavSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchState>({ nba: [], mlb: [], wnba: [] });
  const [trending, setTrending] = useState<TrendingEdge[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const trendingFetchedRef = useRef(false);

  // Global keyboard shortcut — `/` or Cmd/Ctrl+K focuses the search
  // (Bloomberg / VSCode / GitHub convention). Don't hijack when the
  // user is already typing into another input/textarea/contenteditable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const isEditing = t && (
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        t.isContentEditable
      );
      if (isEditing) return;
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (isCmdK || isSlash) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      // Escape blurs the search (lets users dismiss the trending tray
      // without clicking elsewhere).
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        inputRef.current?.blur();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Lazy-load trending edges on first focus. Cached for the session
  // — server-side caches absorb cost across users.
  async function ensureTrendingLoaded() {
    if (trendingFetchedRef.current) return;
    trendingFetchedRef.current = true;
    const [nbaR, mlbR, wnbaR] = await Promise.allSettled([
      getTodaySlate('balanced'),
      getMlbDailySlate(),
      getWnbaSlate(),
    ]);
    const out: TrendingEdge[] = [];
    if (nbaR.status === 'fulfilled' && nbaR.value.resolved) {
      const seen = new Set<string>();
      for (const c of nbaR.value.resolved.combos) {
        for (const l of c.legs) {
          const k = `${l.playerId}-${l.statKey}-${l.line}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({
            sport: 'nba',
            playerName: l.playerName,
            team: l.team,
            statLabel: l.statLabel,
            line: l.line,
            direction: l.direction,
            edgePercent: l.edgePercent ?? 0,
            href: '/nba/slate',
          });
        }
      }
    }
    if (mlbR.status === 'fulfilled' && mlbR.value.resolved) {
      const seen = new Set<string>();
      for (const slot of mlbR.value.resolved.combos) {
        if (!slot.combo) continue;
        for (const l of slot.combo.legs) {
          const k = `${l.playerId}-${l.statKey}-${l.line}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({
            sport: 'mlb',
            playerName: l.playerName,
            team: l.team,
            statLabel: l.statLabel,
            line: l.line,
            direction: l.direction,
            edgePercent: l.edgePercent,
            href: '/mlb/slate',
          });
        }
      }
    }
    if (wnbaR.status === 'fulfilled' && wnbaR.value.resolved) {
      for (const l of wnbaR.value.resolved.lines.slice(0, 30)) {
        out.push({
          sport: 'wnba',
          playerName: l.playerName,
          team: l.team,
          statLabel: l.statLabel,
          line: l.line,
          direction: l.direction,
          edgePercent: l.edgePercent,
          href: '/wnba/slate',
        });
      }
    }
    out.sort((a, b) => b.edgePercent - a.edgePercent);
    setTrending(out.filter((e) => e.edgePercent >= 5).slice(0, 8));
  }

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
    <div className="nav-search" ref={wrapRef} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { setOpen(true); void ensureTrendingLoaded(); }}
        placeholder="Search any player or browse trending…"
        aria-label="Search any player across NBA, MLB, WNBA"
      />
      {/* Power-user kbd hint — only shown when the input is empty + not
          focused, so it doesn't crowd the placeholder while typing. */}
      {!query && !open && (
        <span
          aria-hidden
          className="nav-search-kbd"
          style={{
            position: 'absolute',
            right: 12,
            top: '50%',
            transform: 'translateY(-50%)',
            padding: '2px 6px',
            fontSize: 10,
            fontWeight: 700,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: 'rgba(255,255,255,0.45)',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 4,
            pointerEvents: 'none',
          }}
        >
          /
        </span>
      )}
      {open && query.trim().length < 2 && trending && trending.length > 0 && (
        <div className="nav-search-results" style={{ maxHeight: 480, overflowY: 'auto' }}>
          <div
            style={{
              padding: '6px 10px',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.5)',
              background: 'rgba(255,255,255,0.03)',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span>Trending tonight</span>
            <span style={{ color: 'rgba(255,255,255,0.4)' }}>by edge %</span>
          </div>
          {trending.map((t, i) => {
            const color = SPORT_COLOR[t.sport];
            return (
              <button
                key={i}
                className="nav-search-row"
                onClick={() => {
                  setOpen(false);
                  navigate(t.href);
                }}
                style={{ borderLeft: `3px solid ${color}` }}
              >
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: '0.08em',
                    color,
                    width: 32,
                    flexShrink: 0,
                  }}
                >
                  {t.sport.toUpperCase()}
                </span>
                <span className="nav-search-name" style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.playerName}
                  </span>
                  <span style={{ display: 'block', fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
                    {t.statLabel} {t.line} {t.direction === 'OVER' ? '↑' : '↓'} {t.team ?? ''}
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 800,
                    color: t.edgePercent >= 0 ? '#66bb6a' : '#ef5350',
                  }}
                >
                  {t.edgePercent >= 0 ? '+' : ''}{t.edgePercent.toFixed(0)}%
                </span>
              </button>
            );
          })}
        </div>
      )}
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
