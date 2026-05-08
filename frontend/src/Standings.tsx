// NBA standings page — institutional rollup. Mirrors the MLB
// standings layout (mlb-compare-shell + h1 + intro + mlb-info-banner
// + mlb-standings-table) so the two sports read identically.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getStandings, type StandingRow } from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

export function Standings() {
  useTitle(['NBA Standings']);
  const [data, setData] = useState<{ east: StandingRow[]; west: StandingRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStandings()
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, []);

  const totalTeams = (data?.east.length ?? 0) + (data?.west.length ?? 0);
  const totalGames =
    [...(data?.east ?? []), ...(data?.west ?? [])]
      .reduce((s, t) => s + t.wins + t.losses, 0);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>NBA · Standings</h1>
        <p className="muted small">
          Conference rollup — wins, losses, win percentage, last-10 form,
          points per game. Pulled from the same data the projection engine
          uses; updated daily via the NBA sync workflow.
        </p>

        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        {!data && !error && (
          <Skeleton width="100%" height={400} style={{ marginTop: 16 }} />
        )}

        {data && totalTeams === 0 && (
          <div className="mlb-info-banner">
            <strong>No standings data yet.</strong> Run the NBA sync workflow
            to populate teams + games. Standings populate once the season
            has started and games have been logged.
          </div>
        )}

        {data && totalTeams > 0 && (
          <>
            <p className="muted small" style={{ marginTop: 16 }}>
              {totalTeams} teams · {totalGames} cumulative game-results
            </p>
            <ConferenceTable label="Eastern Conference" rows={data.east} />
            <ConferenceTable label="Western Conference" rows={data.west} />
          </>
        )}
      </div>
    </div>
  );
}

function ConferenceTable({ label, rows }: { label: string; rows: StandingRow[] }) {
  return (
    <div className="mlb-standings-division">
      <h2 className="mlb-standings-div-label">{label}</h2>
      <div className="mlb-standings-table-wrap">
        <table className="mlb-standings-table">
          <thead>
            <tr>
              <th title="Rank in conference" className="num">#</th>
              <th title="Team">Team</th>
              <th title="Wins-Losses" className="num">W-L</th>
              <th title="Win percentage" className="num">PCT</th>
              <th title="Games played" className="num">GP</th>
              <th title="Points per game" className="num">PPG</th>
              <th title="Record over the last 10 games" className="num">L10</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const gp = r.wins + r.losses;
              const l10 = `${r.l10Wins}-${r.l10Losses}`;
              const hot = r.l10Wins >= 7;
              const cold = r.l10Losses >= 7;
              return (
                <tr key={r.teamId}>
                  <td className="num">{i + 1}</td>
                  <td className="team-cell">
                    <Link
                      to={`/compare?m=tvt&ta=${r.teamId}`}
                      style={{ color: 'inherit', textDecoration: 'none' }}
                    >
                      <strong>{r.abbreviation}</strong>
                      <span className="muted small"> {r.fullName}</span>
                    </Link>
                  </td>
                  <td className="num">{r.wins}-{r.losses}</td>
                  <td className="num">{r.winPct.toFixed(3)}</td>
                  <td className="num">{gp}</td>
                  <td className="num">{r.ppg.toFixed(1)}</td>
                  <td className={`num ${hot ? 'pos' : cold ? 'neg' : ''}`}>{l10}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
