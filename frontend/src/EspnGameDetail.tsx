import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getEspnGameSummary,
  getNbaLiveToday,
  getTodaySlate,
  type EspnGameSummary,
  type EspnInjury,
  type EspnLeader,
  type EspnPlayerLine,
  type EspnTeamSummary,
  type NbaLiveTodayPlayer,
  type NbaLiveTodayResponse,
  type SlateCombo,
  type SlateComboLeg,
  type SlateResponse,
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
  const [tick, setTick] = useState(0);

  useTitle([
    data ? `${data.away.abbreviation} @ ${data.home.abbreviation}` : 'Game',
  ]);

  useEffect(() => {
    if (!eventId) return;
    setError(null);
    let cancelled = false;
    getEspnGameSummary(eventId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [eventId, tick]);

  // Auto-refresh while game is live (30s) — same cadence MLB uses.
  // Pre-game polls slowly (90s) in case lineups drop; final games
  // freeze after one fetch.
  useEffect(() => {
    if (!data || data.state === 'post') return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, data.state === 'in' ? 30_000 : 90_000);
    return () => window.clearInterval(interval);
  }, [data?.state]);

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

          <SameGameParlay data={data} />

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

// ---------- Same-Game Parlay with live grading ----------
//
// Filters today's published slate to legs whose player team matches
// either side of this matchup, ranks by edge%, and live-grades each
// against ESPN's box-score stats. Same pattern as MLB, mapped to NBA.
function nbaLiveValueForStat(stats: NbaLiveTodayPlayer, statKey: string): number | null {
  switch (statKey) {
    case 'points':              return stats.points;
    case 'rebounds':            return stats.rebounds;
    case 'assists':             return stats.assists;
    case 'three_pt_made':       return stats.threePtMade;
    case 'fg_made':             return stats.fgMade;
    case 'fg_attempted':        return stats.fgAttempted;
    case 'ft_made':             return stats.ftMade;
    case 'ft_attempted':        return stats.ftAttempted;
    case 'personal_fouls':      return stats.personalFouls;
    case 'steals':              return stats.steals;
    case 'blocks':              return stats.blocks;
    case 'turnovers':           return stats.turnovers;
    case 'pra':                 return stats.pra;
    case 'pr':                  return stats.pr;
    case 'pa':                  return stats.pa;
    case 'ra':                  return stats.ra;
    case 'stocks':              return stats.stocks;
    case 'double_double':       return stats.doubleDouble;
    default:                    return null;
  }
}

type LegGrade = 'HIT' | 'MISS' | 'PROGRESS' | 'PUSH' | 'PENDING';

function gradeNbaLeg(
  direction: 'OVER' | 'UNDER',
  line: number,
  current: number | null,
  state: 'pregame' | 'live' | 'final' | undefined,
): LegGrade {
  if (current === null || !state || state === 'pregame') return 'PENDING';
  const isFinal = state === 'final';
  if (direction === 'OVER') {
    if (current > line) return 'HIT';
    if (isFinal) return current === line ? 'PUSH' : 'MISS';
    return 'PROGRESS';
  }
  if (current > line) return 'MISS';
  if (isFinal) return current === line ? 'PUSH' : 'HIT';
  return 'PROGRESS';
}

function SameGameParlay({ data }: { data: EspnGameSummary }) {
  const [slate, setSlate] = useState<SlateResponse | null>(null);
  const [live, setLive] = useState<NbaLiveTodayResponse | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getTodaySlate('balanced')
      .then((d) => { if (!cancelled) setSlate(d.resolved ?? null); })
      .catch(() => { /* slate may not be published yet — fall back to no SGP */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getNbaLiveToday()
      .then((d) => { if (!cancelled) setLive(d); })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    if (live?.byGame[data.eventId]?.state !== 'live') return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [live?.byGame, data.eventId]);

  const sgpLegs = useMemo(() => {
    if (!slate?.combos) return [] as SlateComboLeg[];
    const teamAbbrs = new Set([data.away.abbreviation, data.home.abbreviation]);
    const map = new Map<string, SlateComboLeg>();
    for (const c of slate.combos as SlateCombo[]) {
      for (const l of c.legs) {
        const key = `${l.playerId}::${l.statKey}::${l.line}::${l.direction}`;
        if (l.team && teamAbbrs.has(l.team) && !map.has(key)) {
          map.set(key, l);
        }
      }
    }
    return [...map.values()]
      .sort((a, b) => (b.edgePercent ?? 0) - (a.edgePercent ?? 0))
      .slice(0, 4);
  }, [slate, data.away.abbreviation, data.home.abbreviation]);

  if (sgpLegs.length === 0) return null;

  const gameState = live?.byGame[data.eventId]?.state;
  const isLiveOrFinal = gameState === 'live' || gameState === 'final';
  const isFinal = gameState === 'final';

  const graded = sgpLegs.map((l) => {
    if (!isLiveOrFinal || !live) {
      return { leg: l, current: null as number | null, grade: 'PENDING' as LegGrade };
    }
    const ps = live.byPlayer[String(l.playerId)] ?? null;
    if (!ps) return { leg: l, current: null, grade: 'PENDING' as LegGrade };
    const current = nbaLiveValueForStat(ps, l.statKey);
    return { leg: l, current, grade: gradeNbaLeg(l.direction, l.line, current, gameState) };
  });

  const tally = {
    hit: graded.filter((g) => g.grade === 'HIT').length,
    miss: graded.filter((g) => g.grade === 'MISS').length,
    progress: graded.filter((g) => g.grade === 'PROGRESS').length,
    push: graded.filter((g) => g.grade === 'PUSH').length,
  };

  const combinedHit = sgpLegs.reduce((p, l) => p * (l.probability / 100), 1) * 100;
  const avgEdge =
    sgpLegs.reduce((s, l) => s + (l.edgePercent ?? 0), 0) / sgpLegs.length;

  return (
    <details className="mlb-context" open style={{ margin: '16px 0' }}>
      <summary className="mlb-context-heading">
        Same-Game Parlay <span className="muted small">— top edge legs from this matchup</span>
        {isLiveOrFinal && (
          <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em' }}>
            <span style={{ color: '#66bb6a' }}>● {tally.hit} HIT</span>
            {tally.miss > 0 && <span style={{ color: '#ef5350', marginLeft: 8 }}>● {tally.miss} MISS</span>}
            {tally.progress > 0 && <span style={{ color: '#7aa2ff', marginLeft: 8 }}>● {tally.progress} LIVE</span>}
            {tally.push > 0 && <span style={{ color: '#ffb74d', marginLeft: 8 }}>● {tally.push} PUSH</span>}
          </span>
        )}
      </summary>
      <div className="mlb-projection-grid" style={{ marginTop: 8 }}>
        <div className="mlb-stat" title="Independent-leg combined probability. Same-game legs share game-script risk so the true hit rate is typically 5-15% lower.">
          <span className="mlb-stat-label">{isFinal ? 'Final' : isLiveOrFinal ? 'Hit/Legs' : 'Raw hit %'}</span>
          <span className="mlb-stat-value">
            {isLiveOrFinal ? `${tally.hit}/${sgpLegs.length}` : `${combinedHit.toFixed(1)}%`}
          </span>
        </div>
        <div className="mlb-stat">
          <span className="mlb-stat-label">Legs</span>
          <span className="mlb-stat-value">{sgpLegs.length}</span>
        </div>
        <div className="mlb-stat" title="Average per-leg edge%">
          <span className="mlb-stat-label">Avg edge</span>
          <span className="mlb-stat-value">+{avgEdge.toFixed(1)}%</span>
        </div>
      </div>
      <div className="best-pick-legs" style={{ marginTop: 10 }}>
        {graded.map(({ leg: l, current, grade }, i) => (
          <div key={i} className="best-pick-leg-block">
            <div className="best-pick-leg">
              <span className="best-pick-leg-name">{l.playerName}</span>
              <span className="best-pick-leg-stat">
                {l.statLabel} {l.line}
              </span>
              <span className={`best-pick-leg-dir ${l.direction === 'OVER' ? 'over' : 'under'}`}>
                {l.direction === 'OVER' ? '↑' : '↓'} {Math.round(l.probability)}%
              </span>
            </div>
            <div className="best-pick-leg-evbar">
              {l.edgePercent !== undefined && (
                <span
                  className={`best-pick-leg-edge ${(l.edgePercent ?? 0) >= 5 ? 'pos' : 'flat'}`}
                >
                  {(l.edgePercent ?? 0) >= 0 ? '+' : ''}{(l.edgePercent ?? 0).toFixed(0)}% edge
                </span>
              )}
              {l.team && <span className="best-pick-leg-cat">{l.team}</span>}
              {grade !== 'PENDING' && (
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    color:
                      grade === 'HIT' ? '#66bb6a'
                      : grade === 'MISS' ? '#ef5350'
                      : grade === 'PUSH' ? '#ffb74d'
                      : '#7aa2ff',
                  }}
                  title={current !== null ? `Current: ${current}` : 'Game not started'}
                >
                  {grade}{current !== null ? ` · ${current}` : ''}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        {!isLiveOrFinal
          ? '⚠ Same-game legs share game-script risk. Treat the raw hit % as an upper bound.'
          : isFinal
          ? `Final result: ${tally.hit} hit, ${tally.miss} miss${tally.push ? `, ${tally.push} push` : ''}.`
          : `Live: ${tally.hit} legs already cleared, ${tally.miss} dead, ${tally.progress} still live. Auto-refresh every 30s.`}
      </p>
    </details>
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
