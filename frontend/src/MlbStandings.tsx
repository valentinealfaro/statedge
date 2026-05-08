// MLB standings page — institutional rollup per the UX spec
// ("Must show: run differential, bullpen ranking, offensive
// efficiency, pitching efficiency, home/away splits, park-adjusted
// performance — NOT basic ESPN standings").
//
// Layout: division-grouped tables with sortable column hint via
// title attributes. Hide the park-adjusted column on narrow screens
// since it's a tertiary signal.

import { useEffect, useState } from 'react';
import {
  getMlbStandings,
  type MlbStandingRow,
  type MlbStandingsResponse,
} from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

export function MlbStandings() {
  useTitle(['MLB Standings']);
  const [data, setData] = useState<MlbStandingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMlbStandings()
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>MLB · Standings</h1>
        <p className="muted small">
          Institutional team rollup — run differential, bullpen vs starter
          ERA, park-adjusted run rate, home/away splits, last-10. Pulled
          from the same data the projection engine uses; updated daily
          via the MLB sync workflow.
        </p>

        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        {!data && !error && (
          <Skeleton width="100%" height={400} style={{ marginTop: 16 }} />
        )}

        {data && data.teams.length === 0 && (
          <div className="mlb-info-banner">
            <strong>No games found in the database.</strong> Run the MLB
            sync workflow on GitHub (Actions → "Sync MLB data to Neon")
            to populate teams + games + stats. Standings populate once
            the season has started and games have been logged.
          </div>
        )}

        {data && data.daysStale !== null && data.daysStale >= 2 && (
          <div className="mlb-info-banner mlb-info-error">
            <strong>⚠ Standings are stale.</strong> Most recent game in
            our database is <strong>{data.lastGameDate}</strong> ({data.daysStale} days
            ago). Re-run the GitHub Actions workflow{' '}
            <em>"Sync MLB data to Neon"</em> to pull the missing games
            and stats — the numbers below reflect the older snapshot
            until you do.
          </div>
        )}

        {data && data.teams.length > 0 && (
          <StandingsByDivision teams={data.teams} asOf={data.asOf} lastGameDate={data.lastGameDate} />
        )}

        {data && (
          <p className="mlb-disclaimer">{data.disclaimer}</p>
        )}
      </div>
    </div>
  );
}

function StandingsByDivision({
  teams,
  asOf,
  lastGameDate,
}: {
  teams: MlbStandingRow[];
  asOf: string;
  lastGameDate: string | null;
}) {
  // Group by `${league} · ${division}`. Teams within a group are
  // already sorted by win% then run differential by the backend.
  const groups = new Map<string, MlbStandingRow[]>();
  for (const t of teams) {
    const key = `${t.league} · ${t.division ?? '—'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  return (
    <>
      <p className="muted small" style={{ marginTop: 16 }}>
        As of {asOf}
        {lastGameDate && lastGameDate !== asOf && ` · data through ${lastGameDate}`}
        {' · '}{teams.length} teams · {teams.reduce((s, t) => s + t.gamesPlayed, 0)} cumulative games
      </p>
      {[...groups.entries()].map(([label, rows]) => (
        <div key={label} className="mlb-standings-division">
          <h2 className="mlb-standings-div-label">{label}</h2>
          <div className="mlb-standings-table-wrap">
            <table className="mlb-standings-table">
              <thead>
                <tr>
                  <th title="Team">Team</th>
                  <th title="Wins-Losses" className="num">W-L</th>
                  <th title="Win percentage" className="num">PCT</th>
                  <th title="Games played" className="num">GP</th>
                  <th title="Run differential (runs scored - runs allowed)" className="num">DIFF</th>
                  <th title="Runs scored per game" className="num">R/G</th>
                  <th title="Runs allowed per game" className="num">RA/G</th>
                  <th title="Earned-run average for starting pitchers" className="num">SP ERA</th>
                  <th title="Earned-run average for relievers" className="num">BP ERA</th>
                  <th title="Park-adjusted runs scored per home game" className="num adv-only">PARK ADJ</th>
                  <th title="Home record">HOME</th>
                  <th title="Away record">AWAY</th>
                  <th title="Record over the last 10 games" className="num">L10</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.teamId}>
                    <td className="team-cell">
                      <strong>{t.abbreviation}</strong>
                      <span className="muted small"> {t.fullName}</span>
                    </td>
                    <td className="num">{t.wins}-{t.losses}</td>
                    <td className="num">{t.winPct.toFixed(3)}</td>
                    <td className="num">{t.gamesPlayed}</td>
                    <td className={`num ${t.runDifferential >= 0 ? 'pos' : 'neg'}`}>
                      {t.runDifferential >= 0 ? '+' : ''}{t.runDifferential}
                    </td>
                    <td className="num">{t.runsScoredPerGame.toFixed(2)}</td>
                    <td className="num">{t.runsAllowedPerGame.toFixed(2)}</td>
                    <td className="num">{t.starterEra !== null ? t.starterEra.toFixed(2) : '—'}</td>
                    <td className="num">{t.bullpenEra !== null ? t.bullpenEra.toFixed(2) : '—'}</td>
                    <td className="num adv-only">
                      {t.parkAdjustedRunRate !== null ? t.parkAdjustedRunRate.toFixed(2) : '—'}
                    </td>
                    <td>{t.homeRecord.wins}-{t.homeRecord.losses}</td>
                    <td>{t.awayRecord.wins}-{t.awayRecord.losses}</td>
                    <td className="num">{t.last10.wins}-{t.last10.losses}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}
