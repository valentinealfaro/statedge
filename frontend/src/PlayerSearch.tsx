import { useEffect, useState } from 'react';
import {
  getTrendingPlayers,
  searchPlayers,
  type Player,
  type TrendingPlayer,
} from './api';
import { PlayerAvatar } from './Avatar';

type Props = {
  selected: Player | null;
  onSelect: (p: Player | null) => void;
};

// Module-scoped cache: trending players don't change for the duration of a
// session, and every PlayerSearch component on the page shares them.
let trendingCache: TrendingPlayer[] | null = null;
let trendingPromise: Promise<TrendingPlayer[]> | null = null;
function loadTrending(): Promise<TrendingPlayer[]> {
  if (trendingCache) return Promise.resolve(trendingCache);
  if (trendingPromise) return trendingPromise;
  trendingPromise = getTrendingPlayers(8)
    .then((list) => { trendingCache = list; return list; })
    .catch(() => []);
  return trendingPromise;
}

export function PlayerSearch({ selected, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Player[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<TrendingPlayer[]>([]);

  // Prefetch trending suggestions once so the empty-input state has content
  // ready by the time the user looks.
  useEffect(() => {
    if (selected) return;
    loadTrending().then(setSuggestions);
  }, [selected]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const list = await searchPlayers(q, ctrl.signal);
        setResults(list);
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [query]);

  if (selected) {
    return (
      <div className="picked">
        <PlayerAvatar playerId={selected.id} name={selected.fullName} size="md" />
        <span className="label">Player</span>
        <span className="name">{selected.fullName}</span>
        <span className="team">{selected.teamAbbreviation ?? '—'}</span>
        <button className="link" onClick={() => onSelect(null)}>
          change
        </button>
      </div>
    );
  }

  const showingResults = query.trim().length > 0;

  return (
    <div className="step">
      <h2>1. Pick a player</h2>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search NBA players (e.g. lebron)"
      />
      {loading && <p className="muted">Searching…</p>}
      {error && <p className="error">{error}</p>}

      {showingResults && (
        <div className="results">
          {results.map((p) => (
            <button key={p.id} className="result" onClick={() => onSelect(p)}>
              <PlayerAvatar playerId={p.id} name={p.fullName} size="md" />
              <span className="result-name">{p.fullName}</span>
              <span className="team">
                {p.teamAbbreviation ?? '—'} {p.isActive ? '' : '(retired)'}
              </span>
            </button>
          ))}
        </div>
      )}

      {!showingResults && suggestions.length > 0 && (
        <>
          <p className="muted small suggest-label">Or pick a top scorer:</p>
          <div className="results">
            {suggestions.map((p) => (
              <button key={p.id} className="result" onClick={() => onSelect(p)}>
                <PlayerAvatar playerId={p.id} name={p.fullName} size="md" />
                <span className="result-name">{p.fullName}</span>
                <span className="team">
                  {p.teamAbbreviation ?? '—'} · {p.ppg.toFixed(1)} PPG
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
