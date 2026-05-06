import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTrendingPlayers, type TrendingPlayer } from './api';
import { PlayerAvatar } from './Avatar';

// "Top season scorers" rail. Lives on the Home page so a fresh visitor
// has something to click without typing a search. Each card deep-links
// to the player's Last 10 view via the URL-state pattern in Compare.tsx.
export function TrendingPlayers() {
  const [players, setPlayers] = useState<TrendingPlayer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTrendingPlayers(8)
      .then(setPlayers)
      .catch(() => setPlayers([]))
      .finally(() => setLoading(false));
  }, []);

  if (!loading && players.length === 0) return null;

  return (
    <section className="trending">
      <h2>This season's top scorers</h2>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="trending-grid">
          {players.map((p) => (
            <Link
              key={p.id}
              className="trending-card"
              to={`/compare?m=last10&pid=${p.id}`}
            >
              <PlayerAvatar playerId={p.id} name={p.fullName} size="lg" />
              <div className="trending-name">{p.fullName}</div>
              <div className="trending-team">{p.teamAbbreviation ?? '—'}</div>
              <div className="trending-stats">
                <span><strong>{p.ppg.toFixed(1)}</strong> PPG</span>
                <span>{p.rpg.toFixed(1)} RPG</span>
                <span>{p.apg.toFixed(1)} APG</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
