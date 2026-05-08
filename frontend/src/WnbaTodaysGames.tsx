// WNBA tonight's games rail. Same UX contract as MLB's
// MlbTodaysGames + NBA's TonightsGames — clickable cards with team
// logos, records, scores, status; auto-refresh every 60s while any
// game is live.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { WnbaTeamLogo } from './Avatar';
import { getWnbaToday, type WnbaScoreboardGame, type WnbaTodayResponse } from './api';

export function WnbaTodaysGames() {
  const [data, setData] = useState<WnbaTodayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    getWnbaToday()
      .then((d) => { if (alive) setData(d); })
      .catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [tick]);

  useEffect(() => {
    const anyLive = data?.games.some((g) => g.status.state === 'in') ?? false;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, anyLive ? 60_000 : 120_000);
    return () => window.clearInterval(interval);
  }, [data]);

  if (error) return null;
  if (!data || data.games.length === 0) return null;
  const anyLive = data.games.some((g) => g.status.state === 'in');

  return (
    <section className="today-rail">
      <div className="today-rail-head">
        <span className="recents-title">
          Today's WNBA games
          {anyLive && (
            <span style={{ marginLeft: 10, color: '#ef5350', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em' }}>
              ● LIVE
            </span>
          )}
        </span>
        <span className="muted small">
          {data.games.length} game{data.games.length === 1 ? '' : 's'}
          {anyLive && <> · auto-refresh 60s</>}
        </span>
      </div>
      <div className="today-rail-list">
        {data.games.map((g) => <GameCard key={g.id} game={g} />)}
      </div>
    </section>
  );
}

function GameCard({ game }: { game: WnbaScoreboardGame }) {
  const isLive = game.status.state === 'in';
  const isFinal = game.status.state === 'post';
  const isPregame = game.status.state === 'pre';

  return (
    <Link
      to={`/wnba/game/${game.id}`}
      className={`today-game ${isLive ? 'live' : ''} ${isFinal ? 'final' : ''}`}
      style={{ textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}
      title={`Open ${game.away.abbreviation} @ ${game.home.abbreviation} matchup`}
    >
      <div
        className="today-game-status"
        style={isLive ? { color: '#ef5350', fontWeight: 700 } : isFinal ? { opacity: 0.7 } : {}}
      >
        {isLive && '● '}{game.status.detail}
      </div>
      <div className="today-side static">
        <WnbaTeamLogo abbr={game.away.abbreviation} name={game.away.displayName} size="md" />
        <span className="today-side-abbr">{game.away.abbreviation}</span>
        {game.away.score && (isLive || isFinal) && (
          <strong style={{ marginLeft: 4 }}>{game.away.score}</strong>
        )}
        {game.away.record && isPregame && <span className="muted small">{game.away.record}</span>}
      </div>
      <span className="today-at">@</span>
      <div className="today-side static">
        <WnbaTeamLogo abbr={game.home.abbreviation} name={game.home.displayName} size="md" />
        <span className="today-side-abbr">{game.home.abbreviation}</span>
        {game.home.score && (isLive || isFinal) && (
          <strong style={{ marginLeft: 4 }}>{game.home.score}</strong>
        )}
        {game.home.record && isPregame && <span className="muted small">{game.home.record}</span>}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 10,
          color: '#7aa2ff',
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        View matchup →
      </div>
    </Link>
  );
}
