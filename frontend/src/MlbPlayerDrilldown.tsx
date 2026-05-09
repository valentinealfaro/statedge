// Player drilldown modal — Phase 79. Click any player name on a slate
// card → modal opens with everything we know about their slate
// presence tonight: matchup, current game state (live or pre-game),
// every line we have on them in tonight's slate, current live stats
// if the game is in progress.
//
// Data is composed entirely from endpoints already wired:
//   - /api/mlb/today (passed in via prop) → matchup metadata
//   - /api/mlb/slate/today combos (filtered for this playerId)
//   - /api/mlb/live/today byPlayer[playerId] (live stats)
// Zero new backend endpoints.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MlbPlayerAvatar, MlbTeamLogo } from './Avatar';
import {
  getMlbLiveToday,
  getMlbToday,
  type MlbLiveTodayResponse,
  type MlbSlateResponse,
  type MlbTodayGame,
  type MlbWildCardCombo,
} from './api';

export type DrilldownPlayer = {
  playerId: number;
  playerName: string;
  team: string | null;
};

// Drilldown leg: every line for this player from tonight's slate +
// the card sizes it appears on.
type SlateLine = NonNullable<MlbSlateResponse['combos'][number]['combo']>['legs'][number];
type WildCardLeg = MlbWildCardCombo['legs'][number];

// Map slate stat keys to live boxscore fields. Same logic as the
// SGP grader on /mlb/game/:gamePk — duplicated here to keep the
// drilldown self-contained.
function liveValueForStat(
  ps: NonNullable<MlbLiveTodayResponse['byPlayer'][string]>,
  statKey: string,
): number | null {
  switch (statKey) {
    case 'hits':                return ps.hits;
    case 'total_bases':         return ps.totalBases;
    case 'runs':                return ps.runs;
    case 'rbis':                return ps.rbis;
    case 'walks':               return ps.walks;
    case 'strikeouts':          return ps.strikeouts;
    case 'home_runs':           return ps.homeRuns;
    case 'doubles':             return ps.doubles;
    case 'triples':             return ps.triples;
    case 'stolen_bases':        return ps.stolenBases;
    case 'hits_runs_rbis': {
      const h = ps.hits ?? 0;
      const r = ps.runs ?? 0;
      const ri = ps.rbis ?? 0;
      return h + r + ri;
    }
    case 'pitcher_strikeouts':  return ps.pitcherStrikeouts;
    case 'hits_allowed':        return ps.hitsAllowed;
    case 'earned_runs_allowed': return ps.earnedRunsAllowed;
    case 'walks_allowed':       return ps.walksAllowed;
    case 'outs_recorded':       return ps.outsRecorded;
    case 'home_runs_allowed':   return ps.homeRunsAllowed;
    default:                    return null;
  }
}

export function MlbPlayerDrilldown({
  player,
  slate,
  onClose,
}: {
  player: DrilldownPlayer;
  slate: MlbSlateResponse | null;
  onClose: () => void;
}) {
  const [today, setToday] = useState<MlbTodayGame[] | null>(null);
  const [live, setLive] = useState<MlbLiveTodayResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getMlbToday().then((d) => d.games),
      getMlbLiveToday().catch(() => null),
    ]).then(([games, liveFeed]) => {
      if (cancelled) return;
      setToday(games);
      setLive(liveFeed);
    });
    return () => { cancelled = true; };
  }, []);

  // Find every slate line for this player across all combos + wild card.
  // Dedup by (statKey, line, direction) — same prop can appear on
  // multiple cards, we want it surfaced once.
  type DedupedLine = SlateLine | WildCardLeg;
  const playerLines: DedupedLine[] = [];
  if (slate) {
    const seen = new Set<string>();
    for (const slot of slate.combos) {
      if (!slot.combo) continue;
      for (const l of slot.combo.legs) {
        if (l.playerId !== player.playerId) continue;
        const key = `${l.statKey}::${l.line}::${l.direction}`;
        if (seen.has(key)) continue;
        seen.add(key);
        playerLines.push(l);
      }
    }
    if (slate.wildCard.legs) {
      for (const l of slate.wildCard.legs) {
        if (l.playerId !== player.playerId) continue;
        const key = `${l.statKey}::${l.line}::${l.direction}`;
        if (seen.has(key)) continue;
        seen.add(key);
        playerLines.push(l);
      }
    }
  }

  // Find this player's game today by team-abbr matching.
  const game = today?.find(
    (g) => g.away.abbreviation === player.team || g.home.abbreviation === player.team,
  ) ?? null;
  const isHome = game?.home.abbreviation === player.team;
  const opponent = game ? (isHome ? game.away : game.home) : null;
  const startTime = game
    ? new Date(game.gameDate).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  // Live stats if the game is in progress or final.
  const livePlayer = live?.byPlayer[String(player.playerId)] ?? null;
  const liveGame = game && livePlayer ? live?.byGame[String(livePlayer.gamePk)] : null;
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
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
          <MlbPlayerAvatar playerId={player.playerId} name={player.playerName} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{player.playerName}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              {player.team && (
                <>
                  <MlbTeamLogo abbr={player.team} name={player.team} size="md" />
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

        {/* Game info */}
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
              {!isLive && !isFinal && startTime && <>First pitch {startTime} · </>}
              {game.away.abbreviation} {liveGame?.awayScore ?? game.away.score ?? '—'}
              {' @ '}
              {game.home.abbreviation} {liveGame?.homeScore ?? game.home.score ?? '—'}
            </span>
            <span className="muted small">{game.status.detailedState}</span>
            <Link
              to={`/mlb/game/${game.gamePk}`}
              onClick={onClose}
              style={{ marginLeft: 'auto', color: '#7aa2ff', fontWeight: 700, fontSize: 12, textDecoration: 'none' }}
            >
              Full matchup →
            </Link>
          </div>
        )}
        {!game && (
          <div className="mlb-info-banner" style={{ marginBottom: 14 }}>
            No game found for {player.team ?? 'this player'} today.
          </div>
        )}

        {/* Tonight's slate lines */}
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
                    <span style={{
                      fontSize: 11, fontWeight: 700,
                      color: l.edgePercent >= 5 ? '#66bb6a' : l.edgePercent <= -5 ? '#ef5350' : 'rgba(255,255,255,0.5)',
                    }}>
                      {l.edgePercent >= 0 ? '+' : ''}{l.edgePercent.toFixed(0)}% edge
                    </span>
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

        {/* Live stats panel — only when game is in progress or final */}
        {livePlayer && (isLive || isFinal) && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)', marginBottom: 8 }}>
              Current game stats
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 8 }}>
              <StatCell label="H/AB" value={`${livePlayer.hits ?? '—'}/${livePlayer.atBats ?? '—'}`} />
              <StatCell label="R" value={livePlayer.runs ?? '—'} />
              <StatCell label="RBI" value={livePlayer.rbis ?? '—'} />
              <StatCell label="HR" value={livePlayer.homeRuns ?? '—'} />
              <StatCell label="2B" value={livePlayer.doubles ?? '—'} />
              <StatCell label="3B" value={livePlayer.triples ?? '—'} />
              <StatCell label="BB" value={livePlayer.walks ?? '—'} />
              <StatCell label="K" value={livePlayer.strikeouts ?? '—'} />
              <StatCell label="SB" value={livePlayer.stolenBases ?? '—'} />
              <StatCell label="TB" value={livePlayer.totalBases ?? '—'} />
              {livePlayer.outsRecorded !== null && livePlayer.outsRecorded > 0 && (
                <>
                  <StatCell
                    label="IP"
                    value={`${Math.floor(livePlayer.outsRecorded / 3)}.${livePlayer.outsRecorded % 3}`}
                  />
                  <StatCell label="P-K" value={livePlayer.pitcherStrikeouts ?? '—'} />
                  <StatCell label="ER" value={livePlayer.earnedRunsAllowed ?? '—'} />
                  <StatCell label="H allowed" value={livePlayer.hitsAllowed ?? '—'} />
                </>
              )}
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
