import { useEffect, useState } from 'react';
import { searchPlayers, type Player } from './api';

type Props = {
  selected: Player | null;
  onSelect: (p: Player | null) => void;
};

export function PlayerSearch({ selected, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Player[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <span className="label">Player</span>
        <span className="name">{selected.fullName}</span>
        <span className="team">{selected.teamAbbreviation ?? '—'}</span>
        <button className="link" onClick={() => onSelect(null)}>
          change
        </button>
      </div>
    );
  }

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
      <div className="results">
        {results.map((p) => (
          <button key={p.id} className="result" onClick={() => onSelect(p)}>
            <span>{p.fullName}</span>
            <span className="team">
              {p.teamAbbreviation ?? '—'} {p.isActive ? '' : '(retired)'}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
