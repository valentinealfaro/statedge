import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  comparePlayerVsTeam,
  type ComboKey,
  type CompareResponse,
  type Player,
  type SeasonRange,
  type StatKey,
  type Team,
} from './api';
import { AiSummary } from './AiSummary';
import { ComboPicker } from './ComboPicker';
import { SeasonTabs } from './SeasonTabs';

type Props = {
  player: Player;
  team: Team;
};

type Range = 'last5' | 'last10' | 'last20' | 'season';

const STAT_LABELS: Record<StatKey, string> = {
  points: 'Points',
  rebounds: 'Rebounds',
  assists: 'Assists',
  minutes: 'Minutes',
  fgPct: 'FG%',
  fg3Pct: '3PT%',
};

export function ComparisonView({ player, team }: Props) {
  const [range, setRange] = useState<Range>('last5');
  const [seasons, setSeasons] = useState<SeasonRange>('current');
  const [combo, setCombo] = useState<ComboKey>('PRA');
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    comparePlayerVsTeam(player.id, team.id, range, seasons)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [player.id, team.id, range, seasons]);

  return (
    <div className="comparison">
      <div className="matchup">
        <div className="side">
          <div className="big">{player.fullName}</div>
          <div className="small">{player.teamAbbreviation ?? '—'}</div>
        </div>
        <div className="vs">vs</div>
        <div className="side">
          <div className="big">{team.fullName}</div>
          <div className="small">{team.abbreviation}</div>
        </div>
      </div>

      <SeasonTabs value={seasons} onChange={setSeasons} />

      <div className="range-tabs">
        {(['last5', 'last10', 'last20', 'season'] as Range[]).map((r) => (
          <button
            key={r}
            className={r === range ? 'tab active' : 'tab'}
            onClick={() => setRange(r)}
          >
            {r === 'season' ? 'All' : `Last ${r.replace('last', '')}`}
          </button>
        ))}
      </div>

      {data && (
        <p className="muted sample">
          Showing {data.report.gamesAgainstTeam.length} game
          {data.report.gamesAgainstTeam.length === 1 ? '' : 's'} vs {team.abbreviation}
          {' '}across {data.seasons.length} season{data.seasons.length === 1 ? '' : 's'} (
          {data.seasons.join(', ')}). Player has {data.report.seasonSampleSize} total games in
          this period.
        </p>
      )}

      {loading && <p className="muted">Loading comparison…</p>}
      {error && <p className="error">{error}</p>}

      {data && data.report.gamesAgainstTeam.length === 0 && (
        <p className="muted">
          No games against {team.fullName} in this period. Try expanding to last 3 or 5 seasons.
        </p>
      )}

      {data && data.report.gamesAgainstTeam.length > 0 && (
        <>
          <ComboPicker
            combos={data.combos}
            gamesAnalyzed={data.gamesAnalyzed}
            selected={combo}
            onSelect={setCombo}
          />

          <div className="cards">
            {(['points', 'rebounds', 'assists', 'minutes', 'fgPct', 'fg3Pct'] as StatKey[]).map(
              (k) => {
                const s = data.report.vsTeam[k];
                const seasonAvg = data.report.seasonAverage[k];
                const delta = data.report.delta[k];
                const isPct = k === 'fgPct' || k === 'fg3Pct';
                return (
                  <div key={k} className="card">
                    <div className="k">{STAT_LABELS[k]}</div>
                    <div className="v">{isPct ? `${(s.avg * 100).toFixed(1)}%` : s.avg}</div>
                    <div className="meta">
                      <span>
                        season {isPct ? `${(seasonAvg * 100).toFixed(1)}%` : seasonAvg}
                      </span>
                      <span className={delta >= 0 ? 'pos' : 'neg'}>
                        {delta >= 0 ? '+' : ''}
                        {isPct ? `${(delta * 100).toFixed(1)}%` : delta}
                      </span>
                    </div>
                    <div className="row">
                      <span>Consistency</span>
                      <span>{s.consistency.toFixed(0)}/100</span>
                    </div>
                    <div className="row">
                      <span>Trend</span>
                      <span>{s.trend}</span>
                    </div>
                  </div>
                );
              },
            )}
          </div>

          <h3>Points across recent games vs {team.abbreviation}</h3>
          <div className="chart">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart
                data={[...data.report.gamesAgainstTeam]
                  .reverse()
                  .map((g) => ({ date: g.date, points: g.points, opp: g.opponentAbbr }))}
                margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
              >
                <CartesianGrid stroke="#1f2330" />
                <XAxis dataKey="date" stroke="#8a93a6" />
                <YAxis stroke="#8a93a6" />
                <Tooltip contentStyle={{ background: '#14171f', border: '1px solid #2a2f3a' }} />
                <Line
                  type="monotone"
                  dataKey="points"
                  stroke="#5b8def"
                  strokeWidth={2}
                  dot={{ fill: '#5b8def' }}
                />
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
                  <th>PTS</th>
                  <th>REB</th>
                  <th>AST</th>
                  <th>STL</th>
                  <th>BLK</th>
                  <th>TO</th>
                  <th>FG</th>
                  <th>3P</th>
                  <th>FT</th>
                  <th>PF</th>
                </tr>
              </thead>
              <tbody>
                {data.report.gamesAgainstTeam.map((g) => (
                  <tr key={g.gameId}>
                    <td>{g.date}</td>
                    <td>{g.matchup}</td>
                    <td className={g.result === 'W' ? 'pos' : 'neg'}>{g.result ?? '—'}</td>
                    <td>{g.minutes}</td>
                    <td>{g.points}</td>
                    <td>{g.rebounds}</td>
                    <td>{g.assists}</td>
                    <td>{g.steals}</td>
                    <td>{g.blocks}</td>
                    <td>{g.turnovers}</td>
                    <td>{g.fgm ?? '—'}/{g.fga ?? '—'}</td>
                    <td>{g.fg3m ?? '—'}/{g.fg3a ?? '—'}</td>
                    <td>{g.ftm ?? '—'}/{g.fta ?? '—'}</td>
                    <td>{g.pf ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <AiSummary
            payload={{
              type: 'player_vs_team',
              player: { id: player.id, name: player.fullName, team: player.teamAbbreviation },
              opponent: { id: team.id, name: team.fullName, abbr: team.abbreviation },
              range,
              vsTeamSummary: data.report.vsTeam,
              seasonAverage: data.report.seasonAverage,
              delta: data.report.delta,
              gameLog: data.report.gamesAgainstTeam.map((g) => ({
                date: g.date,
                opp: g.opponentAbbr,
                result: g.result,
                pts: g.points,
                reb: g.rebounds,
                ast: g.assists,
              })),
            }}
          />
        </>
      )}
    </div>
  );
}
