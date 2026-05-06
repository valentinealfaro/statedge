import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getStandings, type StandingRow } from './api';
import { TeamLogo } from './Avatar';
import { FreshnessBanner } from './FreshnessBanner';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

export function Standings() {
  const [data, setData] = useState<{ east: StandingRow[]; west: StandingRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useTitle(['Standings']);

  useEffect(() => {
    getStandings()
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div className="app">
      <NavBar />
      <p className="tag">Conference standings · season record</p>
      <FreshnessBanner />

      {error && <p className="error">{error}</p>}

      <div className="standings-grid">
        <ConferenceColumn title="Eastern Conference" rows={data?.east ?? null} />
        <ConferenceColumn title="Western Conference" rows={data?.west ?? null} />
      </div>

      <p className="muted small" style={{ textAlign: 'center', marginTop: 24 }}>
        Sorted by win percentage. Records reflect everything the sync has cached
        (regular season + any current playoffs).
      </p>
    </div>
  );
}

function ConferenceColumn({ title, rows }: { title: string; rows: StandingRow[] | null }) {
  return (
    <div className="standings-col">
      <h2>{title}</h2>
      <table className="standings-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Team</th>
            <th>W</th>
            <th>L</th>
            <th>PCT</th>
            <th>PPG</th>
          </tr>
        </thead>
        <tbody>
          {rows
            ? rows.map((r, i) => (
                <tr key={r.teamId}>
                  <td className="standings-rank">{i + 1}</td>
                  <td>
                    <Link
                      className="standings-team"
                      to={`/compare?m=tvt&ta=${r.teamId}`}
                    >
                      <TeamLogo abbr={r.abbreviation} name={r.fullName} size="md" />
                      <span>{r.fullName}</span>
                    </Link>
                  </td>
                  <td>{r.wins}</td>
                  <td>{r.losses}</td>
                  <td>{r.winPct.toFixed(3).replace(/^0/, '')}</td>
                  <td>{r.ppg.toFixed(1)}</td>
                </tr>
              ))
            : Array.from({ length: 15 }).map((_, i) => (
                <tr key={i}>
                  <td><Skeleton width={16} height={11} /></td>
                  <td><Skeleton width="80%" height={14} /></td>
                  <td><Skeleton width={20} height={11} /></td>
                  <td><Skeleton width={20} height={11} /></td>
                  <td><Skeleton width={32} height={11} /></td>
                  <td><Skeleton width={32} height={11} /></td>
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
