import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getBoxscore,
  type Boxscore,
  type BoxscorePlayer,
  type BoxscoreSide,
} from './api';
import { TeamLogo } from './Avatar';
import { FreshnessBanner } from './FreshnessBanner';
import { useTitle } from './useTitle';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

type SortKey = keyof Pick<BoxscorePlayer,
  'minutes' | 'points' | 'rebounds' | 'assists' | 'steals' | 'blocks' | 'turnovers'>;

export function GameDetail() {
  const { gameId } = useParams();
  const [data, setData] = useState<Boxscore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('minutes');

  useTitle([
    data ? `${data.away.abbreviation} @ ${data.home.abbreviation} · ${fmtDate(data.date)}` : 'Boxscore',
  ]);

  useEffect(() => {
    if (!gameId) return;
    setData(null);
    setError(null);
    getBoxscore(gameId)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [gameId]);

  return (
    <div className="app">
      <Link to="/" className="brand">StatEdge</Link>
      <p className="tag">NBA stats comparison</p>
      <FreshnessBanner />

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading boxscore…</p>}

      {data && (
        <>
          <div className="matchup">
            <Side side={data.away} />
            <div className="vs">
              <div className="bs-final">FINAL</div>
              <div className="bs-date">{fmtDate(data.date)}</div>
            </div>
            <Side side={data.home} />
          </div>

          <div className="bs-actions-row">
            <Link
              className="cta"
              to={`/compare?m=tvt&ta=${data.away.teamId}&tb=${data.home.teamId}`}
            >
              Compare {data.away.abbreviation} vs {data.home.abbreviation} →
            </Link>
          </div>

          <BoxscoreTable side={data.away} sortKey={sortKey} onSort={setSortKey} />
          <BoxscoreTable side={data.home} sortKey={sortKey} onSort={setSortKey} />
        </>
      )}
    </div>
  );
}

function Side({ side }: { side: BoxscoreSide }) {
  const won = side.result === 'W';
  return (
    <div className={won ? 'side bs-side won' : 'side bs-side'}>
      <TeamLogo abbr={side.abbreviation} name={side.fullName} size="lg" />
      <div className="big">{side.fullName}</div>
      <div className="small">{side.isHome ? 'Home' : 'Away'}</div>
      <div className="bs-score">{side.points}</div>
    </div>
  );
}

function BoxscoreTable({
  side,
  sortKey,
  onSort,
}: {
  side: BoxscoreSide;
  sortKey: SortKey;
  onSort: (k: SortKey) => void;
}) {
  const players = [...side.players].sort((a, b) => b[sortKey] - a[sortKey]);
  return (
    <>
      <h3 className="bs-team-heading">
        <TeamLogo abbr={side.abbreviation} name={side.fullName} size="md" />
        <span>{side.fullName}</span>
        <span className={side.result === 'W' ? 'pos bs-team-result' : 'neg bs-team-result'}>
          {side.points} {side.result ?? ''}
        </span>
      </h3>
      <div className="games-scroll">
        <table className="games bs-table">
          <thead>
            <tr>
              <th>Player</th>
              <ThSort field="minutes"   active={sortKey} onSort={onSort}>MIN</ThSort>
              <ThSort field="points"    active={sortKey} onSort={onSort}>PTS</ThSort>
              <ThSort field="rebounds"  active={sortKey} onSort={onSort}>REB</ThSort>
              <ThSort field="assists"   active={sortKey} onSort={onSort}>AST</ThSort>
              <ThSort field="steals"    active={sortKey} onSort={onSort}>STL</ThSort>
              <ThSort field="blocks"    active={sortKey} onSort={onSort}>BLK</ThSort>
              <ThSort field="turnovers" active={sortKey} onSort={onSort}>TO</ThSort>
              <th>FG</th>
              <th>3P</th>
              <th>FT</th>
              <th>PF</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.playerId}>
                <td>
                  <Link
                    className="bs-player-link"
                    to={`/compare?m=last10&pid=${p.playerId}`}
                    title="See last 10 games"
                  >
                    {p.fullName}
                  </Link>
                </td>
                <td>{p.minutes}</td>
                <td><strong>{p.points}</strong></td>
                <td>{p.rebounds}</td>
                <td>{p.assists}</td>
                <td>{p.steals}</td>
                <td>{p.blocks}</td>
                <td>{p.turnovers}</td>
                <td>{p.fgm}/{p.fga}</td>
                <td>{p.fg3m}/{p.fg3a}</td>
                <td>{p.ftm}/{p.fta}</td>
                <td>{p.pf}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ThSort({
  field,
  active,
  onSort,
  children,
}: {
  field: SortKey;
  active: SortKey;
  onSort: (k: SortKey) => void;
  children: React.ReactNode;
}) {
  return (
    <th
      className={field === active ? 'sortable active' : 'sortable'}
      onClick={() => onSort(field)}
    >
      {children}{field === active ? ' ▼' : ''}
    </th>
  );
}
