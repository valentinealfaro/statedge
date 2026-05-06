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
  type CompareResponse,
  type HitProbability,
  type Player,
  type SeasonRange,
  type SelectedStat,
  type StatKey,
  type Team,
} from './api';
import { AdvancedCards } from './AdvancedCards';
import { AiSummary } from './AiSummary';
import { HitBadge } from './HitBadge';
import { SeasonTabs } from './SeasonTabs';
import { STAT_LABELS, StatPicker } from './StatPicker';

// Stat tiles for which we offer a "Line" input + hit-probability badge.
// (Minutes / FG% / 3PT% don't map cleanly to traditional prop lines.)
const HIT_STATS = ['points', 'rebounds', 'assists'] as const;
type HitStat = typeof HIT_STATS[number];

type Props = {
  player: Player;
  team: Team;
};

type Range = 'last5' | 'last10' | 'last20' | 'season';

const PER_STAT_LABELS: Record<StatKey, string> = {
  points: 'Points',
  rebounds: 'Rebounds',
  assists: 'Assists',
  minutes: 'Minutes',
  fgPct: 'FG%',
  fg3Pct: '3PT%',
};

function statAvgFor(data: CompareResponse, stat: SelectedStat): number {
  switch (stat) {
    case 'points':   return data.report.vsTeam.points.avg;
    case 'rebounds': return data.report.vsTeam.rebounds.avg;
    case 'assists':  return data.report.vsTeam.assists.avg;
    case 'PRA':      return data.combos.PRA;
    case 'PR':       return data.combos.PR;
    case 'PA':       return data.combos.PA;
    case 'RA':       return data.combos.RA;
    case 'STOCKS':   return data.combos.STOCKS;
  }
}

export function ComparisonView({ player, team }: Props) {
  const [range, setRange] = useState<Range>('last5');
  const [seasons, setSeasons] = useState<SeasonRange>('current');
  const [selectedStat, setSelectedStat] = useState<SelectedStat>('PRA');
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-tile prop line inputs and the resulting hit-probability per stat.
  // We fire one debounced refetch per stat with a numeric line set.
  const [lines, setLines] = useState<Record<HitStat, string>>({
    points: '', rebounds: '', assists: '',
  });
  const [hits, setHits] = useState<Record<HitStat, HitProbability | null>>({
    points: null, rebounds: null, assists: null,
  });

  useEffect(() => {
    setLoading(true);
    setError(null);
    comparePlayerVsTeam(player.id, team.id, range, seasons, selectedStat)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [player.id, team.id, range, seasons, selectedStat]);

  // Whenever a line input changes, refetch hit probability for stats that
  // have a valid number entered. Debounced so each keystroke doesn't fire.
  useEffect(() => {
    const id = setTimeout(async () => {
      for (const k of HIT_STATS) {
        const v = parseFloat(lines[k]);
        if (!Number.isFinite(v)) {
          setHits((h) => ({ ...h, [k]: null }));
          continue;
        }
        try {
          const r = await comparePlayerVsTeam(
            player.id, team.id, range, seasons, selectedStat,
            { line: v, statKey: k },
          );
          setHits((h) => ({ ...h, [k]: r.hitProbability ?? null }));
        } catch {
          setHits((h) => ({ ...h, [k]: null }));
        }
      }
    }, 400);
    return () => clearTimeout(id);
  }, [lines, player.id, team.id, range, seasons, selectedStat]);

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
          <StatPicker value={selectedStat} onChange={setSelectedStat} />

          <div className="combo">
            <div className="combo-display">
              <div className="combo-label">{STAT_LABELS[selectedStat]} · vs {team.abbreviation}</div>
              <div className="combo-value">{statAvgFor(data, selectedStat).toFixed(1)}</div>
              <div className="combo-meta">
                Average across {data.gamesAnalyzed} game{data.gamesAnalyzed === 1 ? '' : 's'}
              </div>
            </div>
          </div>

          <h3>Advanced metrics</h3>
          <AdvancedCards advanced={data.advanced} />

          <div className="cards">
            {(['points', 'rebounds', 'assists', 'minutes', 'fgPct', 'fg3Pct'] as StatKey[]).map(
              (k) => {
                const s = data.report.vsTeam[k];
                const seasonAvg = data.report.seasonAverage[k];
                const delta = data.report.delta[k];
                const isPct = k === 'fgPct' || k === 'fg3Pct';
                const isHitStat = (HIT_STATS as readonly string[]).includes(k);
                const hk = k as HitStat;
                return (
                  <div key={k} className="card">
                    <div className="k">{PER_STAT_LABELS[k]}</div>
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
                    {isHitStat && (
                      <div className="line-input-row">
                        <label className="line-label">Line</label>
                        <input
                          className="line-input"
                          type="number"
                          inputMode="decimal"
                          step="0.5"
                          placeholder="e.g. 24.5"
                          value={lines[hk]}
                          onChange={(e) => setLines((l) => ({ ...l, [hk]: e.target.value }))}
                        />
                      </div>
                    )}
                    {isHitStat && hits[hk] && (
                      <HitBadge hit={hits[hk]!} gamesAnalyzed={10} />
                    )}
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
