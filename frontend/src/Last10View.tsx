import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { PlayerAvatar } from './Avatar';
import { MatchupCell } from './MatchupCell';
import { teamIdFromAbbr } from './teams';
import { SaveButton } from './SaveButton';
import { ShareButton } from './ShareButton';
import { usePlan } from './plan';
import { recordRecent } from './recents';
import { useTitle } from './useTitle';

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
  const { plan, recordComparison } = usePlan();
  const [stat, setStat] = useState<Last10StatId>('points');
  const [data, setData] = useState<Last10Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan === 'free') recordComparison();
    recordRecent({ type: 'last10', player });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.id]);

  useTitle([`${player.fullName} · Last 10`]);

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
          <PlayerAvatar playerId={player.id} name={player.fullName} size="lg" />
          <div className="big">{player.fullName}</div>
          <div className="small">{player.teamAbbreviation ?? '—'}</div>
        </div>
        <div className="vs">Last 10 games</div>
        <div className="side">
          <div className="small">All opponents</div>
        </div>
      </div>

      <div className="actions-row">
        <ShareButton />
        <SaveButton draft={{ type: 'last10', player }} />
      </div>

      {data && data.seasonVsL10 && data.seasonVsL10.length > 0 && (
        <SeasonVsL10Strip rows={data.seasonVsL10} />
      )}

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

      {data && data.byOpponent && data.byOpponent.length > 0 && (
        <ByOpponentView
          rows={data.byOpponent}
          label={data.label}
          isDD={data.selectedStat === 'double_double'}
          playerId={player.id}
        />
      )}
    </div>
  );
}

function SeasonVsL10Strip({
  rows,
}: {
  rows: NonNullable<Last10Response['seasonVsL10']>;
}) {
  // Threshold for showing a directional ↑/↓: 5% of season avg or 0.3
  // raw units, whichever is larger. Below that we render '·' (neutral).
  return (
    <div className="svl-strip">
      {rows.map((r) => {
        const isPct = r.stat === 'fgPct' || r.stat === 'fg3Pct' || r.stat === 'ftPct';
        const fmt = (v: number) => isPct ? `${(v * 100).toFixed(1)}%` : v.toFixed(1);
        const threshold = Math.max(isPct ? 0.005 : 0.3, Math.abs(r.seasonAvg) * 0.05);
        const dir = r.delta > threshold ? 'up'
          : r.delta < -threshold ? 'down'
          : 'flat';
        const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '·';
        const cls = `svl-cell ${dir === 'up' ? 'pos' : dir === 'down' ? 'neg' : ''}`;
        return (
          <div key={r.stat} className={cls}>
            <div className="svl-label">{r.label}</div>
            <div className="svl-l10">{fmt(r.l10Avg)} <span className="svl-arrow">{arrow}</span></div>
            <div className="svl-season">season {fmt(r.seasonAvg)}</div>
          </div>
        );
      })}
    </div>
  );
}

function ByOpponentView({
  rows,
  label,
  isDD,
  playerId,
}: {
  rows: NonNullable<Last10Response['byOpponent']>;
  label: string;
  isDD: boolean;
  playerId: number;
}) {
  const navigate = useNavigate();
  return (
    <>
      <h3>{label} by opponent (this season)</h3>
      <p className="muted small">
        Sorted high to low. Small samples (1–4 games each) but useful for
        spotting matchups they feast on or get held by. Click a row to open
        the full Player vs Team comparison for that opponent.
      </p>
      <div className="games-scroll">
        <table className="games">
          <thead>
            <tr>
              <th>Opp</th>
              <th>Games</th>
              <th>{isDD ? 'DD rate' : 'Avg'}</th>
              <th>High</th>
              <th>Low</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const teamId = teamIdFromAbbr(r.opponentAbbr);
              const onClick = teamId
                ? () => navigate(`/compare?m=pvt&pid=${playerId}&tid=${teamId}`)
                : undefined;
              return (
                <tr
                  key={r.opponentAbbr}
                  className={onClick ? 'by-opp-row clickable' : 'by-opp-row'}
                  onClick={onClick}
                >
                  <td><strong>{r.opponentAbbr}</strong></td>
                  <td>{r.gamesPlayed}</td>
                  <td>
                    <strong>
                      {isDD ? `${Math.round(r.avg * 100)}%` : r.avg.toFixed(1)}
                    </strong>
                  </td>
                  <td>{isDD ? (r.high ? 'Yes' : 'No') : r.high}</td>
                  <td>{isDD ? (r.low ? 'Yes' : 'No') : r.low}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
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
                <td>
                  <Link className="game-link" to={`/game/${g.gameId}`} title="View boxscore">
                    {g.date}
                  </Link>
                </td>
                <td><MatchupCell opponentAbbr={g.opponentAbbr} isHome={g.isHome} /></td>
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
                <td>
                  <Link className="game-link" to={`/game/${g.gameId}`} title="View boxscore">
                    {g.date}
                  </Link>
                </td>
                <td><MatchupCell opponentAbbr={g.opponentAbbr} isHome={g.isHome} /></td>
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
