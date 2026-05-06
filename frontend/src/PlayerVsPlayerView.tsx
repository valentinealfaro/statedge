import { useEffect, useState } from 'react';
import {
  comparePlayerVsPlayer,
  type Player,
  type PvpResponse,
  type SeasonRange,
  type StatKey,
} from './api';
import { AiSummary } from './AiSummary';
import { PlayerAvatar } from './Avatar';
import { SaveButton } from './SaveButton';
import { ShareButton } from './ShareButton';
import { SeasonTabs } from './SeasonTabs';
import { usePlan } from './plan';
import { recordRecent } from './recents';

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
  const { plan, recordComparison } = usePlan();
  const [range, setRange] = useState<Range>(plan === 'free' ? 'last5' : 'last10');
  const [seasons, setSeasons] = useState<SeasonRange>('current');
  const [data, setData] = useState<PvpResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan === 'free') recordComparison();
    recordRecent({ type: 'pvp', a, b });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id, b.id]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    comparePlayerVsPlayer(a.id, b.id, range, seasons)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [a.id, b.id, range, seasons]);

  return (
    <div className="comparison">
      <div className="matchup">
        <div className="side">
          <PlayerAvatar playerId={a.id} name={a.fullName} size="lg" />
          <div className="big">{a.fullName}</div>
          <div className="small">{a.teamAbbreviation ?? '—'}</div>
        </div>
        <div className="vs">vs</div>
        <div className="side">
          <PlayerAvatar playerId={b.id} name={b.fullName} size="lg" />
          <div className="big">{b.fullName}</div>
          <div className="small">{b.teamAbbreviation ?? '—'}</div>
        </div>
      </div>

      <div className="actions-row">
        <ShareButton />
        <SaveButton draft={{ type: 'pvp', a, b }} />
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
          Sample size: {a.fullName} {data.report.a.sampleSize} / {b.fullName}{' '}
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
