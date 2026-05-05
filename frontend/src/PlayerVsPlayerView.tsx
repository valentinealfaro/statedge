import { useEffect, useState } from 'react';
import {
  comparePlayerVsPlayer,
  type Player,
  type PvpResponse,
  type StatKey,
} from './api';
import { AiSummary } from './AiSummary';

type Props = { a: Player; b: Player };
type Range = 'last5' | 'last10' | 'last20' | 'season';

const STAT_LABELS: Record<StatKey, string> = {
  points: 'Points',
  rebounds: 'Rebounds',
  assists: 'Assists',
  minutes: 'Minutes',
  fgPct: 'FG%',
  fg3Pct: '3PT%',
};

const KEYS: StatKey[] = ['points', 'rebounds', 'assists', 'minutes', 'fgPct', 'fg3Pct'];

function fmt(k: StatKey, v: number): string {
  if (k === 'fgPct' || k === 'fg3Pct') return `${(v * 100).toFixed(1)}%`;
  return String(v);
}

export function PlayerVsPlayerView({ a, b }: Props) {
  const [range, setRange] = useState<Range>('last10');
  const [data, setData] = useState<PvpResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    comparePlayerVsPlayer(a.id, b.id, range)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [a.id, b.id, range]);

  return (
    <div className="comparison">
      <div className="matchup">
        <div className="side">
          <div className="big">{a.fullName}</div>
          <div className="small">{a.teamAbbreviation ?? '—'}</div>
        </div>
        <div className="vs">vs</div>
        <div className="side">
          <div className="big">{b.fullName}</div>
          <div className="small">{b.teamAbbreviation ?? '—'}</div>
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
                <th>{a.fullName}</th>
                <th />
                <th>{b.fullName}</th>
              </tr>
            </thead>
            <tbody>
              {KEYS.map((k) => {
                const av = data.report.a.summaries[k].avg;
                const bv = data.report.b.summaries[k].avg;
                const winner = av > bv ? 'a' : av < bv ? 'b' : null;
                return (
                  <tr key={k}>
                    <td className={winner === 'a' ? 'pos' : ''}>{fmt(k, av)}</td>
                    <td className="label">{STAT_LABELS[k]}</td>
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
              type: 'player_vs_player',
              a: { id: a.id, name: a.fullName, team: a.teamAbbreviation, summaries: data.report.a },
              b: { id: b.id, name: b.fullName, team: b.teamAbbreviation, summaries: data.report.b },
              delta: data.report.delta,
              range,
            }}
          />
        </>
      )}
    </div>
  );
}
