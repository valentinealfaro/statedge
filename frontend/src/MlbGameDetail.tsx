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
import {
  getMlbDailySlate,
  getMlbStandings,
  getMlbTeamLast5,
  getMlbToday,
  type MlbDailySlateResponse,
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
      <GameOddsAndPredictor game={game} />
      <ProbablePitchers game={game} />
      <SameGameParlay game={game} />
      <TeamSplits game={game} />
      <LastFiveStrip game={game} />
    </>
  );
}

function GameHeader({ game }: { game: MlbTodayGame }) {
  const live = game.status.inProgress;
  const final = game.status.abstractGameState === 'Final';
  const time = new Date(game.gameDate).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="mlb-projection" style={{ marginBottom: 12 }}>
      <div className="mlb-projection-head" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>
          {game.away.name} ({game.away.record ?? '—'})
          {' @ '}
          {game.home.name} ({game.home.record ?? '—'})
        </h1>
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
          <span className="mlb-stat-sub">{game.away.record ?? ''}</span>
        </div>
        <div className="mlb-stat" title={`${game.home.name} record + score`}>
          <span className="mlb-stat-label">{game.home.abbreviation}</span>
          <span className="mlb-stat-value">{game.home.score ?? '—'}</span>
          <span className="mlb-stat-sub">{game.home.record ?? ''}</span>
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
        Game odds + matchup predictor <span className="muted small">— vegas implied win prob</span>
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
  return (
    <details className="mlb-context" open>
      <summary className="mlb-context-heading">Probable pitchers</summary>
      <div className="mlb-context-grid" style={{ marginTop: 8 }}>
        {a && (
          <div className="mlb-context-chip neutral" title="Away probable starter — season stats">
            <span className="mlb-context-label">{game.away.abbreviation} {a.fullName ?? ''}</span>
            <span className="mlb-context-value" style={{ fontSize: 13 }}>
              {a.wins ?? 0}-{a.losses ?? 0} · {a.era !== null ? `${a.era.toFixed(2)} ERA` : '—'}
              {a.strikeouts !== null && ` · ${a.strikeouts} K`}
            </span>
          </div>
        )}
        {h && (
          <div className="mlb-context-chip neutral" title="Home probable starter — season stats">
            <span className="mlb-context-label">{game.home.abbreviation} {h.fullName ?? ''}</span>
            <span className="mlb-context-value" style={{ fontSize: 13 }}>
              {h.wins ?? 0}-{h.losses ?? 0} · {h.era !== null ? `${h.era.toFixed(2)} ERA` : '—'}
              {h.strikeouts !== null && ` · ${h.strikeouts} K`}
            </span>
          </div>
        )}
      </div>
    </details>
  );
}

function SameGameParlay({ game }: { game: MlbTodayGame }) {
  const [slate, setSlate] = useState<MlbDailySlateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMlbDailySlate()
      .then((d) => { if (!cancelled) setSlate(d); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  // Filter today's slate legs to those whose player team matches one
  // of this game's two teams. We don't have gamePk on stored legs,
  // so team-abbr matching is the proxy.
  const sgpLegs = useMemo(() => {
    if (!slate?.resolved) return [];
    const teamAbbrs = new Set([game.away.abbreviation, game.home.abbreviation]);
    // Pull from the union of all card legs (Best 2-6 + Wild Card).
    const allLegs = new Map<string, NonNullable<typeof slate.resolved.combos[0]['combo']>['legs'][number]>();
    for (const slot of slate.resolved.combos) {
      if (!slot.combo) continue;
      for (const l of slot.combo.legs) {
        const key = `${l.playerId}::${l.statKey}::${l.line}::${l.direction}`;
        if (l.team && teamAbbrs.has(l.team) && !allLegs.has(key)) {
          allLegs.set(key, l);
        }
      }
    }
    if (slate.resolved.wildCard.legs) {
      for (const l of slate.resolved.wildCard.legs) {
        const key = `${l.playerId}::${l.statKey}::${l.line}::${l.direction}`;
        if (l.team && teamAbbrs.has(l.team) && !allLegs.has(key)) {
          allLegs.set(key, l);
        }
      }
    }
    // Top 4 by edge — cap at 4 for SGP correlation tolerance.
    return [...allLegs.values()]
      .sort((a, b) => b.edgePercent - a.edgePercent)
      .slice(0, 4);
  }, [slate, game]);

  const combinedHit = sgpLegs.length > 0
    ? sgpLegs.reduce((p, l) => p * (l.probability / 100), 1) * 100
    : 0;

  return (
    <details className="mlb-context" open>
      <summary className="mlb-context-heading">
        Same-Game Parlay <span className="muted small">— top edge legs from this matchup</span>
      </summary>
      {error && <p className="muted small" style={{ marginTop: 8 }}>{error}</p>}
      {!error && sgpLegs.length === 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          No same-game legs in today's published slate. SGP requires at least one leg with a player from
          {' '}{game.away.abbreviation} or {game.home.abbreviation}.
        </p>
      )}
      {sgpLegs.length > 0 && (
        <>
          <div className="mlb-projection-grid" style={{ marginTop: 8 }}>
            <div className="mlb-stat" title="Independent-leg combined probability. Same-game legs share game-script risk so the true hit rate is typically 5-15% lower.">
              <span className="mlb-stat-label">Raw hit %</span>
              <span className="mlb-stat-value">{combinedHit.toFixed(1)}%</span>
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
            {sgpLegs.map((l, i) => (
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
                  <span className={`best-pick-leg-edge ${l.edgePercent >= 5 ? 'pos' : 'flat'}`}>
                    {l.edgePercent >= 0 ? '+' : ''}{l.edgePercent.toFixed(0)}% edge
                  </span>
                  {l.team && (
                    <span className="best-pick-leg-cat">{l.team}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            ⚠ Same-game legs share game-script risk (one team scoring zero kills offensive overs simultaneously).
            Treat the raw hit % as an upper bound — real correlation-adjusted hit is typically 5-15% lower.
          </p>
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
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table className="mlb-standings-table">
          <thead>
            <tr>
              <th></th>
              <th className="num">{away.abbreviation}</th>
              <th className="num">{home.abbreviation}</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Record"          away={`${away.wins}-${away.losses}`}     home={`${home.wins}-${home.losses}`} />
            <Row label="Win %"           away={away.winPct.toFixed(3)}            home={home.winPct.toFixed(3)} />
            <Row label="Run differential" away={away.runDifferential.toString()}  home={home.runDifferential.toString()} />
            <Row label="Runs / G"        away={away.runsScoredPerGame.toFixed(2)} home={home.runsScoredPerGame.toFixed(2)} />
            <Row label="Runs allowed / G" away={away.runsAllowedPerGame.toFixed(2)} home={home.runsAllowedPerGame.toFixed(2)} />
            <Row label="Starter ERA"     away={away.starterEra !== null ? away.starterEra.toFixed(2) : '—'}
                                          home={home.starterEra !== null ? home.starterEra.toFixed(2) : '—'} />
            <Row label="Bullpen ERA"     away={away.bullpenEra !== null ? away.bullpenEra.toFixed(2) : '—'}
                                          home={home.bullpenEra !== null ? home.bullpenEra.toFixed(2) : '—'} />
            <Row label="Last 10"         away={`${away.last10.wins}-${away.last10.losses}`}
                                          home={`${home.last10.wins}-${home.last10.losses}`} />
          </tbody>
        </table>
      </div>
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
      <div style={{ flex: 1, minWidth: 240 }}>
        <div className="muted small" style={{ marginBottom: 4 }}>{abbr} last 5</div>
        <table className="mlb-standings-table">
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
    );
  };

  return (
    <details className="mlb-context" open>
      <summary className="mlb-context-heading">Last 5 games</summary>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
        <Block data={away} abbr={game.away.abbreviation} />
        <Block data={home} abbr={game.home.abbreviation} />
      </div>
    </details>
  );
}
