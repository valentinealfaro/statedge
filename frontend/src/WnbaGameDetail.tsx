// WNBA game detail page — Phase 75. Mirrors NBA's EspnGameDetail
// since ESPN's basketball boxscore schema is identical between the
// two leagues. Differences from NBA:
//   - Fetches via getWnbaGameSummary
//   - No Same-Game Parlay section yet (lands in Phase 77 with the
//     /wnba/slate builder)
//   - "Full matchup →" link omitted until /wnba/compare ships in
//     Phase 76
//
// Auto-polls every 30s while the game is in progress. Same UX
// contract as NBA + MLB — users feel ONE platform across leagues.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WnbaTeamLogo } from './Avatar';
import {
  getWnbaGameSummary,
  type EspnGameSummary,
  type EspnInjury,
  type EspnPlayerLine,
  type EspnTeamSummary,
} from './api';
import { NavBar } from './NavBar';
import { useTitle } from './useTitle';

export function WnbaGameDetail() {
  const { eventId } = useParams();
  const [data, setData] = useState<EspnGameSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useTitle([
    data ? `${data.away.abbreviation} @ ${data.home.abbreviation}` : 'WNBA Game',
  ]);

  useEffect(() => {
    if (!eventId) return;
    setError(null);
    let cancelled = false;
    getWnbaGameSummary(eventId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [eventId, tick]);

  // Auto-refresh while live — 30s cadence, same as NBA + MLB.
  useEffect(() => {
    if (!data || data.state === 'post') return;
    const pollMs = data.state === 'in' ? 30_000 : 90_000;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, pollMs);
    return () => window.clearInterval(interval);
  }, [data?.state]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ marginBottom: 8 }}>
          <Link to="/wnba/standings" className="muted small">← WNBA standings</Link>
        </div>
        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        {!data && !error && <p className="muted">Loading game details…</p>}

        {data && (
          <>
            <Header data={data} />
            <Linescore data={data} />
            <WinProbability data={data} />
            {data.state === 'pre' ? <PreGameView data={data} /> : <LiveOrFinalView data={data} />}
            <LastFiveGames data={data} />
          </>
        )}
      </div>
    </div>
  );
}

function Header({ data }: { data: EspnGameSummary }) {
  const live = data.state === 'in';
  const final = data.state === 'post';
  return (
    <div className="mlb-projection" style={{ marginBottom: 12 }}>
      <div className="mlb-projection-head" style={{ alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }}>
          <SideRow side={data.away} score={data.totals.away} />
          <SideRow side={data.home} score={data.totals.home} />
        </div>
        <span
          className="mlb-projection-verdict"
          style={live ? { color: '#ef5350', fontWeight: 700 } : final ? { opacity: 0.7 } : {}}
          title={data.statusDetail}
        >
          {live ? '● LIVE' : final ? 'FINAL' : 'TIPOFF'}
        </span>
      </div>
      <div className="mlb-projection-grid" style={{ marginTop: 10 }}>
        <div className="mlb-stat">
          <span className="mlb-stat-label">{data.away.abbreviation}</span>
          <span className="mlb-stat-value">{data.totals.away ?? '—'}</span>
          <span className="mlb-stat-sub">{data.away.record ?? ''}</span>
        </div>
        <div className="mlb-stat">
          <span className="mlb-stat-label">{data.home.abbreviation}</span>
          <span className="mlb-stat-value">{data.totals.home ?? '—'}</span>
          <span className="mlb-stat-sub">{data.home.record ?? ''}</span>
        </div>
        <div className="mlb-stat">
          <span className="mlb-stat-label">Status</span>
          <span className="mlb-stat-value" style={{ fontSize: 14 }}>{data.statusDetail}</span>
        </div>
        {data.venue && (
          <div className="mlb-stat">
            <span className="mlb-stat-label">Venue</span>
            <span className="mlb-stat-value" style={{ fontSize: 13 }}>{data.venue}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function SideRow({ side, score }: { side: EspnTeamSummary; score: number | null }) {
  const won = !!side.isWinner;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <WnbaTeamLogo abbr={side.abbreviation} name={side.displayName} size="lg" />
      <h1 style={{ margin: 0, fontSize: 22, lineHeight: 1.2, fontWeight: won ? 800 : 500 }}>
        {side.displayName}
        <span className="muted small" style={{ marginLeft: 8, fontWeight: 400 }}>
          ({side.record ?? '—'})
        </span>
      </h1>
      <span style={{ marginLeft: 'auto', fontSize: 22, fontWeight: 700, opacity: won ? 1 : 0.7 }}>
        {score ?? '—'}
      </span>
    </div>
  );
}

function Linescore({ data }: { data: EspnGameSummary }) {
  if (data.quarters.length === 0) return null;
  return (
    <details className="mlb-context" open>
      <summary className="mlb-context-heading">Linescore</summary>
      <div className="mlb-game-twocol-scroll" style={{ marginTop: 8 }}>
        <table className="mlb-mini-table">
          <thead>
            <tr>
              <th></th>
              {data.quarters.map((q) => (
                <th key={q.period} className="num">
                  {q.period <= 4 ? `Q${q.period}` : `OT${q.period - 4}`}
                </th>
              ))}
              <th className="num" style={{ paddingLeft: 12, borderLeft: '1px solid var(--border-subtle)' }}>T</th>
            </tr>
          </thead>
          <tbody>
            {(['away', 'home'] as const).map((side) => {
              const teamData = side === 'away' ? data.away : data.home;
              const total = side === 'away' ? data.totals.away : data.totals.home;
              return (
                <tr key={side}>
                  <td><strong>{teamData.abbreviation}</strong></td>
                  {data.quarters.map((q) => {
                    const v = side === 'away' ? q.awayPoints : q.homePoints;
                    return (
                      <td key={q.period} className="num">
                        {v === null || v === undefined ? '—' : v}
                      </td>
                    );
                  })}
                  <td className="num" style={{ fontWeight: 800, paddingLeft: 12, borderLeft: '1px solid var(--border-subtle)' }}>
                    {total ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function WinProbability({ data }: { data: EspnGameSummary }) {
  const history = data.winProbability;
  const predictor = data.predictor;
  const homeAbbr = data.home.abbreviation;
  const awayAbbr = data.away.abbreviation;

  if (history.length === 0) {
    if (predictor.homeWinPct === null && predictor.awayWinPct === null) return null;
    return (
      <details className="mlb-context" open>
        <summary
          className="mlb-context-heading"
          style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}
        >
          <span>Matchup predictor</span>
          <span style={{ display: 'flex', gap: 12, fontSize: 12, fontWeight: 700, letterSpacing: '0.04em' }}>
            <span style={{ color: (predictor.homeWinPct ?? 0) >= (predictor.awayWinPct ?? 0) ? '#66bb6a' : '#7aa2ff' }}>
              {homeAbbr} {predictor.homeWinPct?.toFixed(1) ?? '—'}%
            </span>
            <span style={{ opacity: 0.5 }}>/</span>
            <span style={{ color: (predictor.awayWinPct ?? 0) >= (predictor.homeWinPct ?? 0) ? '#66bb6a' : '#7aa2ff' }}>
              {awayAbbr} {predictor.awayWinPct?.toFixed(1) ?? '—'}%
            </span>
          </span>
        </summary>
        <p className="muted small" style={{ marginTop: 8 }}>
          ESPN's pre-game matchup predictor. Becomes a live rolling chart once tipoff hits.
        </p>
      </details>
    );
  }

  const W = 600;
  const H = 120;
  const PAD_X = 30;
  const PAD_Y = 8;
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_Y * 2;

  const points = history.map((e, i) => {
    const x = PAD_X + (i / Math.max(1, history.length - 1)) * innerW;
    const y = PAD_Y + (1 - e.homeWinPercentage / 100) * innerH;
    return { x, y };
  });
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const midY = PAD_Y + 0.5 * innerH;
  const current = history[history.length - 1]!;

  return (
    <details className="mlb-context" open>
      <summary
        className="mlb-context-heading"
        style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}
      >
        <span>Win probability</span>
        <span style={{ display: 'flex', gap: 12, fontSize: 12, fontWeight: 700, letterSpacing: '0.04em' }}>
          <span style={{ color: current.homeWinPercentage >= current.awayWinPercentage ? '#66bb6a' : '#7aa2ff' }}>
            {homeAbbr} {current.homeWinPercentage.toFixed(1)}%
          </span>
          <span style={{ opacity: 0.5 }}>/</span>
          <span style={{ color: current.awayWinPercentage >= current.homeWinPercentage ? '#66bb6a' : '#7aa2ff' }}>
            {awayAbbr} {current.awayWinPercentage.toFixed(1)}%
          </span>
        </span>
      </summary>
      <div style={{ marginTop: 8, overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block', maxWidth: '100%' }} role="img">
          <line x1={PAD_X} x2={W - PAD_X} y1={midY} y2={midY} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 4" />
          {[0, 25, 50, 75, 100].map((v) => {
            const y = PAD_Y + (1 - v / 100) * innerH;
            return (
              <text key={v} x={PAD_X - 4} y={y + 3} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.45)">
                {v}
              </text>
            );
          })}
          <path d={path} fill="none" stroke="#7aa2ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          {points.length > 0 && (
            <circle cx={points[points.length - 1]!.x} cy={points[points.length - 1]!.y} r="3" fill="#7aa2ff" />
          )}
        </svg>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.45)', padding: `0 ${PAD_X}px` }}>
          <span>{awayAbbr} (top of chart = home favored)</span>
          <span>{homeAbbr}</span>
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        ESPN's per-play win probability — same model their game pages use.
      </p>
    </details>
  );
}

function PreGameView({ data }: { data: EspnGameSummary }) {
  return (
    <>
      <div className="mlb-game-twocol">
        <InjuriesPanel side={data.away} />
        <InjuriesPanel side={data.home} />
      </div>
      <p className="muted small" style={{ textAlign: 'center', marginTop: 16 }}>
        Starting lineups post ~30 min before tipoff.
      </p>
    </>
  );
}

function LiveOrFinalView({ data }: { data: EspnGameSummary }) {
  return (
    <>
      <div className="mlb-game-twocol" style={{ marginBottom: 12 }}>
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
    <details className="mlb-context" open style={{ marginTop: 12 }}>
      <summary className="mlb-context-heading" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <WnbaTeamLogo abbr={side.abbreviation} name={side.displayName} size="md" />
        <span>{side.displayName}</span>
        {side.score && (
          <span className={side.isWinner ? 'pos' : ''} style={{ marginLeft: 'auto', fontWeight: 800 }}>
            {side.score}
          </span>
        )}
      </summary>
      {side.starters.length > 0 && <PlayerTable label="Starters" players={side.starters} />}
      {side.bench.length > 0 && <PlayerTable label="Bench" players={side.bench} />}
      {side.injuries.length > 0 && <InjuriesPanel side={side} compact />}
    </details>
  );
}

function PlayerTable({ label, players }: { label: string; players: EspnPlayerLine[] }) {
  return (
    <>
      <div className="muted small" style={{ marginTop: 8, marginBottom: 4, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 700, fontSize: 11 }}>
        {label}
      </div>
      <div className="mlb-game-twocol-scroll">
        <table className="mlb-mini-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>POS</th>
              <th className="num">MIN</th>
              <th className="num">PTS</th>
              <th className="num">REB</th>
              <th className="num">AST</th>
              <th className="num">STL</th>
              <th className="num">BLK</th>
              <th className="num">TO</th>
              <th>FG</th>
              <th>3P</th>
              <th>FT</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.athleteId}>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {p.headshot ? (
                      <img className="avatar md" src={p.headshot} alt={p.displayName} loading="lazy" />
                    ) : null}
                    <strong>{p.displayName}</strong>
                    {p.didNotPlay && <span className="muted small">(DNP)</span>}
                  </span>
                </td>
                <td>{p.position}</td>
                <td className="num">{p.minutes || (p.didNotPlay ? '—' : 0)}</td>
                <td className="num"><strong>{p.points}</strong></td>
                <td className="num">{p.rebounds}</td>
                <td className="num">{p.assists}</td>
                <td className="num">{p.steals}</td>
                <td className="num">{p.blocks}</td>
                <td className="num">{p.turnovers}</td>
                <td>{p.fg || '—'}</td>
                <td>{p.threePt || '—'}</td>
                <td>{p.ft || '—'}</td>
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
    <div>
      <div className="muted small" style={{ marginBottom: 4 }}>{side.abbreviation} leaders</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {side.leaders.map((l) => (
          <div key={l.category} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            {l.athleteHeadshot && <img className="avatar md" src={l.athleteHeadshot} alt={l.athleteName} loading="lazy" />}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {l.athleteName}
              </div>
              <div className="muted small">{l.displayName}: <strong>{l.value}</strong></div>
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
      <div>
        <div className="muted small" style={{ marginBottom: 4 }}>{side.abbreviation} injury report</div>
        <p className="muted small">No injuries reported.</p>
      </div>
    );
  }
  return (
    <div>
      <div className="muted small" style={{ marginBottom: 4 }}>{side.abbreviation} injury report ({side.injuries.length})</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {side.injuries.map((i) => <InjuryRow key={i.athleteId} injury={i} />)}
      </div>
    </div>
  );
}

function InjuryRow({ injury }: { injury: EspnInjury }) {
  const cls = injury.status.toLowerCase().includes('out') ? '#ef5350'
    : injury.status.toLowerCase().startsWith('day') ? '#ffb74d'
    : 'rgba(255,255,255,0.6)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      {injury.headshot && <img className="avatar md" src={injury.headshot} alt={injury.displayName} loading="lazy" />}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>
          {injury.displayName}{injury.position && ` · ${injury.position}`}
        </div>
        {injury.type && <div className="muted small">{injury.type}</div>}
      </div>
      <span style={{ color: cls, fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {injury.status}
      </span>
    </div>
  );
}

function LastFiveGames({ data }: { data: EspnGameSummary }) {
  const away = data.lastFive.away;
  const home = data.lastFive.home;
  if (away.length === 0 && home.length === 0) return null;

  const Block = ({ side, abbr }: { side: typeof away; abbr: string }) => {
    if (side.length === 0) return null;
    return (
      <div>
        <div className="muted small" style={{ marginBottom: 4 }}>{abbr} last 5</div>
        <div className="mlb-game-twocol-scroll">
          <table className="mlb-mini-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Opp</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {side.map((g, i) => (
                <tr key={`${g.date}-${i}`}>
                  <td>{g.date}</td>
                  <td>{g.atVs === 'vs' ? `vs ${g.opponentAbbr}` : `@ ${g.opponentAbbr}`}</td>
                  <td style={{ color: g.result === 'W' ? 'var(--hot, #66bb6a)' : '#ef5350' }}>
                    <strong>{g.result ?? '—'}</strong> {g.score}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <details className="mlb-context" open>
      <summary className="mlb-context-heading">Last 5 games</summary>
      <div className="mlb-game-twocol">
        <Block side={away} abbr={data.away.abbreviation} />
        <Block side={home} abbr={data.home.abbreviation} />
      </div>
    </details>
  );
}
