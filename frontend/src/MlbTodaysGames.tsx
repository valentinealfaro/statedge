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
import { getMlbToday, type MlbTodayGame, type MlbTodayResponse } from './api';

export function MlbTodaysGames() {
  const [data, setData] = useState<MlbTodayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getMlbToday()
      .then((d) => { if (alive) setData(d); })
      .catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, []);

  if (error) return null;                  // silent on error
  if (!data || data.games.length === 0) return null;

  return (
    <section className="mlb-today">
      <div className="mlb-today-head">
        <h2 className="mlb-today-heading">Tonight's MLB games</h2>
        <span className="muted small">{data.games.length} game{data.games.length === 1 ? '' : 's'} · {data.date}</span>
      </div>
      <div className="mlb-today-grid">
        {data.games.map((g) => <GameCard key={g.gamePk} game={g} />)}
      </div>
    </section>
  );
}

function GameCard({ game }: { game: MlbTodayGame }) {
  const status = game.status.detailedState;
  const isPregame = game.status.abstractGameState === 'Preview';
  const isLive = game.status.inProgress;
  const isFinal = game.status.abstractGameState === 'Final';

  return (
    <div className={`mlb-today-game ${isLive ? 'live' : ''} ${isFinal ? 'final' : ''}`}>
      <div className="mlb-today-game-status">{status}</div>

      <div className="mlb-today-row">
        <span className="mlb-today-team">
          <strong>{game.away.abbreviation}</strong>
          {game.away.record && <span className="muted small"> {game.away.record}</span>}
        </span>
        <span className="mlb-today-score">{game.away.score ?? '—'}</span>
      </div>
      <div className="mlb-today-row">
        <span className="mlb-today-team">
          <strong>{game.home.abbreviation}</strong>
          {game.home.record && <span className="muted small"> {game.home.record}</span>}
          <span className="mlb-today-home-mark"> · home</span>
        </span>
        <span className="mlb-today-score">{game.home.score ?? '—'}</span>
      </div>

      {/* Implied win probability from ML odds. Mission-framed: this
          is sportsbook consensus, NOT our model's prediction. */}
      {isPregame && game.odds && (game.odds.homeImpliedWinProb !== null || game.odds.awayImpliedWinProb !== null) && (
        <div className="mlb-today-odds"
             title={`Moneyline ${game.away.abbreviation} ${formatMl(game.odds.awayMl)} / ${game.home.abbreviation} ${formatMl(game.odds.homeMl)} via ${game.odds.provider ?? 'ESPN'}. Implied = sportsbook consensus, NOT StatEdge's model.`}>
          <span className="mlb-today-odds-label">Vegas implied</span>
          <span className="mlb-today-odds-prob">
            {game.away.abbreviation} {fmtPct(game.odds.awayImpliedWinProb)}
            {' · '}
            {game.home.abbreviation} {fmtPct(game.odds.homeImpliedWinProb)}
          </span>
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
    </div>
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
    <div className="mlb-today-pitcher">
      <span className="mlb-today-pitcher-team muted small">{team}</span>
      <span className="mlb-today-pitcher-name">{pitcher.fullName}</span>
      {(record || pitcher.era !== null) && (
        <span className="mlb-today-pitcher-stats muted small">
          {record ?? ''}
          {record && pitcher.era !== null ? ' · ' : ''}
          {pitcher.era !== null ? `${pitcher.era.toFixed(2)} ERA` : ''}
        </span>
      )}
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
