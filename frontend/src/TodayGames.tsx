import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTodayGames, type EspnScoreboardGame } from './api';
import { TeamLogo } from './Avatar';
import { Skeleton } from './Skeleton';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtESPNDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Today's NBA slate from ESPN. Pre-game cards show tipoff time + each team's
// season record; in-progress and final cards show live/final scores.
// Click → /espn-game/:eventId for starters / injuries / leaders / boxscore.
export function TodayGames() {
  const [data, setData] = useState<{ date: string | null; games: EspnScoreboardGame[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const refetch = () => {
      getTodayGames()
        .then((d) => { if (alive) setData(d); })
        .catch(() => { if (alive) setData({ date: null, games: [] }); })
        .finally(() => { if (alive) setLoading(false); });
    };
    refetch();
    // Refetch when the tab returns to foreground (catches "tipoff hit
    // while I was on a different tab").
    const onVisible = () => { if (document.visibilityState === 'visible') refetch(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  if (!loading && (!data || data.games.length === 0)) return null;

  const dateLabel = fmtESPNDate(data?.date ?? null);

  return (
    <section className="trending">
      <h2>
        Today's games
        {dateLabel && <span className="performers-date"> · {dateLabel}</span>}
      </h2>
      <div className="recent-games-grid">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
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
          : data!.games.map((g) => {
              const isPre = g.status.state === 'pre';
              const awayWon = g.status.completed && Number(g.away.score) > Number(g.home.score);
              const homeWon = g.status.completed && Number(g.home.score) > Number(g.away.score);
              return (
                <Link
                  key={g.id}
                  className="recent-game"
                  to={`/espn-game/${g.id}`}
                  title="View game details"
                >
                  <div className="recent-game-date">
                    {g.status.state === 'in' && <span className="live-pill">LIVE</span>}
                    {g.status.detail}
                  </div>
                  <Side team={g.away} won={awayWon} preGame={isPre} />
                  <Side team={g.home} won={homeWon} preGame={isPre} />
                </Link>
              );
            })}
      </div>
    </section>
  );
}

function Side({
  team,
  won,
  preGame,
}: {
  team: EspnScoreboardGame['away'];
  won: boolean;
  preGame: boolean;
}) {
  return (
    <div className={won ? 'recent-game-row won' : 'recent-game-row'}>
      <TeamLogo abbr={team.abbreviation} name={team.displayName} size="md" />
      <span className="recent-game-name">
        {team.displayName}
        {team.record && <span className="muted small"> · {team.record}</span>}
      </span>
      <span className="recent-game-pts">
        {preGame ? '—' : team.score}
      </span>
    </div>
  );
}
