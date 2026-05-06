import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getRecentGames, type RecentGame } from './api';
import { TeamLogo } from './Avatar';
import { Skeleton } from './Skeleton';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// "Last games around the league" — uses the same JSONB cache that drives
// every comparison, so it stays in sync with whatever the nightly sync
// pulled. Each card links to TvT for that pair, so a user can open the
// matchup and start comparing in one click.
export function RecentGames() {
  const [games, setGames] = useState<RecentGame[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getRecentGames(6)
      .then(setGames)
      .catch(() => setGames([]))
      .finally(() => setLoading(false));
  }, []);

  if (!loading && games.length === 0) return null;

  return (
    <section className="trending">
      <h2>Last around the league</h2>
      <div className="recent-games-grid">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="recent-game">
                <Skeleton width="40%" height={11} />
                <div className="recent-game-row">
                  <Skeleton width={32} height={32} radius="50%" />
                  <Skeleton width="60%" height={14} />
                  <Skeleton width={28} height={18} />
                </div>
                <div className="recent-game-row">
                  <Skeleton width={32} height={32} radius="50%" />
                  <Skeleton width="60%" height={14} />
                  <Skeleton width={28} height={18} />
                </div>
              </div>
            ))
          : games.map((g) => {
              const awayWon = g.away.result === 'W';
              const homeWon = g.home.result === 'W';
              return (
                <Link
                  key={g.gameId}
                  className="recent-game"
                  to={`/game/${g.gameId}`}
                  title="View boxscore"
                >
                  <div className="recent-game-date">{fmtDate(g.date)}</div>
                  <Side side={g.away} won={awayWon} />
                  <Side side={g.home} won={homeWon} />
                </Link>
              );
            })}
      </div>
    </section>
  );
}

function Side({
  side,
  won,
}: {
  side: { teamId: number; abbreviation: string; fullName: string; points: number };
  won: boolean;
}) {
  return (
    <div className={won ? 'recent-game-row won' : 'recent-game-row'}>
      <TeamLogo abbr={side.abbreviation} name={side.fullName} size="md" />
      <span className="recent-game-name">{side.fullName}</span>
      <span className="recent-game-pts">{side.points}</span>
    </div>
  );
}
