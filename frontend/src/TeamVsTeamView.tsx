import { useEffect, useState } from 'react';
import {
  compareTeamVsTeam,
  type SeasonRange,
  type Team,
  type TeamStatKey,
  type TvtResponse,
} from './api';
import { AiSummary } from './AiSummary';
import { TeamLogo } from './Avatar';
import { SaveButton } from './SaveButton';
import { SeasonTabs } from './SeasonTabs';
import { usePlan } from './plan';
import { recordRecent } from './recents';

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
  const { plan, recordComparison } = usePlan();
  const [range, setRange] = useState<Range>(plan === 'free' ? 'last5' : 'last10');
  const [seasons, setSeasons] = useState<SeasonRange>('current');
  const [data, setData] = useState<TvtResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan === 'free') recordComparison();
    recordRecent({ type: 'tvt', a, b });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id, b.id]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    compareTeamVsTeam(a.id, b.id, range, seasons)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [a.id, b.id, range, seasons]);

  return (
    <div className="comparison">
      <div className="matchup">
        <div className="side">
          <TeamLogo abbr={a.abbreviation} name={a.fullName} size="lg" />
          <div className="big">{a.fullName}</div>
          <div className="small">{a.abbreviation}</div>
        </div>
        <div className="vs">vs</div>
        <div className="side">
          <TeamLogo abbr={b.abbreviation} name={b.fullName} size="lg" />
          <div className="big">{b.fullName}</div>
          <div className="small">{b.abbreviation}</div>
        </div>
      </div>

      <div className="actions-row">
        <SaveButton draft={{ type: 'tvt', a, b }} />
      </div>

      <SeasonTabs value={seasons} onChange={setSeasons} />

      <div className="range-tabs">
        {(['last5', 'last10', 'last20', 'season'] as Range[]).map((r) => (
          <button key={r} className={r === range ? 'tab active' : 'tab'} onClick={() => setRange(r)}>
            {r === 'season' ? 'All' : `Last ${r.replace('last', '')}`}
          </button>
        ))}
      </div>

      {data && (
        <p className="muted sample">
          Sample size: {a.abbreviation} {data.report.a.sampleSize} / {b.abbreviation}{' '}
          {data.report.b.sampleSize} games across {data.seasons.length} season
          {data.seasons.length === 1 ? '' : 's'} ({data.seasons.join(', ')}).
        </p>
      )}

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
