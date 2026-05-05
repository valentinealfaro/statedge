import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  getPlayerLast10,
  type Last10Response,
  type Last10StatId,
  type Player,
} from './api';

type Props = { player: Player };

// Order matters — matches the spec's chip menu.
const STAT_ORDER: Last10StatId[] = [
  'points',
  'rebounds',
  'assists',
  'three_pt_made',
  'fg_made',
  'fg_attempted',
  'ft_made',
  'ft_attempted',
  'personal_fouls',
  'steals',
  'blocks',
  'turnovers',
  'offensive_rebounds',
  'defensive_rebounds',
  'double_double',
  'pra',
  'pr',
  'pa',
  'ra',
  'stocks',
];

const LABELS: Record<Last10StatId, string> = {
  points: 'Points',
  rebounds: 'Rebounds',
  assists: 'Assists',
  three_pt_made: '3-PT Made',
  fg_made: 'FG Made',
  fg_attempted: 'FG Attempted',
  ft_made: 'Free Throws Made',
  ft_attempted: 'Free Throws Attempted',
  personal_fouls: 'Personal Fouls',
  steals: 'Steals',
  blocks: 'Blocked Shots',
  turnovers: 'Turnovers',
  offensive_rebounds: 'Offensive Rebounds',
  defensive_rebounds: 'Defensive Rebounds',
  pra: 'Pts + Rebs + Asts',
  pr: 'Pts + Rebs',
  pa: 'Pts + Asts',
  ra: 'Rebs + Asts',
  stocks: 'Blks + Stls',
  double_double: 'Double-Double',
};

export function Last10View({ player }: Props) {
  const [stat, setStat] = useState<Last10StatId>('points');
  const [data, setData] = useState<Last10Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getPlayerLast10(player.id, stat)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [player.id, stat]);

  return (
    <div className="comparison">
      <div className="matchup">
        <div className="side">
          <div className="big">{player.fullName}</div>
          <div className="small">{player.teamAbbreviation ?? '—'}</div>
        </div>
        <div className="vs">Last 10 games</div>
        <div className="side">
          <div className="small">All opponents</div>
        </div>
      </div>

      <div className="chips">
        {STAT_ORDER.map((s) => (
          <button
            key={s}
            className={s === stat ? 'chip active' : 'chip'}
            onClick={() => setStat(s)}
          >
            {LABELS[s]}
          </button>
        ))}
      </div>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}

      {data && data.selectedStat === 'double_double' && (
        <DoubleDoubleView data={data} />
      )}

      {data && data.selectedStat !== 'double_double' && (
        <NumericStatView data={data} />
      )}
    </div>
  );
}

function NumericStatView({ data }: { data: Extract<Last10Response, { average: number }> }) {
  const chartData = [...data.gameLog].reverse().map((g, idx) => ({
    label: `${g.date.slice(5)} ${g.matchup.split(' ')[2] ?? ''}`,
    value: data.values[data.values.length - 1 - idx] ?? 0,
  }));

  return (
    <>
      <div className="adv-grid">
        <div className="adv-card">
          <div className="adv-k">{data.label} · Average</div>
          <div className="adv-v">{data.average.toFixed(1)}</div>
          <div className="adv-sub">over last {data.gamesAnalyzed} games</div>
        </div>
        <div className="adv-card">
          <div className="adv-k">High</div>
          <div className="adv-v">{data.high}</div>
          <div className="adv-sub">best of last 10</div>
        </div>
        <div className="adv-card">
          <div className="adv-k">Low</div>
          <div className="adv-v">{data.low}</div>
          <div className="adv-sub">worst of last 10</div>
        </div>
        <div className="adv-card">
          <div className="adv-k">Above avg</div>
          <div className="adv-v">{data.hitCountAboveAverage}<span className="adv-unit"> / {data.gamesAnalyzed}</span></div>
          <div className="adv-sub">games over the mean</div>
        </div>
      </div>

      <h3>{data.label} across last {data.gamesAnalyzed} games</h3>
      <div className="chart">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid stroke="#1f2330" />
            <XAxis dataKey="label" stroke="#8a93a6" fontSize={11} />
            <YAxis stroke="#8a93a6" />
            <Tooltip contentStyle={{ background: '#14171f', border: '1px solid #2a2f3a' }} />
            <ReferenceLine y={data.average} stroke="#6ee7a4" strokeDasharray="4 4" />
            <Line type="monotone" dataKey="value" stroke="#5b8def" strokeWidth={2} dot={{ fill: '#5b8def' }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h3>Game log</h3>
      <div className="games-scroll">
        <table className="games">
          <thead>
            <tr>
              <th>Date</th>
              <th>Matchup</th>
              <th>W/L</th>
              <th>MIN</th>
              <th>{data.label}</th>
              <th>PTS</th>
              <th>REB</th>
              <th>AST</th>
            </tr>
          </thead>
          <tbody>
            {data.gameLog.map((g, i) => (
              <tr key={g.gameId}>
                <td>{g.date}</td>
                <td>{g.matchup}</td>
                <td className={g.result === 'W' ? 'pos' : 'neg'}>{g.result ?? '—'}</td>
                <td>{g.minutes}</td>
                <td><strong>{data.values[i]}</strong></td>
                <td>{g.points}</td>
                <td>{g.rebounds}</td>
                <td>{g.assists}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DoubleDoubleView({ data }: { data: Extract<Last10Response, { selectedStat: 'double_double' }> }) {
  return (
    <>
      <div className="adv-grid">
        <div className="adv-card">
          <div className="adv-k">Double-Double Rate</div>
          <div className="adv-v">{data.doubleDouble.rate}%</div>
          <div className="adv-sub">{data.doubleDouble.count} of last {data.gamesAnalyzed}</div>
        </div>
      </div>

      <h3>Game-by-game</h3>
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
              <th>DD?</th>
            </tr>
          </thead>
          <tbody>
            {data.gameLog.map((g, i) => (
              <tr key={g.gameId}>
                <td>{g.date}</td>
                <td>{g.matchup}</td>
                <td className={g.result === 'W' ? 'pos' : 'neg'}>{g.result ?? '—'}</td>
                <td>{g.points}</td>
                <td>{g.rebounds}</td>
                <td>{g.assists}</td>
                <td>{g.steals}</td>
                <td>{g.blocks}</td>
                <td className={data.doubleDouble.values[i] ? 'pos' : 'muted'}>
                  {data.doubleDouble.values[i] ? 'Yes' : 'No'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
