// WNBA standings page — Phase 74. Mirrors the MLB / NBA standings
// visual language exactly (mlb-compare-shell + h1 + intro +
// mlb-info-banner + mlb-standings-table) so the platform reads as
// one institutional engine across leagues.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { WnbaTeamLogo } from './Avatar';
import { getWnbaStandings, type WnbaStandingRow, type WnbaStandingsResponse } from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

export function WnbaStandings() {
  useTitle(['WNBA Standings']);
  const [data, setData] = useState<WnbaStandingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getWnbaStandings()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>WNBA · Standings</h1>
        <p className="muted small">
          Conference rollup with point differential, home/away splits,
          last-10 form, and current streak. Pulled live from ESPN's WNBA
          standings feed; cached 5 min.
        </p>

        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        {!data && !error && (
          <Skeleton width="100%" height={400} style={{ marginTop: 16 }} />
        )}

        {data && data.total === 0 && (
          <div className="mlb-info-banner">
            <strong>No WNBA standings data yet.</strong> ESPN didn't return
            any teams — the season may not have started yet, or the
            upstream is briefly unavailable. Try again in a minute.
          </div>
        )}

        {data && data.total > 0 && (
          <>
            <p className="muted small" style={{ marginTop: 16 }}>
              {data.total} teams · sorted by win % within conference
            </p>
            <ConferenceTable label="Eastern Conference" rows={data.eastern} />
            <ConferenceTable label="Western Conference" rows={data.western} />
          </>
        )}

        {data && (
          <p className="mlb-disclaimer">{data.disclaimer}</p>
        )}
      </div>
    </div>
  );
}

function ConferenceTable({ label, rows }: { label: string; rows: WnbaStandingRow[] }) {
  if (rows.length === 0) return null;
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
              <th title="Games back from conference leader" className="num">GB</th>
              <th title="Average point differential per game" className="num">DIFF</th>
              <th title="Points scored per game" className="num">PPG</th>
              <th title="Points allowed per game" className="num">OPP</th>
              <th title="Home record">HOME</th>
              <th title="Away record">AWAY</th>
              <th title="Record over the last 10 games" className="num">L10</th>
              <th title="Current win/loss streak">STK</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const l10 = `${r.l10Wins}-${r.l10Losses}`;
              const hot = r.l10Wins >= 7;
              const cold = r.l10Losses >= 7;
              const streakHot = r.streak.startsWith('W') && Number(r.streak.slice(1)) >= 3;
              const streakCold = r.streak.startsWith('L') && Number(r.streak.slice(1)) >= 3;
              return (
                <tr key={r.teamId}>
                  <td className="num">{i + 1}</td>
                  <td className="team-cell">
                    <Link
                      to={`/wnba/standings`}
                      style={{ color: 'inherit', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}
                      title={r.displayName}
                    >
                      <WnbaTeamLogo abbr={r.abbreviation} name={r.displayName} size="md" />
                      <strong>{r.abbreviation}</strong>
                      <span className="muted small">{r.displayName}</span>
                    </Link>
                  </td>
                  <td className="num">{r.wins}-{r.losses}</td>
                  <td className="num">{r.winPct.toFixed(3)}</td>
                  <td className="num">{r.gamesBack === 0 ? '—' : r.gamesBack.toFixed(1)}</td>
                  <td className={`num ${r.pointDiff >= 0 ? 'pos' : 'neg'}`}>
                    {r.pointDiff >= 0 ? '+' : ''}{r.pointDiff.toFixed(1)}
                  </td>
                  <td className="num">{r.ppg.toFixed(1)}</td>
                  <td className="num">{r.oppPpg.toFixed(1)}</td>
                  <td>{r.homeRecord}</td>
                  <td>{r.awayRecord}</td>
                  <td className={`num ${hot ? 'pos' : cold ? 'neg' : ''}`}>{l10}</td>
                  <td className={streakHot ? 'pos' : streakCold ? 'neg' : ''}>
                    {r.streak || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
