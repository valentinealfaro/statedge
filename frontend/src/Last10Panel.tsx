import { useEffect, useState } from 'react';
import {
  getPlayerLast10,
  type Last10Response,
  type PlayerGame,
} from './api';
import { MatchupCell } from './MatchupCell';
import { Skeleton } from './Skeleton';

type Props = {
  playerId: number;
  // Optional heading override — different parents want different framing
  // ("Last 10 Games" inside PvT, "Player A: last 10" inside PvP, etc.)
  heading?: string;
};

// Compact "last 10 games, all opponents, all stats" panel. Used as a
// section inside other comparison views (PvT, PvP, etc.) so users always
// have an unfiltered recent-form snapshot alongside whatever filter the
// surrounding view applies.
//
// Different from the full Last10View tab: no chip menu, no per-stat chart —
// just averages across the major counting stats and a full game-log table.
export function Last10Panel({ playerId, heading = 'Last 10 games · all opponents' }: Props) {
  const [data, setData] = useState<Last10Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    // We pick `points` purely to satisfy the endpoint contract — the response
    // includes the full PlayerGame[] regardless, and we compute averages for
    // every stat client-side from the raw game rows.
    getPlayerLast10(playerId, 'points')
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [playerId]);

  if (loading) return <Last10Skeleton heading={heading} avgCols={9} tableCols={14} />;
  if (error)   return <div className="last10-panel"><h3>{heading}</h3><p className="error">{error}</p></div>;
  if (!data || data.gameLog.length === 0) {
    return <div className="last10-panel"><h3>{heading}</h3><p className="muted">No recent games.</p></div>;
  }

  const games = data.gameLog;
  const n = games.length;
  const avg = (pick: (g: PlayerGame) => number) =>
    (games.reduce((s, g) => s + pick(g), 0) / n).toFixed(1);

  return (
    <div className="last10-panel">
      <h3>{heading}</h3>

      <div className="last10-avgs">
        <Stat label="MIN" v={avg((g) => g.minutes)} />
        <Stat label="PTS" v={avg((g) => g.points)} hi />
        <Stat label="REB" v={avg((g) => g.rebounds)} />
        <Stat label="AST" v={avg((g) => g.assists)} />
        <Stat label="STL" v={avg((g) => g.steals)} />
        <Stat label="BLK" v={avg((g) => g.blocks)} />
        <Stat label="TO"  v={avg((g) => g.turnovers)} />
        <Stat label="3PM" v={avg((g) => g.fg3m ?? 0)} />
        <Stat label="FG%" v={(games.reduce((s, g) => s + g.fgPct, 0) / n * 100).toFixed(1) + '%'} />
      </div>

      <div className="games-scroll">
        <table className="games">
          <thead>
            <tr>
              <th>Date</th>
              <th>Matchup</th>
              <th>W/L</th>
              <th>MIN</th>
              <th>PTS</th>
              <th>REB</th>
              <th>AST</th>
              <th>STL</th>
              <th>BLK</th>
              <th>TO</th>
              <th>FG</th>
              <th>3P</th>
              <th>FT</th>
              <th>PF</th>
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.gameId}>
                <td>{g.date}</td>
                <td><MatchupCell opponentAbbr={g.opponentAbbr} isHome={g.isHome} /></td>
                <td className={g.result === 'W' ? 'pos' : 'neg'}>{g.result ?? '—'}</td>
                <td>{g.minutes}</td>
                <td><strong>{g.points}</strong></td>
                <td>{g.rebounds}</td>
                <td>{g.assists}</td>
                <td>{g.steals}</td>
                <td>{g.blocks}</td>
                <td>{g.turnovers}</td>
                <td>{g.fgm ?? '—'}/{g.fga ?? '—'}</td>
                <td>{g.fg3m ?? '—'}/{g.fg3a ?? '—'}</td>
                <td>{g.ftm ?? '—'}/{g.fta ?? '—'}</td>
                <td>{g.pf ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, v, hi }: { label: string; v: string; hi?: boolean }) {
  return (
    <div className={hi ? 'last10-avg hi' : 'last10-avg'}>
      <div className="last10-avg-k">{label}</div>
      <div className="last10-avg-v">{v}</div>
    </div>
  );
}

// Reused for both player and team last-10 panels — same shape, configurable
// column count to match the parent's stat layout.
export function Last10Skeleton({ heading, avgCols, tableCols }: {
  heading: string;
  avgCols: number;
  tableCols: number;
}) {
  return (
    <div className="last10-panel">
      <h3>{heading}</h3>
      <div className="last10-avgs">
        {Array.from({ length: avgCols }).map((_, i) => (
          <div key={i} className="last10-avg">
            <Skeleton width="50%" height={10} />
            <Skeleton width="80%" height={18} style={{ marginTop: 6 }} />
          </div>
        ))}
      </div>
      <div className="games-scroll">
        <table className="games"><tbody>
          {Array.from({ length: 10 }).map((_, r) => (
            <tr key={r}>
              {Array.from({ length: tableCols }).map((_, c) => (
                <td key={c}><Skeleton height={12} /></td>
              ))}
            </tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}
