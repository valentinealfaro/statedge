// NBA Player Game Log — companion to the MLB Phase 20 page.
//
// Click a player from the NBA Compare page and see their full
// season game-by-game with optional line-overlay for hit/miss
// accounting. Same transparency-mission framing as MlbPlayerLog —
// the receipt for our projection's premise.
//
// NBA's last-10 endpoint already returns `gameLog: PlayerGame[]`
// for the full pulled window (typically 10-30 games depending on
// the season state), so no backend changes needed.

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PlayerAvatar, TeamLogo } from './Avatar';
import {
  getPlayerById,
  getPlayerLast10,
  type Last10Response,
  type Last10StatId,
  type PlayerGame,
} from './api';
import { NavBar } from './NavBar';
import { NbaPlayerTonightSlate } from './NbaPlayerTonightSlate';
import { PlayerNewsSection } from './PlayerNewsSection';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

const STAT_OPTIONS: Array<{ key: Exclude<Last10StatId, 'double_double'>; label: string }> = [
  { key: 'points',             label: 'Points' },
  { key: 'rebounds',           label: 'Rebounds' },
  { key: 'assists',            label: 'Assists' },
  { key: 'steals',             label: 'Steals' },
  { key: 'blocks',             label: 'Blocks' },
  { key: 'turnovers',          label: 'Turnovers' },
  { key: 'three_pt_made',      label: '3PM' },
  { key: 'fg_made',            label: 'FGM' },
  { key: 'fg_attempted',       label: 'FGA' },
  { key: 'ft_made',            label: 'FTM' },
  { key: 'ft_attempted',       label: 'FTA' },
  { key: 'offensive_rebounds', label: 'OREB' },
  { key: 'defensive_rebounds', label: 'DREB' },
  { key: 'personal_fouls',     label: 'Fouls' },
  { key: 'pra',                label: 'PRA' },
  { key: 'pr',                 label: 'PR' },
  { key: 'pa',                 label: 'PA' },
  { key: 'ra',                 label: 'RA' },
  { key: 'stocks',             label: 'STL+BLK' },
];

// Pull the value for the chosen stat off a PlayerGame row. Mirrors
// what the backend does in buildLast10Report so the season log row
// matches what shows on Compare.
function valueForStat(g: PlayerGame, stat: Last10StatId): number {
  switch (stat) {
    case 'points':             return g.points;
    case 'rebounds':           return g.rebounds;
    case 'assists':            return g.assists;
    case 'steals':             return g.steals;
    case 'blocks':             return g.blocks;
    case 'turnovers':          return g.turnovers;
    case 'three_pt_made':      return g.fg3m ?? 0;
    case 'fg_made':            return g.fgm ?? 0;
    case 'fg_attempted':       return g.fga ?? 0;
    case 'ft_made':            return g.ftm ?? 0;
    case 'ft_attempted':       return g.fta ?? 0;
    case 'offensive_rebounds': return g.oreb ?? 0;
    case 'defensive_rebounds': return g.dreb ?? 0;
    case 'personal_fouls':     return g.pf ?? 0;
    case 'pra':                return g.points + g.rebounds + g.assists;
    case 'pr':                 return g.points + g.rebounds;
    case 'pa':                 return g.points + g.assists;
    case 'ra':                 return g.rebounds + g.assists;
    case 'stocks':             return g.steals + g.blocks;
    case 'double_double':      return 0;     // boolean stat — handled separately
  }
}

export function PlayerLog() {
  const { playerId: playerIdStr } = useParams<{ playerId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const playerId = Number(playerIdStr);
  const queriedStat = (searchParams.get('stat') ?? 'points') as Last10StatId;
  const queriedLineRaw = searchParams.get('line');
  const queriedLine = queriedLineRaw !== null ? Number(queriedLineRaw) : null;

  const [player, setPlayer] = useState<{ id: number; fullName: string; teamAbbreviation?: string | null } | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [selectedStat, setSelectedStat] = useState<Last10StatId>(queriedStat);
  const [lineInput, setLineInput] = useState<string>(
    queriedLine !== null && Number.isFinite(queriedLine) ? String(queriedLine) : '',
  );
  const [log, setLog] = useState<Last10Response | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  const playerName = player?.fullName ?? '';
  useTitle(playerName ? [`${playerName} · Game Log`] : ['Player Log']);

  useEffect(() => {
    if (!Number.isFinite(playerId) || playerId <= 0) {
      setPlayerError('Invalid player id.');
      return;
    }
    getPlayerById(playerId)
      .then((p) => setPlayer(p as never))
      .catch((err: Error) => setPlayerError(err.message));
  }, [playerId]);

  useEffect(() => {
    if (!Number.isFinite(playerId)) return;
    setLogLoading(true);
    setLogError(null);
    getPlayerLast10(playerId, selectedStat)
      .then(setLog)
      .catch((err: Error) => {
        setLogError(err.message);
        setLog(null);
      })
      .finally(() => setLogLoading(false));
    const next = new URLSearchParams(searchParams);
    next.set('stat', selectedStat);
    if (lineInput.trim() !== '' && Number.isFinite(Number(lineInput))) {
      next.set('line', lineInput.trim());
    } else {
      next.delete('line');
    }
    setSearchParams(next, { replace: true });
  }, [playerId, selectedStat, lineInput]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ marginBottom: 12 }}>
          <Link to="/nba/compare" className="muted small">← Back to Compare</Link>
        </div>

        {playerError && <div className="mlb-info-banner mlb-info-error">{playerError}</div>}
        {!player && !playerError && <Skeleton width="60%" height={32} />}

        {player && (
          <div
            className="player-profile-header fade-up"
            style={{
              position: 'relative',
              display: 'flex', alignItems: 'center', gap: 18,
              padding: '18px 20px',
              marginBottom: 14,
              background: `
                linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 30%),
                var(--surface-1)
              `,
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-card)',
              overflow: 'hidden',
            }}
          >
            <span aria-hidden style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 1,
              background: 'linear-gradient(90deg, transparent, rgba(122,162,255,0.55), transparent)',
            }} />
            <div style={{ flexShrink: 0 }}>
              <PlayerAvatar playerId={playerId} name={playerName || `Player ${playerId}`} size="lg" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <h1 style={{
                  margin: 0, fontSize: 26, fontWeight: 900, letterSpacing: '-0.5px',
                  background: 'linear-gradient(180deg, #ffffff 0%, rgba(255,255,255,0.78) 100%)',
                  WebkitBackgroundClip: 'text', backgroundClip: 'text',
                  WebkitTextFillColor: 'transparent', color: 'transparent',
                }}>
                  {playerName || `Player ${playerId}`}
                </h1>
                {player.teamAbbreviation && (
                  <span style={{
                    fontSize: 11, fontWeight: 800, letterSpacing: '0.06em',
                    padding: '3px 8px', borderRadius: 4,
                    background: 'rgba(122,162,255,0.12)',
                    color: '#7aa2ff',
                    border: '1px solid rgba(122,162,255,0.30)',
                    textTransform: 'uppercase',
                  }}>
                    {player.teamAbbreviation}
                  </span>
                )}
              </div>
              {player.teamAbbreviation && (
                <div className="muted small" style={{
                  marginTop: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <TeamLogo abbr={player.teamAbbreviation} name={player.teamAbbreviation} size="md" />
                  <span>{player.teamAbbreviation}</span>
                </div>
              )}
            </div>
          </div>
        )}

        <section className="mlb-stat-section">
          <label className="mlb-label" htmlFor="nba-log-stat">Stat</label>
          <select
            id="nba-log-stat"
            className="mlb-stat-select"
            value={selectedStat}
            onChange={(e) => setSelectedStat(e.target.value as Last10StatId)}
          >
            {STAT_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>

          <label className="mlb-label" htmlFor="nba-log-line" style={{ marginTop: 12 }}>
            Line (optional — overlays hit/miss column)
          </label>
          <input
            id="nba-log-line"
            type="number"
            className="mlb-stat-select"
            placeholder="e.g. 22.5"
            step="0.5"
            value={lineInput}
            onChange={(e) => setLineInput(e.target.value)}
          />
        </section>

        {logError && <div className="mlb-info-banner mlb-info-error" style={{ marginTop: 12 }}>{logError}</div>}
        {logLoading && <Skeleton width="100%" height={300} style={{ marginTop: 16 }} />}

        {log && !logLoading && 'gameLog' in log && (
          <NbaGameLogTable
            log={log}
            stat={selectedStat}
            line={lineInput.trim() === '' ? null : Number(lineInput)}
          />
        )}

        {/* Tonight's slate — self-hides when this player isn't featured */}
        {player && Number.isFinite(playerId) && (
          <NbaPlayerTonightSlate playerId={playerId} />
        )}

        {player && (playerName || player.teamAbbreviation) && (
          <PlayerNewsSection
            sport="nba"
            playerId={playerId}
            playerName={playerName || `Player ${playerId}`}
          />
        )}
      </div>
    </div>
  );
}

function NbaGameLogTable({
  log,
  stat,
  line,
}: {
  log: Last10Response & { gameLog: PlayerGame[] };
  stat: Last10StatId;
  line: number | null;
}) {
  const games = useMemo(() => [...log.gameLog].reverse(), [log.gameLog]);
  const includeLine = line !== null && Number.isFinite(line);

  const summary = useMemo(() => {
    if (games.length === 0) return null;
    const values = games.map((g) => valueForStat(g, stat));
    const sum = values.reduce((s, v) => s + v, 0);
    const avg = sum / values.length;
    const high = Math.max(...values);
    const low = Math.min(...values);
    const variance = values.reduce((s, v) => s + (v - avg) * (v - avg), 0) / values.length;
    const stddev = Math.sqrt(variance);
    let hits = 0;
    if (includeLine) hits = values.filter((v) => v > line!).length;
    return { total: values.length, avg, high, low, stddev, hits };
  }, [games, stat, line, includeLine]);

  if (!summary) {
    return (
      <div className="mlb-info-banner" style={{ marginTop: 16 }}>
        No games found in the season log for this stat.
      </div>
    );
  }

  return (
    <>
      <div className="mlb-projection" style={{ marginTop: 16 }}>
        <div className="mlb-projection-head">
          <h3>Season log · {stat}</h3>
          <span className="muted small">{summary.total} games</span>
        </div>
        <div className="mlb-projection-grid">
          <div className="mlb-stat"><span className="mlb-stat-label">Avg</span><span className="mlb-stat-value">{summary.avg.toFixed(1)}</span></div>
          <div className="mlb-stat"><span className="mlb-stat-label">High</span><span className="mlb-stat-value">{summary.high}</span></div>
          <div className="mlb-stat"><span className="mlb-stat-label">Low</span><span className="mlb-stat-value">{summary.low}</span></div>
          <div className="mlb-stat"><span className="mlb-stat-label">Stddev</span><span className="mlb-stat-value">{summary.stddev.toFixed(2)}</span></div>
          {includeLine && (
            <div className="mlb-stat" title={`Games clearing OVER ${line}`}>
              <span className="mlb-stat-label">Over {line}</span>
              <span className="mlb-stat-value">
                {summary.hits}/{summary.total} ({((summary.hits / summary.total) * 100).toFixed(0)}%)
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="mlb-context" style={{ marginTop: 12 }}>
        <div className="mlb-context-heading">Game-by-game</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="mlb-standings-table" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Date</th>
                <th>Matchup</th>
                <th>Min</th>
                <th className="num">Value</th>
                <th>Stat line</th>
                {includeLine && <th>Vs line</th>}
              </tr>
            </thead>
            <tbody>
              {games.map((g, i) => {
                const v = valueForStat(g, stat);
                const cleared = includeLine && v > line!;
                const tied = includeLine && v === line!;
                return (
                  <tr key={g.gameId}>
                    <td>{games.length - i}</td>
                    <td>{g.date}</td>
                    <td>{g.matchup}</td>
                    <td>{g.minutes.toFixed(0)}</td>
                    <td className="num"><strong>{v}</strong></td>
                    <td style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: 12,
                      color: 'rgba(255,255,255,0.75)',
                    }}>
                      {formatNbaStatLine(g)}
                    </td>
                    {includeLine && (
                      <td style={{ color: cleared ? 'var(--hot, #66bb6a)' : tied ? 'var(--text-3)' : '#ef5350' }}>
                        {cleared ? '✓ Hit' : tied ? '— Push' : '✗ Miss'}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// Compact NBA box-score for one game. PTS / REB / AST always shown
// (the canonical triple). Steals/blocks/turnovers/3PM appended only
// when non-zero so the line stays scannable. Mirrors MLB's
// formatStatLine convention for cross-sport visual parity.
function formatNbaStatLine(g: PlayerGame): string {
  const parts: string[] = [];
  parts.push(`${g.points}P`);
  parts.push(`${g.rebounds}R`);
  parts.push(`${g.assists}A`);
  if (g.fg3m && g.fg3m > 0) parts.push(`${g.fg3m}3PM`);
  if (g.steals && g.steals > 0) parts.push(`${g.steals}STL`);
  if (g.blocks && g.blocks > 0) parts.push(`${g.blocks}BLK`);
  if (g.turnovers && g.turnovers > 0) parts.push(`${g.turnovers}TO`);
  return parts.join(' · ');
}
