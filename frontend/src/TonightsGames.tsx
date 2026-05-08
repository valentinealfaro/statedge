// Tonight's NBA games rail. Self-contained — fetches its own data
// from /api/games/today and renders nothing until games arrive.
// Lifted out of SlateManualEntry so it can sit at the top of the
// /slate page (orienting context users want before scanning the
// pre-built parlays below).
//
// Each card navigates to /espn-game/:eventId on click. Auto-refreshes
// every 60s while any game is in progress so live scores stay fresh
// without forcing a page reload.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TeamLogo } from './Avatar';
import { getTodayGames, type EspnScoreboardGame } from './api';

export function TonightsGames() {
  const [games, setGames] = useState<EspnScoreboardGame[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    getTodayGames()
      .then((d) => { if (alive) setGames(d.games); })
      .catch(() => { if (alive) setGames([]); });
    return () => { alive = false; };
  }, [tick]);

  // Auto-refresh while any game is live. 60s cadence — fast enough to
  // keep scores feeling current, slow enough to not hammer ESPN.
  useEffect(() => {
    const anyLive = games.some((g) => g.status.state === 'in');
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, anyLive ? 60_000 : 120_000);
    return () => window.clearInterval(interval);
  }, [games]);

  if (games.length === 0) return null;
  const anyLive = games.some((g) => g.status.state === 'in');

  return (
    <div className="today-rail">
      <div className="today-rail-head">
        <span className="recents-title">
          Tonight's games
          {anyLive && (
            <span style={{ marginLeft: 10, color: '#ef5350', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em' }}>
              ● LIVE
            </span>
          )}
        </span>
        {anyLive && <span className="muted small">auto-refresh 60s</span>}
      </div>
      <div className="today-rail-list">
        {games.map((g) => {
          const isLive = g.status.state === 'in';
          const isFinal = g.status.state === 'post';
          return (
            <Link
              key={g.id}
              to={`/espn-game/${g.id}`}
              className={`today-game ${isLive ? 'live' : ''} ${isFinal ? 'final' : ''}`}
              style={{ textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}
              title={`Open ${g.away.abbreviation} @ ${g.home.abbreviation} matchup`}
            >
              <div
                className="today-game-status"
                style={isLive ? { color: '#ef5350', fontWeight: 700 } : isFinal ? { opacity: 0.7 } : {}}
              >
                {isLive && '● '}{g.status.detail}
              </div>
              <div className="today-side static">
                <TeamLogo abbr={g.away.abbreviation} name={g.away.displayName} size="md" />
                <span className="today-side-abbr">{g.away.abbreviation}</span>
                {g.away.score && (isLive || isFinal) && (
                  <strong style={{ marginLeft: 4 }}>{g.away.score}</strong>
                )}
                {g.away.record && !isLive && !isFinal && <span className="muted small">{g.away.record}</span>}
              </div>
              <span className="today-at">@</span>
              <div className="today-side static">
                <TeamLogo abbr={g.home.abbreviation} name={g.home.displayName} size="md" />
                <span className="today-side-abbr">{g.home.abbreviation}</span>
                {g.home.score && (isLive || isFinal) && (
                  <strong style={{ marginLeft: 4 }}>{g.home.score}</strong>
                )}
                {g.home.record && !isLive && !isFinal && <span className="muted small">{g.home.record}</span>}
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
        })}
      </div>
    </div>
  );
}
