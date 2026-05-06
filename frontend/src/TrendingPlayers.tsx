import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTrendingPlayers, type TrendingPlayer } from './api';
import { PlayerAvatar } from './Avatar';
import { Skeleton } from './Skeleton';

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
      <div className="trending-grid">
        {loading
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="trending-card">
                <Skeleton width={64} height={64} radius="50%" />
                <Skeleton width="70%" height={14} style={{ marginTop: 10 }} />
                <Skeleton width="40%" height={12} style={{ marginTop: 6 }} />
                <Skeleton width="80%" height={12} style={{ marginTop: 8 }} />
              </div>
            ))
          : players.map((p) => (
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
    </section>
  );
}
