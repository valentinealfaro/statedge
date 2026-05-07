// Tonight's NBA games rail. Self-contained — fetches its own data
// from /api/games/today and renders nothing until games arrive.
// Lifted out of SlateManualEntry so it can sit at the top of the
// /slate page (orienting context users want before scanning the
// pre-built parlays below).
//
// Informational only — no click handlers. Just shows what's
// happening tonight so the user can ground the slate's player
// picks in actual game context.

import { useEffect, useState } from 'react';
import { TeamLogo } from './Avatar';
import { getTodayGames, type EspnScoreboardGame } from './api';

export function TonightsGames() {
  const [games, setGames] = useState<EspnScoreboardGame[]>([]);

  useEffect(() => {
    let alive = true;
    getTodayGames()
      .then((d) => { if (alive) setGames(d.games); })
      .catch(() => { if (alive) setGames([]); });
    return () => { alive = false; };
  }, []);

  if (games.length === 0) return null;

  return (
    <div className="today-rail informational">
      <div className="today-rail-head">
        <span className="recents-title">Tonight's games</span>
      </div>
      <div className="today-rail-list">
        {games.map((g) => (
          <div key={g.id} className="today-game">
            <div className="today-game-status">{g.status.detail}</div>
            <div className="today-side static">
              <TeamLogo abbr={g.away.abbreviation} name={g.away.displayName} size="md" />
              <span className="today-side-abbr">{g.away.abbreviation}</span>
              {g.away.record && <span className="muted small">{g.away.record}</span>}
            </div>
            <span className="today-at">@</span>
            <div className="today-side static">
              <TeamLogo abbr={g.home.abbreviation} name={g.home.displayName} size="md" />
              <span className="today-side-abbr">{g.home.abbreviation}</span>
              {g.home.record && <span className="muted small">{g.home.record}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
