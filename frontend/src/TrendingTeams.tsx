import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTrendingTeams, type TrendingTeam } from './api';
import { TeamLogo } from './Avatar';

// Mirror of TrendingPlayers — top scoring teams for the season. Each card
// pre-fills the Team-vs-Team flow as Team A so the user can pick an opponent.
export function TrendingTeams() {
  const [teams, setTeams] = useState<TrendingTeam[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTrendingTeams(8)
      .then(setTeams)
      .catch(() => setTeams([]))
      .finally(() => setLoading(false));
  }, []);

  if (!loading && teams.length === 0) return null;

  return (
    <section className="trending">
      <h2>Top scoring teams</h2>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="trending-grid">
          {teams.map((t) => (
            <Link
              key={t.id}
              className="trending-card"
              to={`/compare?m=tvt&ta=${t.id}`}
            >
              <TeamLogo abbr={t.abbreviation} name={t.fullName} size="lg" />
              <div className="trending-name">{t.fullName}</div>
              <div className="trending-team">{t.wins}-{t.losses}</div>
              <div className="trending-stats">
                <span><strong>{t.ppg.toFixed(1)}</strong> PPG</span>
                <span>{t.gamesPlayed} GP</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
