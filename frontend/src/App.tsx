import { useEffect, useState } from 'react';

type Player = {
  id: number;
  fullName: string;
  teamAbbreviation: string | null;
  isActive: boolean;
};

export function App() {
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
        const res = await fetch(`/api/search/players?query=${encodeURIComponent(q)}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { results: Player[] };
        setResults(data.results);
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

  return (
    <div className="app">
      <h1>StatEdge</h1>
      <p className="tag">NBA player search — MVP</p>

      <div className="search">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search NBA players (e.g. lebron)"
        />
      </div>

      {loading && <p className="muted">Searching…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && query && results.length === 0 && (
        <p className="muted">No players matched.</p>
      )}

      <div className="results">
        {results.map((p) => (
          <div key={p.id} className="result">
            <span>{p.fullName}</span>
            <span className="team">
              {p.teamAbbreviation ?? '—'} {p.isActive ? '' : '(retired)'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
