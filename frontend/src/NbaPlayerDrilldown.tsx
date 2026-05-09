// NBA Player drilldown modal — Phase 80. Mirrors MlbPlayerDrilldown.
// Click any player on /nba/slate → modal with matchup, current game
// state, every line on the slate for that player (deduped, with live
// HIT/MISS/PROGRESS grading), and a live stats grid.
//
// Composed from existing endpoints:
//   - getTodayGames() → ESPN scoreboard (matchup metadata)
//   - getNbaLiveToday() → byPlayer[playerId] (live stats)
// Zero new backend endpoints.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PlayerAvatar, TeamLogo } from './Avatar';
import {
  getNbaLiveToday,
  getTodayGames,
  type EspnScoreboardGame,
  type NbaLiveTodayPlayer,
  type NbaLiveTodayResponse,
  type SlateCombo,
} from './api';

export type NbaDrilldownPlayer = {
  playerId: number;
  playerName: string;
  team: string | null;
};

type SlateLine = SlateCombo['legs'][number];

function liveValueForStat(
  ps: NbaLiveTodayPlayer,
  statKey: string,
): number | null {
  switch (statKey) {
    case 'points':              return ps.points;
    case 'rebounds':            return ps.rebounds;
    case 'assists':             return ps.assists;
    case 'three_pt_made':       return ps.threePtMade;
    case 'fg_made':             return ps.fgMade;
    case 'fg_attempted':        return ps.fgAttempted;
    case 'ft_made':             return ps.ftMade;
    case 'ft_attempted':        return ps.ftAttempted;
    case 'personal_fouls':      return ps.personalFouls;
    case 'steals':              return ps.steals;
    case 'blocks':              return ps.blocks;
    case 'turnovers':           return ps.turnovers;
    case 'offensive_rebounds':  return ps.offensiveRebounds;
    case 'defensive_rebounds':  return ps.defensiveRebounds;
    case 'pra':                 return ps.pra;
    case 'pr':                  return ps.pr;
    case 'pa':                  return ps.pa;
    case 'ra':                  return ps.ra;
    case 'stocks':              return ps.stocks;
    case 'double_double':       return ps.doubleDouble;
    default:                    return null;
  }
}

export function NbaPlayerDrilldown({
  player,
  combos,
  onClose,
}: {
  player: NbaDrilldownPlayer;
  combos: SlateCombo[];
  onClose: () => void;
}) {
  const [scoreboard, setScoreboard] = useState<EspnScoreboardGame[] | null>(null);
  const [live, setLive] = useState<NbaLiveTodayResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getTodayGames().then((d) => d.games).catch(() => []),
      getNbaLiveToday().catch(() => null),
    ]).then(([games, liveFeed]) => {
      if (cancelled) return;
      setScoreboard(games);
      setLive(liveFeed);
    });
    return () => { cancelled = true; };
  }, []);

  const playerLines: SlateLine[] = [];
  const seen = new Set<string>();
  for (const combo of combos) {
    for (const l of combo.legs) {
      if (l.playerId !== player.playerId) continue;
      const key = `${l.statKey}::${l.line}::${l.direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      playerLines.push(l);
    }
  }

  const game = scoreboard?.find(
    (g) => g.away.abbreviation === player.team || g.home.abbreviation === player.team,
  ) ?? null;
  const isHome = game?.home.abbreviation === player.team;
  const opponent = game ? (isHome ? game.away : game.home) : null;
  const startTime = game
    ? new Date(game.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  const livePlayer = live?.byPlayer[String(player.playerId)] ?? null;
  const liveGame = livePlayer ? live?.byGame[livePlayer.eventId] : null;
  const isLive = liveGame?.state === 'live';
  const isFinal = liveGame?.state === 'final';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 720,
          background: 'var(--surface-1, #0d1117)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
          padding: 20,
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
          <PlayerAvatar playerId={player.playerId} name={player.playerName} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{player.playerName}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              {player.team && (
                <>
                  <TeamLogo abbr={player.team} name={player.team} size="md" />
                  <strong style={{ fontSize: 14 }}>{player.team}</strong>
                </>
              )}
              {opponent && (
                <span className="muted small">
                  {isHome ? 'vs' : '@'} {opponent.abbreviation}
                  {opponent.record && ` (${opponent.record})`}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 6,
              color: 'rgba(255,255,255,0.6)',
              fontSize: 14,
              padding: '6px 12px',
              cursor: 'pointer',
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {game && (
          <div
            style={{
              padding: '10px 14px',
              background: 'rgba(122, 162, 255, 0.06)',
              border: '1px solid rgba(122, 162, 255, 0.2)',
              borderRadius: 6,
              marginBottom: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700 }}>
              {isLive && <span style={{ color: '#ef5350' }}>● LIVE · </span>}
              {isFinal && <span style={{ opacity: 0.6 }}>FINAL · </span>}
              {!isLive && !isFinal && startTime && <>Tip {startTime} · </>}
              {game.away.abbreviation} {liveGame?.awayScore ?? game.away.score ?? '—'}
              {' @ '}
              {game.home.abbreviation} {liveGame?.homeScore ?? game.home.score ?? '—'}
            </span>
            <span className="muted small">{game.status.detail}</span>
            <Link
              to={`/nba/game/${game.id}`}
              onClick={onClose}
              style={{ marginLeft: 'auto', color: '#7aa2ff', fontWeight: 700, fontSize: 12, textDecoration: 'none' }}
            >
              Full matchup →
            </Link>
          </div>
        )}
        {!game && scoreboard && (
          <div className="mlb-info-banner" style={{ marginBottom: 14 }}>
            No game found for {player.team ?? 'this player'} today.
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)', marginBottom: 8 }}>
            Tonight's lines on the slate
          </div>
          {playerLines.length === 0 ? (
            <p className="muted small">No lines for this player on tonight's slate.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {playerLines.map((l, i) => {
                const liveValue = livePlayer ? liveValueForStat(livePlayer, l.statKey) : null;
                let grade: 'HIT' | 'MISS' | 'PROGRESS' | 'PENDING' = 'PENDING';
                if (liveValue !== null && (isLive || isFinal)) {
                  if (l.direction === 'OVER') {
                    if (liveValue > l.line) grade = 'HIT';
                    else if (isFinal) grade = liveValue === l.line ? 'PENDING' : 'MISS';
                    else grade = 'PROGRESS';
                  } else {
                    if (liveValue > l.line) grade = 'MISS';
                    else if (isFinal) grade = liveValue === l.line ? 'PENDING' : 'HIT';
                    else grade = 'PROGRESS';
                  }
                }
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      background: 'rgba(255,255,255,0.03)',
                      borderRadius: 4,
                      fontSize: 13,
                    }}
                  >
                    <span style={{ flex: 1, fontWeight: 600 }}>
                      {l.statLabel} {l.line}
                    </span>
                    <span style={{
                      fontWeight: 700,
                      color: l.probability >= 70 ? '#66bb6a' : l.probability >= 55 ? '#7aa2ff' : '#ef5350',
                    }}>
                      {l.direction === 'OVER' ? '↑' : '↓'} {Math.round(l.probability)}%
                    </span>
                    {l.edgePercent !== undefined && (
                      <span style={{
                        fontSize: 11, fontWeight: 700,
                        color: l.edgePercent >= 5 ? '#66bb6a' : l.edgePercent <= -5 ? '#ef5350' : 'rgba(255,255,255,0.5)',
                      }}>
                        {l.edgePercent >= 0 ? '+' : ''}{l.edgePercent.toFixed(0)}% edge
                      </span>
                    )}
                    {grade !== 'PENDING' && (
                      <span style={{
                        fontSize: 11, fontWeight: 700,
                        color: grade === 'HIT' ? '#66bb6a' : grade === 'MISS' ? '#ef5350' : '#7aa2ff',
                      }}>
                        {grade}{liveValue !== null ? ` · ${liveValue}` : ''}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {livePlayer && (isLive || isFinal) && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)', marginBottom: 8 }}>
              Current game stats
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 8 }}>
              <StatCell label="PTS" value={livePlayer.points} />
              <StatCell label="REB" value={livePlayer.rebounds} />
              <StatCell label="AST" value={livePlayer.assists} />
              <StatCell label="3PM" value={livePlayer.threePtMade} />
              <StatCell label="FG" value={`${livePlayer.fgMade}/${livePlayer.fgAttempted}`} />
              <StatCell label="FT" value={`${livePlayer.ftMade}/${livePlayer.ftAttempted}`} />
              <StatCell label="STL" value={livePlayer.steals} />
              <StatCell label="BLK" value={livePlayer.blocks} />
              <StatCell label="TO" value={livePlayer.turnovers} />
              <StatCell label="OREB" value={livePlayer.offensiveRebounds} />
              <StatCell label="DREB" value={livePlayer.defensiveRebounds} />
              <StatCell label="PF" value={livePlayer.personalFouls} />
              <StatCell label="PRA" value={livePlayer.pra} />
              <StatCell label="STOCKS" value={livePlayer.stocks} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 4,
        padding: '6px 8px',
      }}
    >
      <div className="muted small" style={{ fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
