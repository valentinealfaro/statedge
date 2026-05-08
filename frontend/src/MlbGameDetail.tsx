// MLB Game Detail page — Phase A.
//
// Reachable from the games rail at /mlb/slate (and elsewhere).
// One-stop view: scores + status, ML odds + implied probabilities,
// probable pitchers with stats, last 5 each team, season team stats,
// and a Same-Game-Parlay built from today's published slate filtered
// to legs in this matchup.
//
// Phase B will add lineups + injury reports + batting/pitching leaders.
// Phase C will poll live play-by-play during in-progress games.

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MlbPlayerAvatar, MlbTeamLogo } from './Avatar';
import {
  getMlbGameLive,
  getMlbGamePreview,
  getMlbGameSgp,
  getMlbStandings,
  getMlbTeamLast5,
  getMlbToday,
  type MlbGamePreview,
  type MlbGameSgp,
  type MlbGameSgpLeg,
  type MlbLiveFeed,
  type MlbLivePlayerStats,
  type MlbStandingRow,
  type MlbTeamLast5,
  type MlbTodayGame,
} from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

export function MlbGameDetail() {
  const { gamePk: gamePkStr } = useParams<{ gamePk: string }>();
  const gamePk = Number(gamePkStr);

  const [game, setGame] = useState<MlbTodayGame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Auto-poll every 60s during live games. Same pattern as the
  // games rail — pause when the tab is hidden.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getMlbToday()
      .then((d) => {
        if (cancelled) return;
        const g = d.games.find((x) => x.gamePk === gamePk);
        if (!g) {
          setError('Game not found in tonight\'s schedule.');
          return;
        }
        setGame(g);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [gamePk, tick]);

  useTitle(
    game ? [`${game.away.abbreviation} @ ${game.home.abbreviation}`] : ['MLB Game'],
  );

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ marginBottom: 8 }}>
          <Link to="/mlb/slate" className="muted small">← Back to slate</Link>
        </div>
        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        {!game && !error && <Skeleton width="100%" height={400} />}
        {game && <GameView game={game} />}
      </div>
    </div>
  );
}

function GameView({ game }: { game: MlbTodayGame }) {
  return (
    <>
      <GameHeader game={game} />
      {/* Live play-by-play floats to the top while the game is in
          progress — that's what users want to see first. Pregame and
          final games don't render anything for this section. */}
      <PlayByPlay game={game} />
      <GameOddsAndPredictor game={game} />
      <ProbablePitchers game={game} />
      <SameGameParlay game={game} />
      <Lineups game={game} />
      <Leaders game={game} />
      <Injuries game={game} />
      <TeamSplits game={game} />
      <LastFiveStrip game={game} />
    </>
  );
}

// Phase B preview hook — single fetch, shared across the three sections
// below so we don't hit /preview three times.
function useGamePreview(gamePk: number): { preview: MlbGamePreview | null; error: string | null } {
  const [preview, setPreview] = useState<MlbGamePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getMlbGamePreview(gamePk)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [gamePk]);
  return { preview, error };
}

function GameHeader({ game }: { game: MlbTodayGame }) {
  const live = game.status.inProgress;
  const final = game.status.abstractGameState === 'Final';
  const time = new Date(game.gameDate).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const awaySplit = game.away.awayRecord;
  const homeSplit = game.home.homeRecord;
  return (
    <div className="mlb-projection" style={{ marginBottom: 12 }}>
      <div className="mlb-projection-head" style={{ alignItems: 'flex-start' }}>
        {/* Two-row stacked matchup header — away on top, home below.
            Avoids the inline @-flow that caused the home team to wrap
            awkwardly on narrower screens. ESPN-style. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <MlbTeamLogo abbr={game.away.abbreviation} name={game.away.name} size="lg" />
            <h1 style={{ margin: 0, fontSize: 22, lineHeight: 1.2 }}>
              {game.away.name}
              <span className="muted small" style={{ marginLeft: 8, fontWeight: 400 }}>
                ({game.away.record ?? '—'}{awaySplit ? `, ${awaySplit} away` : ''})
              </span>
            </h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <MlbTeamLogo abbr={game.home.abbreviation} name={game.home.name} size="lg" />
            <h1 style={{ margin: 0, fontSize: 22, lineHeight: 1.2 }}>
              {game.home.name}
              <span className="muted small" style={{ marginLeft: 8, fontWeight: 400 }}>
                ({game.home.record ?? '—'}{homeSplit ? `, ${homeSplit} home` : ''})
              </span>
            </h1>
          </div>
        </div>
        <span
          className="mlb-projection-verdict"
          style={live ? { color: '#ef5350', fontWeight: 700 } : final ? { opacity: 0.7 } : {}}
          title={game.status.detailedState}
        >
          {live ? '● LIVE' : final ? 'FINAL' : time}
        </span>
      </div>
      <div className="mlb-projection-grid" style={{ marginTop: 10 }}>
        <div className="mlb-stat" title={`${game.away.name} record + score`}>
          <span className="mlb-stat-label">{game.away.abbreviation}</span>
          <span className="mlb-stat-value">{game.away.score ?? '—'}</span>
          <span className="mlb-stat-sub">
            {game.away.record ?? ''}{awaySplit ? ` · ${awaySplit} away` : ''}
          </span>
        </div>
        <div className="mlb-stat" title={`${game.home.name} record + score`}>
          <span className="mlb-stat-label">{game.home.abbreviation}</span>
          <span className="mlb-stat-value">{game.home.score ?? '—'}</span>
          <span className="mlb-stat-sub">
            {game.home.record ?? ''}{homeSplit ? ` · ${homeSplit} home` : ''}
          </span>
        </div>
        <div className="mlb-stat" title={`Status: ${game.status.detailedState}`}>
          <span className="mlb-stat-label">Status</span>
          <span className="mlb-stat-value" style={{ fontSize: 14 }}>{game.status.detailedState}</span>
        </div>
        {game.venue && (
          <div className="mlb-stat" title="Venue">
            <span className="mlb-stat-label">Venue</span>
            <span className="mlb-stat-value" style={{ fontSize: 13 }}>{game.venue}</span>
          </div>
        )}
        {game.weather && (game.weather.temp || game.weather.condition) && (
          <div className="mlb-stat" title={`Weather${game.weather.wind ? ` · wind ${game.weather.wind}` : ''}`}>
            <span className="mlb-stat-label">Weather</span>
            <span className="mlb-stat-value" style={{ fontSize: 14 }}>
              {game.weather.temp ? `${game.weather.temp}°` : ''}
              {game.weather.temp && game.weather.condition ? ' ' : ''}
              {game.weather.condition ?? ''}
            </span>
            {game.weather.wind && (
              <span className="mlb-stat-sub">{game.weather.wind}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function GameOddsAndPredictor({ game }: { game: MlbTodayGame }) {
  if (!game.odds || (game.odds.homeMl === null && game.odds.awayMl === null)) return null;
  const o = game.odds;
  const fmt = (ml: number | null) => ml === null ? '—' : ml > 0 ? `+${ml}` : `${ml}`;
  return (
    <details className="mlb-context" open>
      <summary className="mlb-context-heading">
        Game odds + matchup predictor <span className="muted small">
          — ML: {game.away.abbreviation} {fmt(o.awayMl)} @ {game.home.abbreviation} {fmt(o.homeMl)}
        </span>
      </summary>
      <div className="mlb-context-grid" style={{ marginTop: 8 }}>
        <div className="mlb-context-chip neutral" title="Away moneyline + implied win probability">
          <span className="mlb-context-label">{game.away.abbreviation} ML</span>
          <span className="mlb-context-value">{fmt(o.awayMl)}</span>
        </div>
        <div className="mlb-context-chip neutral" title="Home moneyline + implied win probability">
          <span className="mlb-context-label">{game.home.abbreviation} ML</span>
          <span className="mlb-context-value">{fmt(o.homeMl)}</span>
        </div>
        <div
          className={`mlb-context-chip ${(o.awayImpliedWinProb ?? 0) > (o.homeImpliedWinProb ?? 0) ? 'positive' : 'neutral'}`}
          title="Sportsbook-implied probability that the away team wins"
        >
          <span className="mlb-context-label">{game.away.abbreviation} Win %</span>
          <span className="mlb-context-value">
            {o.awayImpliedWinProb !== null ? `${o.awayImpliedWinProb.toFixed(1)}%` : '—'}
          </span>
        </div>
        <div
          className={`mlb-context-chip ${(o.homeImpliedWinProb ?? 0) > (o.awayImpliedWinProb ?? 0) ? 'positive' : 'neutral'}`}
          title="Sportsbook-implied probability that the home team wins"
        >
          <span className="mlb-context-label">{game.home.abbreviation} Win %</span>
          <span className="mlb-context-value">
            {o.homeImpliedWinProb !== null ? `${o.homeImpliedWinProb.toFixed(1)}%` : '—'}
          </span>
        </div>
      </div>
      {o.provider && (
        <p className="muted small" style={{ marginTop: 6 }}>
          Source: {o.provider}
        </p>
      )}
    </details>
  );
}

function ProbablePitchers({ game }: { game: MlbTodayGame }) {
  const a = game.probablePitchers.away;
  const h = game.probablePitchers.home;
  if (!a && !h) return null;
  const Pitcher = ({
    p, team,
  }: {
    p: NonNullable<MlbTodayGame['probablePitchers']['home']>;
    team: string;
  }) => (
    <div className="mlb-context-chip neutral" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px' }}>
      <MlbPlayerAvatar playerId={p.id} name={p.fullName ?? 'Pitcher'} size="lg" />
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="mlb-context-label">{team} {p.fullName ?? ''}</span>
        <span className="mlb-context-value" style={{ fontSize: 13 }}>
          {p.wins ?? 0}-{p.losses ?? 0} · {p.era !== null ? `${p.era.toFixed(2)} ERA` : '—'}
          {p.strikeouts !== null && ` · ${p.strikeouts} K`}
        </span>
      </div>
    </div>
  );
  return (
    <details className="mlb-context" open>
      <summary className="mlb-context-heading">Probable pitchers</summary>
      <div className="mlb-context-grid" style={{ marginTop: 8 }}>
        {a && <Pitcher p={a} team={game.away.abbreviation} />}
        {h && <Pitcher p={h} team={game.home.abbreviation} />}
      </div>
    </details>
  );
}

// Map slate stat keys to live boxscore fields. Keep in sync with the
// statKey vocabulary the slate uses (see backend/src/mlb/stats.ts).
function liveValueForStat(stats: MlbLivePlayerStats, statKey: string): number | null {
  switch (statKey) {
    case 'hits':                return stats.hits;
    case 'total_bases':         return stats.totalBases;
    case 'runs':                return stats.runs;
    case 'rbis':                return stats.rbis;
    case 'walks':               return stats.walks;
    case 'strikeouts':          return stats.strikeouts;
    case 'home_runs':           return stats.homeRuns;
    case 'doubles':             return stats.doubles;
    case 'triples':             return stats.triples;
    case 'stolen_bases':        return stats.stolenBases;
    case 'hit_by_pitch':        return stats.hitByPitch;
    case 'hits_runs_rbis': {
      // Combo: only definitive when all three components are loaded.
      const h = stats.hits;
      const r = stats.runs;
      const ri = stats.rbis;
      if (h === null && r === null && ri === null) return null;
      return (h ?? 0) + (r ?? 0) + (ri ?? 0);
    }
    case 'pitcher_strikeouts':  return stats.pitcherStrikeouts;
    case 'hits_allowed':        return stats.hitsAllowed;
    case 'earned_runs_allowed': return stats.earnedRunsAllowed;
    case 'walks_allowed':       return stats.walksAllowed;
    case 'outs_recorded':       return stats.outsRecorded;
    case 'home_runs_allowed':   return stats.homeRunsAllowed;
    case 'pitching_outs':       return stats.outsRecorded;
    default:                    return null;
  }
}

type LegGrade = 'HIT' | 'MISS' | 'PROGRESS' | 'PUSH' | 'PENDING';

function gradeLeg(
  direction: 'OVER' | 'UNDER',
  line: number,
  current: number | null,
  isFinal: boolean,
): LegGrade {
  if (current === null) return 'PENDING';
  if (direction === 'OVER') {
    if (current > line) return 'HIT';
    if (isFinal) return current === line ? 'PUSH' : 'MISS';
    return 'PROGRESS';
  }
  // UNDER
  if (current > line) return 'MISS';
  if (isFinal) return current === line ? 'PUSH' : 'HIT';
  return 'PROGRESS';
}

function SameGameParlay({ game }: { game: MlbTodayGame }) {
  const [sgp, setSgp] = useState<MlbGameSgp | null>(null);
  const [live, setLive] = useState<MlbLiveFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Dedicated per-game SGP endpoint. Resolves every line from this
  // matchup (50-150 typical) and returns the top 10 by edge%, NOT
  // just the legs that made it onto the diversified Best cards.
  // This is the fix for "no same-game legs" — Phase 58 intentionally
  // rotates players across cards so most matchups contribute 0-2
  // legs to the union of cards. SGP needs a deeper view.
  useEffect(() => {
    let cancelled = false;
    getMlbGameSgp(game.gamePk)
      .then((d) => { if (!cancelled) setSgp(d); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [game.gamePk]);

  // Pull live feed for grading. Re-poll every 30s when game is live;
  // pregame/final fetches once.
  useEffect(() => {
    let cancelled = false;
    getMlbGameLive(game.gamePk)
      .then((f) => { if (!cancelled) setLive(f); })
      .catch(() => { /* silent — pregame/final still grade fine */ });
    return () => { cancelled = true; };
  }, [game.gamePk, tick]);

  useEffect(() => {
    if (live?.state !== 'live') return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [live?.state]);

  // Top 4 legs by edge from this matchup's pool. The endpoint already
  // sorts by edge% and dedupes by player, so we just slice.
  const sgpLegs = useMemo<MlbGameSgpLeg[]>(() => {
    return (sgp?.legs ?? []).slice(0, 4);
  }, [sgp]);

  const combinedHit = sgpLegs.length > 0
    ? sgpLegs.reduce((p, l) => p * (l.probability / 100), 1) * 100
    : 0;

  const isLiveOrFinal = live?.state === 'live' || live?.state === 'final';
  const isFinal = live?.state === 'final';
  const graded = sgpLegs.map((l) => {
    if (!isLiveOrFinal || !live) {
      return { leg: l, current: null as number | null, grade: 'PENDING' as LegGrade };
    }
    const ps = live.playerStats[String(l.playerId)] ?? null;
    if (!ps) return { leg: l, current: null, grade: 'PENDING' as LegGrade };
    const current = liveValueForStat(ps, l.statKey);
    return { leg: l, current, grade: gradeLeg(l.direction, l.line, current, isFinal) };
  });
  const tally = {
    hit: graded.filter((g) => g.grade === 'HIT').length,
    miss: graded.filter((g) => g.grade === 'MISS').length,
    progress: graded.filter((g) => g.grade === 'PROGRESS').length,
    push: graded.filter((g) => g.grade === 'PUSH').length,
    pending: graded.filter((g) => g.grade === 'PENDING').length,
  };

  return (
    <details className="mlb-context" open>
      <summary className="mlb-context-heading">
        Same-Game Parlay <span className="muted small">— top edge legs from this matchup</span>
        {isLiveOrFinal && sgpLegs.length > 0 && (
          <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em' }}>
            <span style={{ color: '#66bb6a' }}>● {tally.hit} HIT</span>
            {tally.miss > 0 && <span style={{ color: '#ef5350', marginLeft: 8 }}>● {tally.miss} MISS</span>}
            {tally.progress > 0 && <span style={{ color: '#7aa2ff', marginLeft: 8 }}>● {tally.progress} LIVE</span>}
            {tally.push > 0 && <span style={{ color: '#ffb74d', marginLeft: 8 }}>● {tally.push} PUSH</span>}
          </span>
        )}
      </summary>
      {error && <p className="muted small" style={{ marginTop: 8 }}>{error}</p>}
      {!error && sgp && sgpLegs.length === 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          {sgp.reason ?? `No projected legs for ${game.away.abbreviation} @ ${game.home.abbreviation} in today's slate yet.`}
        </p>
      )}
      {sgpLegs.length > 0 && (
        <>
          <div className="mlb-projection-grid" style={{ marginTop: 8 }}>
            <div className="mlb-stat" title="Independent-leg combined probability. Same-game legs share game-script risk so the true hit rate is typically 5-15% lower.">
              <span className="mlb-stat-label">{isFinal ? 'Final hit rate' : isLiveOrFinal ? 'Live hit/legs' : 'Raw hit %'}</span>
              <span className="mlb-stat-value">
                {isLiveOrFinal
                  ? `${tally.hit}/${sgpLegs.length}`
                  : `${combinedHit.toFixed(1)}%`}
              </span>
            </div>
            <div className="mlb-stat">
              <span className="mlb-stat-label">Legs</span>
              <span className="mlb-stat-value">{sgpLegs.length}</span>
            </div>
            <div className="mlb-stat" title="Average per-leg edge%">
              <span className="mlb-stat-label">Avg edge</span>
              <span className="mlb-stat-value">
                +{(sgpLegs.reduce((s, l) => s + l.edgePercent, 0) / sgpLegs.length).toFixed(1)}%
              </span>
            </div>
          </div>
          <div className="best-pick-legs" style={{ marginTop: 10 }}>
            {graded.map(({ leg: l, current, grade }, i) => (
              <div key={i} className="best-pick-leg-block">
                <div className="best-pick-leg">
                  <span className="best-pick-leg-name" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <MlbPlayerAvatar playerId={l.playerId} name={l.playerName} size="md" />
                    {l.playerName}
                  </span>
                  <span className="best-pick-leg-stat">
                    {l.statLabel} {l.line}
                  </span>
                  <span className={`best-pick-leg-dir ${l.direction === 'OVER' ? 'over' : 'under'}`}>
                    {l.direction === 'OVER' ? '↑' : '↓'} {Math.round(l.probability)}%
                  </span>
                </div>
                <div className="best-pick-leg-evbar">
                  <span className={`best-pick-leg-edge ${l.edgePercent >= 5 ? 'pos' : 'flat'}`}>
                    {l.edgePercent >= 0 ? '+' : ''}{l.edgePercent.toFixed(0)}% edge
                  </span>
                  {l.team && (
                    <span className="best-pick-leg-cat">{l.team}</span>
                  )}
                  {isLiveOrFinal && (
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
                      title={current !== null ? `Current: ${current}` : 'No live stats yet'}
                    >
                      {grade}{current !== null ? ` · ${current}` : ''}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {!isLiveOrFinal && (
            <p className="muted small" style={{ marginTop: 8 }}>
              ⚠ Same-game legs share game-script risk (one team scoring zero kills offensive overs simultaneously).
              Treat the raw hit % as an upper bound — real correlation-adjusted hit is typically 5-15% lower.
            </p>
          )}
          {isLiveOrFinal && (
            <p className="muted small" style={{ marginTop: 8 }}>
              {isFinal
                ? `Final result: ${tally.hit} hit, ${tally.miss} miss${tally.push ? `, ${tally.push} push` : ''}.`
                : `Live: ${tally.hit} legs already cleared, ${tally.miss} dead, ${tally.progress} still live. Auto-refresh every 30s.`}
            </p>
          )}
        </>
      )}
    </details>
  );
}

function TeamSplits({ game }: { game: MlbTodayGame }) {
  const [standings, setStandings] = useState<MlbStandingRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMlbStandings()
      .then((d) => { if (!cancelled) setStandings(d.teams); })
      .catch(() => { /* silent — we render '—' below */ });
    return () => { cancelled = true; };
  }, []);

  if (!standings) return null;
  const away = standings.find((t) => t.abbreviation === game.away.abbreviation);
  const home = standings.find((t) => t.abbreviation === game.home.abbreviation);
  if (!away || !home) return null;

  const Row = ({ label, away: a, home: h, hint }: {
    label: string;
    away: string | number;
    home: string | number;
    hint?: string;
  }) => (
    <tr title={hint}>
      <td>{label}</td>
      <td className="num"><strong>{a}</strong></td>
      <td className="num"><strong>{h}</strong></td>
    </tr>
  );

  return (
    <details className="mlb-context" open>
      <summary className="mlb-context-heading">Team season splits</summary>
      <table className="mlb-mini-table" style={{ marginTop: 8, maxWidth: 480 }}>
        <thead>
          <tr>
            <th></th>
            <th className="num">{away.abbreviation}</th>
            <th className="num">{home.abbreviation}</th>
          </tr>
        </thead>
        <tbody>
          <Row label="Record"           away={`${away.wins}-${away.losses}`}     home={`${home.wins}-${home.losses}`} />
          <Row label="Win %"            away={away.winPct.toFixed(3)}            home={home.winPct.toFixed(3)} />
          <Row label="Run diff"         away={away.runDifferential.toString()}   home={home.runDifferential.toString()} />
          <Row label="Runs / G"         away={away.runsScoredPerGame.toFixed(2)} home={home.runsScoredPerGame.toFixed(2)} />
          <Row label="RA / G"           away={away.runsAllowedPerGame.toFixed(2)} home={home.runsAllowedPerGame.toFixed(2)} />
          <Row label="Starter ERA"      away={away.starterEra !== null ? away.starterEra.toFixed(2) : '—'}
                                         home={home.starterEra !== null ? home.starterEra.toFixed(2) : '—'} />
          <Row label="Bullpen ERA"      away={away.bullpenEra !== null ? away.bullpenEra.toFixed(2) : '—'}
                                         home={home.bullpenEra !== null ? home.bullpenEra.toFixed(2) : '—'} />
          <Row label="Last 10"          away={`${away.last10.wins}-${away.last10.losses}`}
                                         home={`${home.last10.wins}-${home.last10.losses}`} />
        </tbody>
      </table>
    </details>
  );
}

function LastFiveStrip({ game }: { game: MlbTodayGame }) {
  const [away, setAway] = useState<MlbTeamLast5 | null>(null);
  const [home, setHome] = useState<MlbTeamLast5 | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMlbTeamLast5(game.away.id)
      .then((d) => { if (!cancelled) setAway(d); })
      .catch(() => { /* silent */ });
    getMlbTeamLast5(game.home.id)
      .then((d) => { if (!cancelled) setHome(d); })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [game.away.id, game.home.id]);

  if (!away && !home) return null;

  const Block = ({ data, abbr }: { data: MlbTeamLast5 | null; abbr: string }) => {
    if (!data) return null;
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
              {data.games.map((g) => (
                <tr key={g.gameId}>
                  <td>{g.date}</td>
                  <td>{g.isHome ? `vs ${g.opponent ?? '—'}` : `@${g.opponent ?? '—'}`}</td>
                  <td style={{ color: g.result === 'W' ? 'var(--hot, #66bb6a)' : '#ef5350' }}>
                    <strong>{g.result}</strong> {g.score}
                  </td>
                </tr>
              ))}
              {data.games.length === 0 && <tr><td colSpan={3} className="muted small">No completed games yet.</td></tr>}
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
        <Block data={away} abbr={game.away.abbreviation} />
        <Block data={home} abbr={game.home.abbreviation} />
      </div>
    </details>
  );
}

function Lineups({ game }: { game: MlbTodayGame }) {
  const { preview, error } = useGamePreview(game.gamePk);
  if (error) return null;
  const away = preview?.lineups.away ?? null;
  const home = preview?.lineups.home ?? null;
  const empty = (!away || away.length === 0) && (!home || home.length === 0);

  const Side = ({ side, abbr }: { side: typeof away; abbr: string }) => {
    if (!side || side.length === 0) {
      return (
        <div>
          <div className="muted small" style={{ marginBottom: 4 }}>{abbr} lineup</div>
          <p className="muted small">Lineup not posted yet (typically ~2h before first pitch).</p>
        </div>
      );
    }
    return (
      <div>
        <div className="muted small" style={{ marginBottom: 4 }}>{abbr} lineup</div>
        <div className="mlb-game-twocol-scroll">
          <table className="mlb-mini-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Pos</th>
                <th className="num" title="Season batting average">AVG</th>
                <th className="num" title="Season home runs">HR</th>
                <th className="num" title="Career H-AB vs tonight's opposing starter">vs Pit</th>
                <th className="num" title="Career batting average vs tonight's opposing starter — same matchup data ESPN shows + a key input to our projection engine">vs AVG</th>
                <th className="num" title="Career strikeouts vs tonight's opposing starter">vs K</th>
              </tr>
            </thead>
            <tbody>
              {side.map((b) => (
                <tr key={b.playerId}>
                  <td>{b.battingOrder || '—'}</td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <MlbPlayerAvatar playerId={b.playerId} name={b.name} size="md" />
                      <strong>{b.name}</strong>
                    </span>
                  </td>
                  <td>{b.position}</td>
                  <td className="num">{b.avg ?? '—'}</td>
                  <td className="num">{b.hr ?? '—'}</td>
                  <td className="num" title={b.vsPitcher ? `${b.vsPitcher.plateAppearances} PA · ${b.vsPitcher.reliability}` : 'No career history vs this pitcher'}>
                    {b.vsPitcher
                      ? `${b.vsPitcher.hits}-${b.vsPitcher.atBats}`
                      : <span style={{ opacity: 0.4 }}>—</span>}
                  </td>
                  <td
                    className="num"
                    style={{
                      color: b.vsPitcher && b.vsPitcher.atBats >= 10
                        ? (b.vsPitcher.hits / b.vsPitcher.atBats >= 0.300 ? '#66bb6a'
                          : b.vsPitcher.hits / b.vsPitcher.atBats <= 0.200 ? '#ef5350' : undefined)
                        : undefined,
                      fontWeight: b.vsPitcher && b.vsPitcher.atBats >= 10 ? 700 : undefined,
                    }}
                  >
                    {b.vsPitcher
                      ? b.vsPitcher.avg
                      : <span style={{ opacity: 0.4 }}>—</span>}
                  </td>
                  <td className="num">
                    {b.vsPitcher
                      ? b.vsPitcher.strikeOuts
                      : <span style={{ opacity: 0.4 }}>—</span>}
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
    <details className="mlb-context" open={!empty}>
      <summary className="mlb-context-heading">
        Lineups <span className="muted small">— posted batting orders + career stats vs tonight's opposing starter</span>
      </summary>
      <div className="mlb-game-twocol">
        <Side side={away} abbr={game.away.abbreviation} />
        <Side side={home} abbr={game.home.abbreviation} />
      </div>
    </details>
  );
}

function Leaders({ game }: { game: MlbTodayGame }) {
  const { preview } = useGamePreview(game.gamePk);
  if (!preview) return null;

  const Side = ({
    side,
    abbr,
  }: {
    side: MlbGamePreview['leaders']['away'];
    abbr: string;
  }) => {
    const empty =
      side.hittingAvg.length === 0 &&
      side.hittingHr.length === 0 &&
      side.pitchingEra.length === 0;
    if (empty) {
      return (
        <div>
          <div className="muted small" style={{ marginBottom: 4 }}>{abbr} leaders</div>
          <p className="muted small">Not enough sample yet (need 80 PA / 90 outs).</p>
        </div>
      );
    }
    return (
      <div>
        <div className="muted small" style={{ marginBottom: 4 }}>{abbr} leaders</div>
        {side.hittingAvg.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#7aa2ff', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Top hitters · AVG</div>
            {side.hittingAvg.map((l) => (
              <div key={`avg-${l.playerId}`} className="best-pick-leg">
                <span className="best-pick-leg-name" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <MlbPlayerAvatar playerId={l.playerId} name={l.name} size="md" />
                  {l.name}
                </span>
                <span className="best-pick-leg-stat">{l.value} <span className="muted small">({l.context})</span></span>
              </div>
            ))}
          </div>
        )}
        {side.hittingHr.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#7aa2ff', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Power · HR</div>
            {side.hittingHr.map((l) => (
              <div key={`hr-${l.playerId}`} className="best-pick-leg">
                <span className="best-pick-leg-name" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <MlbPlayerAvatar playerId={l.playerId} name={l.name} size="md" />
                  {l.name}
                </span>
                <span className="best-pick-leg-stat">{l.value} HR <span className="muted small">({l.context})</span></span>
              </div>
            ))}
          </div>
        )}
        {side.pitchingEra.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#7aa2ff', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Starting rotation · ERA</div>
            {side.pitchingEra.map((l) => (
              <div key={`era-${l.playerId}`} className="best-pick-leg">
                <span className="best-pick-leg-name" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <MlbPlayerAvatar playerId={l.playerId} name={l.name} size="md" />
                  {l.name}
                </span>
                <span className="best-pick-leg-stat">{l.value} ERA <span className="muted small">({l.context})</span></span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <details className="mlb-context" open>
      <summary className="mlb-context-heading">
        Team leaders <span className="muted small">— top performers this season</span>
      </summary>
      <div className="mlb-game-twocol">
        <Side side={preview.leaders.away} abbr={game.away.abbreviation} />
        <Side side={preview.leaders.home} abbr={game.home.abbreviation} />
      </div>
    </details>
  );
}

function PlayByPlay({ game }: { game: MlbTodayGame }) {
  const [feed, setFeed] = useState<MlbLiveFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Poll every 15s while live, every 60s while pregame/final. We
  // still poll pregame in case the game starts; once it's final we
  // back off but keep the last snapshot rendered. Pause when the
  // tab is hidden — saves bandwidth and avoids stale UI.
  useEffect(() => {
    let cancelled = false;
    getMlbGameLive(game.gamePk)
      .then((f) => { if (!cancelled) setFeed(f); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [game.gamePk, tick]);

  useEffect(() => {
    const live = feed?.state === 'live';
    const pollMs = live ? 15_000 : 60_000;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, pollMs);
    return () => window.clearInterval(interval);
  }, [feed?.state]);

  if (error) return null;
  if (!feed) return null;
  // Don't render anything pre-game — the rest of the page (pitchers,
  // lineups, leaders) is the pregame story. Once the game starts,
  // this section pops to the top.
  if (feed.state === 'pregame') return null;

  const live = feed.state === 'live';

  return (
    <details className="mlb-context" open>
      <summary className="mlb-context-heading">
        Play-by-play
        {live && (
          <span style={{ marginLeft: 10, color: '#ef5350', fontWeight: 700, fontSize: 12, letterSpacing: '0.04em' }}>
            ● LIVE
          </span>
        )}
        {live && <span className="muted small"> · auto-refresh 15s</span>}
        {feed.state === 'final' && <span className="muted small"> · final</span>}
      </summary>

      {live && (
        <div className="mlb-projection-grid" style={{ marginTop: 8 }}>
          <div className="mlb-stat" title="Current inning">
            <span className="mlb-stat-label">Inning</span>
            <span className="mlb-stat-value">
              {feed.inning.half === 'Top' ? '▲' : feed.inning.half === 'Bottom' ? '▼' : ''}
              {' '}{feed.inning.ordinal ?? feed.inning.number ?? '—'}
            </span>
          </div>
          <div className="mlb-stat" title="Outs in current half-inning">
            <span className="mlb-stat-label">Outs</span>
            <span className="mlb-stat-value">{feed.count.outs ?? '—'}</span>
          </div>
          <div className="mlb-stat" title="Ball-strike count for the at-bat">
            <span className="mlb-stat-label">Count</span>
            <span className="mlb-stat-value">
              {feed.count.balls ?? 0}-{feed.count.strikes ?? 0}
            </span>
          </div>
          <div className="mlb-stat" title="Score">
            <span className="mlb-stat-label">Score</span>
            <span className="mlb-stat-value">
              {game.away.abbreviation} {feed.score.away ?? 0} · {feed.score.home ?? 0} {game.home.abbreviation}
            </span>
          </div>
        </div>
      )}

      {live && (feed.atBat.batter || feed.atBat.pitcher || feed.runners.first || feed.runners.second || feed.runners.third) && (
        <div style={{ marginTop: 8, padding: 8, background: 'rgba(122, 162, 255, 0.06)', borderRadius: 4 }}>
          {feed.atBat.batter && (
            <div style={{ fontSize: 13 }}>
              <strong>At bat:</strong> {feed.atBat.batter}
              {feed.atBat.pitcher && <span className="muted small"> · vs {feed.atBat.pitcher}</span>}
            </div>
          )}
          <div className="muted small" style={{ marginTop: 4 }}>
            Runners: {[
              feed.runners.first  ? `1B ${feed.runners.first}` : null,
              feed.runners.second ? `2B ${feed.runners.second}` : null,
              feed.runners.third  ? `3B ${feed.runners.third}` : null,
            ].filter(Boolean).join(' · ') || 'bases empty'}
          </div>
        </div>
      )}

      {feed.recentPlays.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="muted small" style={{ marginBottom: 4 }}>Recent plays</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {feed.recentPlays.map((p, i) => (
              <div
                key={p.atBatIndex ?? i}
                style={{
                  padding: 8,
                  borderLeft: p.isScoringPlay ? '3px solid #66bb6a' : '3px solid rgba(122, 162, 255, 0.3)',
                  background: p.isScoringPlay ? 'rgba(102, 187, 106, 0.08)' : 'transparent',
                  borderRadius: 2,
                }}
              >
                <div style={{ fontSize: 11, color: '#7aa2ff', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 2 }}>
                  {p.halfInning === 'top' ? '▲' : '▼'} {p.inning ?? ''}
                  {p.batter && ` · ${p.batter}`}
                  {p.isScoringPlay && <span style={{ color: '#66bb6a', marginLeft: 6 }}>SCORE</span>}
                </div>
                <div style={{ fontSize: 13 }}>{p.description}</div>
                {(p.awayScore !== null || p.homeScore !== null) && (
                  <div className="muted small" style={{ marginTop: 2 }}>
                    {game.away.abbreviation} {p.awayScore ?? 0} · {p.homeScore ?? 0} {game.home.abbreviation}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {feed.recentPlays.length === 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>No plays recorded yet.</p>
      )}
    </details>
  );
}

function Injuries({ game }: { game: MlbTodayGame }) {
  const { preview } = useGamePreview(game.gamePk);
  if (!preview) return null;
  const away = preview.injuries.away;
  const home = preview.injuries.home;
  if (away.length === 0 && home.length === 0) return null;

  const Side = ({ side, abbr }: { side: typeof away; abbr: string }) => (
    <div>
      <div className="muted small" style={{ marginBottom: 4 }}>{abbr} injured list ({side.length})</div>
      {side.length === 0 ? (
        <p className="muted small">No players on IL.</p>
      ) : (
        <div className="mlb-game-twocol-scroll">
          <table className="mlb-mini-table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Pos</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {side.map((p) => (
                <tr key={p.playerId}>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <MlbPlayerAvatar playerId={p.playerId} name={p.name} size="md" />
                      {p.name}
                    </span>
                  </td>
                  <td>{p.position ?? '—'}</td>
                  <td className="muted small">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <details className="mlb-context">
      <summary className="mlb-context-heading">
        Injury report <span className="muted small">— current IL ({away.length + home.length} players)</span>
      </summary>
      <div className="mlb-game-twocol">
        <Side side={away} abbr={game.away.abbreviation} />
        <Side side={home} abbr={game.home.abbreviation} />
      </div>
    </details>
  );
}
