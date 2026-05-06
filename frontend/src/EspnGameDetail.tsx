import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getEspnGameSummary,
  type EspnGameSummary,
  type EspnInjury,
  type EspnLeader,
  type EspnPlayerLine,
  type EspnTeamSummary,
} from './api';
import { FreshnessBanner } from './FreshnessBanner';
import { NavBar } from './NavBar';
import { teamIdFromAbbr } from './teams';
import { useTitle } from './useTitle';

// ESPN-driven game detail: status / venue → starters → bench → leaders →
// injuries. Works for pre-game (lineups blank, injuries shown), live (in
// progress with current stats), and post-game (full boxscore + winner).
export function EspnGameDetail() {
  const { eventId } = useParams();
  const [data, setData] = useState<EspnGameSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useTitle([
    data ? `${data.away.abbreviation} @ ${data.home.abbreviation}` : 'Game',
  ]);

  useEffect(() => {
    if (!eventId) return;
    setData(null);
    setError(null);
    getEspnGameSummary(eventId)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [eventId]);

  return (
    <div className="app">
      <NavBar />
      <FreshnessBanner />

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading game details…</p>}

      {data && (
        <>
          <Header data={data} />

          <div className="bs-actions-row">
            <Link
              className="cta"
              to={`/compare?m=tvt&ta=${nbaTeamIdFromEspn(data.away)}&tb=${nbaTeamIdFromEspn(data.home)}`}
            >
              Compare {data.away.abbreviation} vs {data.home.abbreviation} →
            </Link>
          </div>

          {data.state === 'pre' ? (
            <PreGameView data={data} />
          ) : (
            <LiveOrFinalView data={data} />
          )}
        </>
      )}
    </div>
  );
}

// Header: matchup + final score / start-time + venue.
function Header({ data }: { data: EspnGameSummary }) {
  return (
    <>
      <div className="matchup">
        <SideHeader side={data.away} />
        <div className="vs">
          <div className={data.state === 'in' ? 'bs-final live' : 'bs-final'}>
            {data.state === 'pre' ? 'TIPOFF' : data.state === 'in' ? 'LIVE' : 'FINAL'}
          </div>
          <div className="bs-date">{data.statusDetail}</div>
          {data.venue && <div className="bs-date">{data.venue}</div>}
        </div>
        <SideHeader side={data.home} />
      </div>
    </>
  );
}

function SideHeader({ side }: { side: EspnTeamSummary }) {
  const won = !!side.isWinner;
  return (
    <div className={won ? 'side bs-side won' : 'side bs-side'}>
      {side.logo
        ? <img className="avatar lg team" src={side.logo} alt={side.displayName} />
        : null}
      <div className="big">{side.displayName}</div>
      <div className="small">
        {side.homeAway === 'home' ? 'Home' : 'Away'}
        {side.record && ` · ${side.record}`}
      </div>
      <div className="bs-score">{side.score || '—'}</div>
    </div>
  );
}

// --- Pre-game: starters not yet posted; show injuries + season records ---
function PreGameView({ data }: { data: EspnGameSummary }) {
  return (
    <>
      <div className="espn-side-grid">
        <InjuriesPanel side={data.away} />
        <InjuriesPanel side={data.home} />
      </div>
      <p className="muted small" style={{ textAlign: 'center', marginTop: 24 }}>
        Starting lineups are usually posted by ESPN ~30 min before tipoff.
      </p>
    </>
  );
}

// --- Live / Final: full boxscore-shaped layout per team ---
function LiveOrFinalView({ data }: { data: EspnGameSummary }) {
  return (
    <>
      <div className="espn-side-grid">
        <LeadersPanel side={data.away} />
        <LeadersPanel side={data.home} />
      </div>

      <TeamSection side={data.away} />
      <TeamSection side={data.home} />
    </>
  );
}

function TeamSection({ side }: { side: EspnTeamSummary }) {
  return (
    <>
      <h3 className="bs-team-heading">
        {side.logo && (
          <img className="avatar md team" src={side.logo} alt={side.displayName} />
        )}
        <span>{side.displayName}</span>
        {side.score && (
          <span className={side.isWinner ? 'pos bs-team-result' : 'bs-team-result'}>
            {side.score}
          </span>
        )}
      </h3>

      {side.starters.length > 0 && (
        <PlayerTable label="Starters" players={side.starters} />
      )}
      {side.bench.length > 0 && (
        <PlayerTable label="Bench" players={side.bench} />
      )}

      {side.injuries.length > 0 && (
        <InjuriesPanel side={side} compact />
      )}
    </>
  );
}

function PlayerTable({ label, players }: { label: string; players: EspnPlayerLine[] }) {
  return (
    <>
      <div className="espn-section-label">{label}</div>
      <div className="games-scroll">
        <table className="games bs-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>POS</th>
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
              <th>±</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.athleteId}>
                <td>
                  <span className="bs-player-link">
                    {p.headshot
                      ? <img className="avatar md" src={p.headshot} alt={p.displayName} />
                      : null}
                    <span>
                      {p.displayName}
                      {p.didNotPlay && <span className="dnp-pill"> DNP</span>}
                    </span>
                  </span>
                </td>
                <td>{p.position}</td>
                <td>{p.minutes || (p.didNotPlay ? '—' : 0)}</td>
                <td><strong>{p.points}</strong></td>
                <td>{p.rebounds}</td>
                <td>{p.assists}</td>
                <td>{p.steals}</td>
                <td>{p.blocks}</td>
                <td>{p.turnovers}</td>
                <td>{p.fg || '—'}</td>
                <td>{p.threePt || '—'}</td>
                <td>{p.ft || '—'}</td>
                <td>{p.fouls}</td>
                <td>{p.plusMinus || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LeadersPanel({ side }: { side: EspnTeamSummary }) {
  if (side.leaders.length === 0) return null;
  return (
    <div className="leaders-panel">
      <h4>{side.abbreviation} Leaders</h4>
      <div className="leaders-list">
        {side.leaders.map((l) => (
          <div key={l.category} className="leader-row">
            {l.athleteHeadshot && (
              <img className="avatar md" src={l.athleteHeadshot} alt={l.athleteName} />
            )}
            <div className="leader-body">
              <div className="leader-name">{l.athleteName}</div>
              <div className="leader-meta">{l.displayName}: <strong>{l.value}</strong></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function InjuriesPanel({ side, compact }: { side: EspnTeamSummary; compact?: boolean }) {
  if (side.injuries.length === 0) {
    if (compact) return null;
    return (
      <div className="injuries-panel">
        <h4>{side.abbreviation} · Injury report</h4>
        <p className="muted small">No injuries reported.</p>
      </div>
    );
  }
  return (
    <div className="injuries-panel">
      <h4>{side.abbreviation} · Injury report</h4>
      <div className="injuries-list">
        {side.injuries.map((i) => (
          <InjuryRow key={i.athleteId} injury={i} />
        ))}
      </div>
    </div>
  );
}

function InjuryRow({ injury }: { injury: EspnInjury }) {
  const cls = injury.status.toLowerCase().includes('out')
    ? 'injury-status out'
    : injury.status.toLowerCase().startsWith('day')
    ? 'injury-status d2d'
    : 'injury-status';
  return (
    <div className="injury-row">
      {injury.headshot && (
        <img className="avatar md" src={injury.headshot} alt={injury.displayName} />
      )}
      <div className="injury-body">
        <div className="injury-name">{injury.displayName}{injury.position && ` · ${injury.position}`}</div>
        {injury.type && <div className="injury-type muted small">{injury.type}</div>}
      </div>
      <span className={cls}>{injury.status}</span>
    </div>
  );
}

// ESPN team IDs (1, 2, 3...) don't map directly to NBA stats team IDs.
// Both APIs share the 3-letter abbreviation, so we use the shared
// abbr→nba-id map from teams.ts.
function nbaTeamIdFromEspn(side: EspnTeamSummary): number {
  return teamIdFromAbbr(side.abbreviation) ?? 0;
}
