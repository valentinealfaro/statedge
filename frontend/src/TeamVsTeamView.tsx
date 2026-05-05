import { useEffect, useState } from 'react';
import { compareTeamVsTeam, type Team, type TeamStatKey, type TvtResponse } from './api';
import { AiSummary } from './AiSummary';

type Props = { a: Team; b: Team };
type Range = 'last5' | 'last10' | 'last20' | 'season';

const LABELS: Record<TeamStatKey, string> = {
  points: 'Points',
  rebounds: 'Rebounds',
  assists: 'Assists',
  fgPct: 'FG%',
  fg3Pct: '3PT%',
  turnovers: 'Turnovers',
};

const KEYS: TeamStatKey[] = ['points', 'rebounds', 'assists', 'fgPct', 'fg3Pct', 'turnovers'];

function fmt(k: TeamStatKey, v: number): string {
  if (k === 'fgPct' || k === 'fg3Pct') return `${(v * 100).toFixed(1)}%`;
  return String(v);
}

export function TeamVsTeamView({ a, b }: Props) {
  const [range, setRange] = useState<Range>('last10');
  const [data, setData] = useState<TvtResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    compareTeamVsTeam(a.id, b.id, range)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [a.id, b.id, range]);

  return (
    <div className="comparison">
      <div className="matchup">
        <div className="side">
          <div className="big">{a.fullName}</div>
          <div className="small">{a.abbreviation}</div>
        </div>
        <div className="vs">vs</div>
        <div className="side">
          <div className="big">{b.fullName}</div>
          <div className="small">{b.abbreviation}</div>
        </div>
      </div>

      <div className="range-tabs">
        {(['last5', 'last10', 'last20', 'season'] as Range[]).map((r) => (
          <button key={r} className={r === range ? 'tab active' : 'tab'} onClick={() => setRange(r)}>
            {r === 'season' ? 'Season' : `Last ${r.replace('last', '')}`}
          </button>
        ))}
      </div>

      {loading && <p className="muted">Loading comparison…</p>}
      {error && <p className="error">{error}</p>}

      {data && (
        <>
          <table className="vs-table">
            <thead>
              <tr>
                <th>{a.abbreviation}</th>
                <th />
                <th>{b.abbreviation}</th>
              </tr>
            </thead>
            <tbody>
              {KEYS.map((k) => {
                const av = data.report.a.summaries[k].avg;
                const bv = data.report.b.summaries[k].avg;
                // For turnovers, lower is better.
                const lowerIsBetter = k === 'turnovers';
                const winner = av === bv ? null
                  : lowerIsBetter ? (av < bv ? 'a' : 'b')
                  : (av > bv ? 'a' : 'b');
                return (
                  <tr key={k}>
                    <td className={winner === 'a' ? 'pos' : ''}>{fmt(k, av)}</td>
                    <td className="label">{LABELS[k]}</td>
                    <td className={winner === 'b' ? 'pos' : ''}>{fmt(k, bv)}</td>
                  </tr>
                );
              })}
              <tr>
                <td>{data.report.a.sampleSize}</td>
                <td className="label">Games</td>
                <td>{data.report.b.sampleSize}</td>
              </tr>
            </tbody>
          </table>

          <AiSummary
            payload={{
              type: 'team_vs_team',
              a: { id: a.id, name: a.fullName, abbr: a.abbreviation, summaries: data.report.a },
              b: { id: b.id, name: b.fullName, abbr: b.abbreviation, summaries: data.report.b },
              delta: data.report.delta,
              range,
            }}
          />
        </>
      )}
    </div>
  );
}
