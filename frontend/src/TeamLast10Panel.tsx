import { useEffect, useState } from 'react';
import { getTeamLast10, type TeamGame, type TeamLast10Response } from './api';

type Props = {
  teamId: number;
  heading?: string;
};

// Compact "team last 10 games" panel — mirrors Last10Panel for players.
// Used inside Team vs Team view so users get an unfiltered recent-form
// snapshot alongside the head-to-head comparison.
export function TeamLast10Panel({ teamId, heading = 'Last 10 games · all opponents' }: Props) {
  const [data, setData] = useState<TeamLast10Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getTeamLast10(teamId)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [teamId]);

  if (loading) return <div className="last10-panel"><h3>{heading}</h3><p className="muted">Loading…</p></div>;
  if (error)   return <div className="last10-panel"><h3>{heading}</h3><p className="error">{error}</p></div>;
  if (!data || data.gameLog.length === 0) {
    return <div className="last10-panel"><h3>{heading}</h3><p className="muted">No recent games.</p></div>;
  }

  const games = data.gameLog;
  const n = games.length;
  const wins = games.filter((g) => g.result === 'W').length;
  const avg = (pick: (g: TeamGame) => number) =>
    (games.reduce((s, g) => s + pick(g), 0) / n).toFixed(1);

  return (
    <div className="last10-panel">
      <h3>{heading}</h3>

      <div className="last10-avgs">
        <Stat label="Record" v={`${wins}-${n - wins}`} hi />
        <Stat label="PTS"    v={avg((g) => g.points)} />
        <Stat label="REB"    v={avg((g) => g.rebounds)} />
        <Stat label="AST"    v={avg((g) => g.assists)} />
        <Stat label="STL"    v={avg((g) => g.steals)} />
        <Stat label="BLK"    v={avg((g) => g.blocks)} />
        <Stat label="TO"     v={avg((g) => g.turnovers)} />
        <Stat label="FG%"    v={(games.reduce((s, g) => s + g.fgPct, 0) / n * 100).toFixed(1) + '%'} />
        <Stat label="3P%"    v={(games.reduce((s, g) => s + g.fg3Pct, 0) / n * 100).toFixed(1) + '%'} />
      </div>

      <div className="games-scroll">
        <table className="games">
          <thead>
            <tr>
              <th>Date</th>
              <th>Matchup</th>
              <th>W/L</th>
              <th>PTS</th>
              <th>REB</th>
              <th>AST</th>
              <th>STL</th>
              <th>BLK</th>
              <th>TO</th>
              <th>FG</th>
              <th>3P</th>
              <th>FT</th>
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.gameId}>
                <td>{g.date}</td>
                <td>{g.matchup}</td>
                <td className={g.result === 'W' ? 'pos' : 'neg'}>{g.result ?? '—'}</td>
                <td><strong>{g.points}</strong></td>
                <td>{g.rebounds}</td>
                <td>{g.assists}</td>
                <td>{g.steals}</td>
                <td>{g.blocks}</td>
                <td>{g.turnovers}</td>
                <td>{g.fgm}/{g.fga}</td>
                <td>{g.fg3m}/{g.fg3a}</td>
                <td>{g.ftm}/{g.fta}</td>
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
