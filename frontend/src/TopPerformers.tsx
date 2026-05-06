import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTopPerformers, type TopPerformer } from './api';
import { PlayerAvatar, TeamLogo } from './Avatar';
import { Skeleton } from './Skeleton';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Top scorers from the most recent game day in cache. Pulls from
// player_game_logs directly so it stays current with the nightly
// sync without needing per-game popularity data.
export function TopPerformers() {
  const [performers, setPerformers] = useState<TopPerformer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTopPerformers(6)
      .then(setPerformers)
      .catch(() => setPerformers([]))
      .finally(() => setLoading(false));
  }, []);

  if (!loading && performers.length === 0) return null;
  const date = performers[0]?.date;

  return (
    <section className="trending">
      <h2>
        Top performers
        {date && <span className="performers-date"> · {fmtDate(date)}</span>}
      </h2>
      <div className="performers-grid">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="performer-card">
                <Skeleton width={56} height={56} radius="50%" />
                <div style={{ flex: 1 }}>
                  <Skeleton width="70%" height={14} />
                  <Skeleton width="40%" height={11} style={{ marginTop: 6 }} />
                  <Skeleton width="80%" height={12} style={{ marginTop: 8 }} />
                </div>
              </div>
            ))
          : performers.map((p) => (
              <Link
                key={p.playerId}
                className="performer-card"
                to={`/compare?m=last10&pid=${p.playerId}`}
                title="See last 10 games"
              >
                <PlayerAvatar playerId={p.playerId} name={p.fullName} size="lg" />
                <div className="performer-body">
                  <div className="performer-name">{p.fullName}</div>
                  <div className="performer-meta">
                    {p.teamAbbreviation && (
                      <TeamLogo abbr={p.teamAbbreviation} name={p.teamAbbreviation} size="md" />
                    )}
                    <span>
                      {p.teamAbbreviation ?? '—'} {p.isHome ? 'vs' : '@'}{' '}
                      <strong>{p.opponentAbbr}</strong>
                      {p.result && (
                        <span className={p.result === 'W' ? 'pos' : 'neg'}> · {p.result}</span>
                      )}
                    </span>
                  </div>
                  <div className="performer-stats">
                    <span><strong>{p.points}</strong> PTS</span>
                    <span>{p.rebounds} REB</span>
                    <span>{p.assists} AST</span>
                    {p.blocks > 0 && <span>{p.blocks} BLK</span>}
                    {p.steals > 0 && <span>{p.steals} STL</span>}
                  </div>
                </div>
              </Link>
            ))}
      </div>
    </section>
  );
}
