// Tonight's MLB games rail — sits at the top of /mlb/compare.
// Pulls from /api/mlb/today which combines:
//   - statsapi.mlb.com schedule + probable pitcher + season stats
//   - ESPN public scoreboard for moneyline odds + implied win prob
//
// Mission framing: ML odds shown as IMPLIED WIN PROBABILITY (the
// institutional way), with the raw American odds available on hover.
// "Vegas implied: HOU 47% / CIN 53%" — context signal for users to
// see sportsbook consensus alongside the model's projections.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MlbPlayerAvatar, MlbTeamLogo } from './Avatar';
import { getMlbToday, type MlbTodayGame, type MlbTodayResponse } from './api';

export function MlbTodaysGames() {
  const [data, setData] = useState<MlbTodayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Initial load + 60-second poll while the tab is visible. Pulls
  // fresh game state (scores, status, in-progress innings) so the
  // strip becomes a live tracker once games start. When games are
  // all Final or all Pregame, the poll is wasted but cheap; when
  // games are live, this is the engagement surface.
  useEffect(() => {
    let alive = true;
    getMlbToday()
      .then((d) => { if (alive) setData(d); })
      .catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [tick]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      // Skip the poll when the tab is hidden — saves bandwidth and
      // doesn't let stale state stack up.
      if (document.visibilityState === 'visible') {
        setTick((t) => t + 1);
      }
    }, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  if (error) return null;                  // silent on error
  if (!data || data.games.length === 0) return null;
  // Show "● LIVE" indicator when any game is in progress.
  const anyLive = data.games.some((g) => g.status.inProgress);

  return (
    <section className="mlb-today">
      <div className="mlb-today-head">
        <h2 className="mlb-today-heading">
          Tonight's MLB games
          {anyLive && (
            <span style={{ marginLeft: 10, color: '#ef5350', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em' }}>
              ● LIVE
            </span>
          )}
        </h2>
        <span className="muted small">
          {data.games.length} game{data.games.length === 1 ? '' : 's'} · {data.date}
          {anyLive && <> · auto-refresh 60s</>}
        </span>
      </div>
      <div className="mlb-today-grid">
        {data.games.map((g) => <GameCard key={g.gamePk} game={g} />)}
      </div>
    </section>
  );
}

function GameCard({ game }: { game: MlbTodayGame }) {
  const isPregame = game.status.abstractGameState === 'Preview';
  const isLive = game.status.inProgress;
  const isFinal = game.status.abstractGameState === 'Final';
  // Pre-game: show ACTUAL first-pitch time, not "Pre-Game" string.
  // Live: show inning/clock from detailedState (e.g. "Top 5th").
  // Final: show "Final".
  const startTime = (() => {
    try {
      return new Date(game.gameDate).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return null;
    }
  })();
  const statusLabel = isPregame
    ? (startTime ?? game.status.detailedState)
    : game.status.detailedState;

  return (
    <Link
      to={`/mlb/game/${game.gamePk}`}
      className={`mlb-today-game ${isLive ? 'live' : ''} ${isFinal ? 'final' : ''}`}
      style={{ textDecoration: 'none', color: 'inherit', display: 'block', cursor: 'pointer' }}
    >
      <div className="mlb-today-game-status">{statusLabel}</div>

      <div className="mlb-today-row">
        <span className="mlb-today-team" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <MlbTeamLogo abbr={game.away.abbreviation} name={game.away.name} size="md" />
          <strong>{game.away.abbreviation}</strong>
          {game.away.record && (
            <span className="muted small">
              {' '}{game.away.record}
              {game.away.awayRecord && <>, {game.away.awayRecord} away</>}
            </span>
          )}
        </span>
        <span className="mlb-today-score">{game.away.score ?? '—'}</span>
      </div>
      <div className="mlb-today-row">
        <span className="mlb-today-team" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <MlbTeamLogo abbr={game.home.abbreviation} name={game.home.name} size="md" />
          <strong>{game.home.abbreviation}</strong>
          {game.home.record && (
            <span className="muted small">
              {' '}{game.home.record}
              {game.home.homeRecord && <>, {game.home.homeRecord} home</>}
            </span>
          )}
          <span className="mlb-today-home-mark"> · home</span>
        </span>
        <span className="mlb-today-score">{game.home.score ?? '—'}</span>
      </div>

      {/* Both moneylines + implied probabilities. Raw American odds
          are the institutional way to read the line; implied % is
          a derived companion. */}
      {isPregame && game.odds && (game.odds.homeMl !== null || game.odds.awayMl !== null) && (
        <div className="mlb-today-odds"
             title={`Moneyline via ${game.odds.provider ?? 'ESPN'}. Implied = sportsbook consensus, NOT StatEdge's model.`}>
          <span className="mlb-today-odds-label">ML</span>
          <span className="mlb-today-odds-prob">
            {game.away.abbreviation} {formatMl(game.odds.awayMl)}
            {' @ '}
            {game.home.abbreviation} {formatMl(game.odds.homeMl)}
            {(game.odds.awayImpliedWinProb !== null || game.odds.homeImpliedWinProb !== null) && (
              <span className="muted small" style={{ marginLeft: 6 }}>
                ({fmtPct(game.odds.awayImpliedWinProb)} / {fmtPct(game.odds.homeImpliedWinProb)})
              </span>
            )}
          </span>
        </div>
      )}

      {/* Weather (when MLB API ships it — outdoor parks have it,
          domes typically don't or report "Roof Closed"). */}
      {game.weather && (game.weather.temp || game.weather.condition) && (
        <div className="muted small" style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {game.weather.temp && <span><strong>{game.weather.temp}°</strong></span>}
          {game.weather.condition && <span>{game.weather.condition}</span>}
          {game.weather.wind && <span>· {game.weather.wind}</span>}
        </div>
      )}

      {/* Probable pitchers */}
      {(game.probablePitchers.away || game.probablePitchers.home) && (
        <div className="mlb-today-pitchers">
          {game.probablePitchers.away && (
            <PitcherLine pitcher={game.probablePitchers.away} team={game.away.abbreviation} />
          )}
          {game.probablePitchers.home && (
            <PitcherLine pitcher={game.probablePitchers.home} team={game.home.abbreviation} />
          )}
        </div>
      )}

      {game.venue && <div className="mlb-today-venue">{game.venue}</div>}

      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          color: '#7aa2ff',
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        View matchup · same-game parlay →
      </div>
    </Link>
  );
}

function PitcherLine({
  pitcher,
  team,
}: {
  pitcher: NonNullable<MlbTodayGame['probablePitchers']['home']>;
  team: string;
}) {
  const record = pitcher.wins !== null && pitcher.losses !== null
    ? `${pitcher.wins}-${pitcher.losses}`
    : null;
  return (
    <div className="mlb-today-pitcher" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <MlbPlayerAvatar playerId={pitcher.id} name={pitcher.fullName} size="md" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <span className="mlb-today-pitcher-team muted small">{team}</span>
          <span className="mlb-today-pitcher-name">{pitcher.fullName}</span>
        </div>
        {(record || pitcher.era !== null) && (
          <span className="mlb-today-pitcher-stats muted small">
            {record ?? ''}
            {record && pitcher.era !== null ? ' · ' : ''}
            {pitcher.era !== null ? `${pitcher.era.toFixed(2)} ERA` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function formatMl(v: number | null): string {
  if (v === null) return '—';
  return v > 0 ? `+${v}` : String(v);
}

function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return `${v.toFixed(0)}%`;
}
