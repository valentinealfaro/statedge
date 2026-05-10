// MLB Player Game Log — Phase 20.
//
// The deepest transparency surface in the product. User clicks a
// player, sees their full season game-by-game with our projection
// (when available) overlaid against the actual outcome. Aligns with
// the StatEdge mission: "We win on data and transparency, not hype."
//
// What this page proves:
//   - The model is honest about variance (you can SEE the spread).
//   - Last-N averages are anchored in reality, not vibes.
//   - When we say "70% probability," users can audit how often the
//     player actually hit at the queried line.
//
// What this page does NOT do (yet):
//   - Per-game OUR projection (would require running the engine
//     against each game's pre-game state — expensive, deferred).
//   - Side-by-side projection-vs-actual chart.

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  getMlbPlayer,
  getMlbPlayerLast10,
  getMlbStats,
  type MlbLast10Response,
  type MlbSearchPlayer,
  type MlbStatMeta,
} from './api';
import { MlbPlayerAvatar, MlbTeamLogo } from './Avatar';
import { mlbTeamAbbr, mlbTeamFullName } from './mlbTeams';
import { MlbPlayerTonightSlate } from './MlbPlayerTonightSlate';
import { NavBar } from './NavBar';
import { PlayerNewsSection } from './PlayerNewsSection';
import { PlayerProjectionTrail } from './PlayerProjectionTrail';
import { PlayerStatCalibration } from './PlayerStatCalibration';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

export function MlbPlayerLog() {
  const { playerId: playerIdStr } = useParams<{ playerId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const playerId = Number(playerIdStr);
  const queriedStat = searchParams.get('stat');
  const queriedLineRaw = searchParams.get('line');
  const queriedLine = queriedLineRaw !== null ? Number(queriedLineRaw) : null;

  const [player, setPlayer] = useState<MlbSearchPlayer | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [stats, setStats] = useState<MlbStatMeta[]>([]);
  const [selectedStat, setSelectedStat] = useState<string | null>(queriedStat);
  const [lineInput, setLineInput] = useState<string>(
    queriedLine !== null && Number.isFinite(queriedLine) ? String(queriedLine) : '',
  );
  const [log, setLog] = useState<MlbLast10Response | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  useTitle(player ? [`${player.fullName} · Game Log`] : ['MLB Player Log']);

  // Load player metadata.
  useEffect(() => {
    if (!Number.isFinite(playerId) || playerId <= 0) {
      setPlayerError('Invalid player id.');
      return;
    }
    getMlbPlayer(playerId)
      .then(setPlayer)
      .catch((err: Error) => setPlayerError(err.message));
  }, [playerId]);

  // Load the available stats list once the player type is known.
  useEffect(() => {
    if (!player) return;
    getMlbStats(player.playerType)
      .then((s) => {
        setStats(s);
        // Default stat: hits for hitters, ks for pitchers — same
        // default the Compare page uses.
        if (selectedStat === null) {
          const def = player.playerType === 'hitter' ? 'hits' : 'ks';
          setSelectedStat(s.find((x) => x.key === def)?.key ?? s[0]?.key ?? null);
        }
      })
      .catch(() => setStats([]));
  }, [player]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Pull the full season log whenever the stat or line changes.
  useEffect(() => {
    if (!player || !selectedStat) return;
    const lineNum = lineInput.trim() === '' ? undefined : Number(lineInput);
    const includeLine = lineNum !== undefined && Number.isFinite(lineNum) && lineNum >= 0;
    setLogLoading(true);
    setLogError(null);
    getMlbPlayerLast10({
      playerId,
      stat: selectedStat,
      line: includeLine ? lineNum : undefined,
      direction: includeLine ? 'OVER' : undefined,
      limit: 200,                 // full season ceiling — capped at 500 server-side
    })
      .then(setLog)
      .catch((err: Error) => {
        setLogError(err.message);
        setLog(null);
      })
      .finally(() => setLogLoading(false));
    // Persist the chosen stat / line in the URL so the page is
    // shareable and survives refreshes.
    const next = new URLSearchParams(searchParams);
    next.set('stat', selectedStat);
    if (includeLine) next.set('line', String(lineNum));
    else next.delete('line');
    setSearchParams(next, { replace: true });
  }, [player, selectedStat, lineInput, playerId]);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ marginBottom: 12 }}>
          <Link to="/mlb/compare" className="muted small">← Back to Compare</Link>
        </div>

        {playerError && (
          <div className="mlb-info-banner mlb-info-error">{playerError}</div>
        )}

        {!player && !playerError && <Skeleton width="60%" height={32} />}

        {player && (
          <PlayerHeader player={player} />
        )}

        {player && (
          <section className="mlb-stat-section">
            <label className="mlb-label" htmlFor="mlb-log-stat">Stat</label>
            <select
              id="mlb-log-stat"
              className="mlb-stat-select"
              value={selectedStat ?? ''}
              onChange={(e) => setSelectedStat(e.target.value)}
            >
              {stats.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>

            <label className="mlb-label" htmlFor="mlb-log-line" style={{ marginTop: 12 }}>
              Line (optional — overlays hit/miss column)
            </label>
            <input
              id="mlb-log-line"
              type="number"
              className="mlb-stat-select"
              placeholder="e.g. 1.5"
              step="0.5"
              value={lineInput}
              onChange={(e) => setLineInput(e.target.value)}
            />

            {/* Player-scoped truth metric: how has StatEdge done on
                THIS player's THIS stat? Self-hides if no graded sample. */}
            {selectedStat && (
              <PlayerStatCalibration
                sport="mlb"
                playerId={playerId}
                statKey={selectedStat}
              />
            )}

            {/* Per-game projection trail — every prior projection on
                this player+stat charted vs the actual outcome. The
                deepest possible drill-down on the truth metric. */}
            {selectedStat && (
              <PlayerProjectionTrail
                playerId={playerId}
                statKey={selectedStat}
                statLabel={stats.find((s) => s.key === selectedStat)?.label ?? selectedStat}
              />
            )}
          </section>
        )}

        {logError && (
          <div className="mlb-info-banner mlb-info-error" style={{ marginTop: 12 }}>
            {logError}
          </div>
        )}

        {logLoading && (
          <Skeleton width="100%" height={300} style={{ marginTop: 16 }} />
        )}

        {log && !logLoading && (
          <GameLogTable
            log={log}
            line={lineInput.trim() === '' ? null : Number(lineInput)}
          />
        )}

        {log && (
          <p className="mlb-disclaimer">{(log as { disclaimer?: string }).disclaimer ?? ''}</p>
        )}

        {/* Tonight's slate — self-hides when this player isn't featured */}
        {player && Number.isFinite(playerId) && (
          <MlbPlayerTonightSlate playerId={playerId} />
        )}

        {player && (
          <PlayerNewsSection
            sport="mlb"
            playerId={player.id}
            playerName={player.fullName}
          />
        )}
      </div>
    </div>
  );
}

function PlayerHeader({ player }: { player: MlbSearchPlayer }) {
  return (
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
        background: 'linear-gradient(90deg, transparent, rgba(102,187,106,0.55), transparent)',
      }} />
      <div style={{ flexShrink: 0 }}>
        <MlbPlayerAvatar playerId={player.id} name={player.fullName} size="lg" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{
            margin: 0, fontSize: 26, fontWeight: 900, letterSpacing: '-0.5px',
            background: 'linear-gradient(180deg, #ffffff 0%, rgba(255,255,255,0.78) 100%)',
            WebkitBackgroundClip: 'text', backgroundClip: 'text',
            WebkitTextFillColor: 'transparent', color: 'transparent',
          }}>
            {player.fullName}
          </h1>
          <span style={{
            fontSize: 11, fontWeight: 800, letterSpacing: '0.06em',
            padding: '3px 8px', borderRadius: 4,
            background: 'rgba(102,187,106,0.12)',
            color: '#66bb6a',
            border: '1px solid rgba(102,187,106,0.30)',
            textTransform: 'uppercase',
          }}>
            {player.playerType === 'pitcher' ? 'Pitcher' : (player.position ?? 'POS')}
          </span>
        </div>
        <div className="muted small" style={{
          marginTop: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {player.team?.abbreviation && (
            <MlbTeamLogo abbr={player.team.abbreviation} name={player.team.fullName ?? player.team.abbreviation} size="md" />
          )}
          <span>
            {player.team?.fullName ?? '—'} · {player.team?.abbreviation ?? '—'}
            {player.bats && ` · Bats ${player.bats}`}
            {player.throws && ` · Throws ${player.throws}`}
          </span>
        </div>
      </div>
    </div>
  );
}

function GameLogTable({
  log,
  line,
}: {
  log: MlbLast10Response;
  line: number | null;
}) {
  // Render newest → oldest (the engine returns oldest-first; reverse
  // for the typical "most recent at top" UX).
  const games = useMemo(() => [...log.games].reverse(), [log.games]);
  const includeLine = line !== null && Number.isFinite(line);

  // Aggregates for the summary strip.
  const summary = useMemo(() => {
    if (games.length === 0) return null;
    const total = games.length;
    const sum = games.reduce((s, g) => s + g.value, 0);
    const avg = sum / total;
    const high = Math.max(...games.map((g) => g.value));
    const low = Math.min(...games.map((g) => g.value));
    let hits = 0;
    if (includeLine) {
      hits = games.filter((g) => g.value > line!).length;
    }
    return { total, avg, high, low, hits };
  }, [games, line, includeLine]);

  if (!summary) {
    return (
      <div className="mlb-info-banner" style={{ marginTop: 16 }}>
        <strong>No games found.</strong> The player has no logged games for
        this stat in the current season. Re-run the MLB sync workflow if
        you expected games here.
      </div>
    );
  }

  return (
    <>
      <div className="mlb-projection" style={{ marginTop: 16 }}>
        <div className="mlb-projection-head">
          <h3>Season log · {log.statKey}</h3>
          <span className="muted small">{summary.total} games</span>
        </div>
        <div className="mlb-projection-grid">
          <div className="mlb-stat" title="Mean across the full season log">
            <span className="mlb-stat-label">Avg</span>
            <span className="mlb-stat-value">{summary.avg.toFixed(2)}</span>
          </div>
          <div className="mlb-stat" title="Single-game high">
            <span className="mlb-stat-label">High</span>
            <span className="mlb-stat-value">{summary.high}</span>
          </div>
          <div className="mlb-stat" title="Single-game low">
            <span className="mlb-stat-label">Low</span>
            <span className="mlb-stat-value">{summary.low}</span>
          </div>
          <div className="mlb-stat" title="Standard deviation across the season">
            <span className="mlb-stat-label">Stddev</span>
            <span className="mlb-stat-value">{log.stddev.toFixed(2)}</span>
          </div>
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
                <th>H/A</th>
                <th>Opp</th>
                <th className="num">Value</th>
                <th>Stat line</th>
                {includeLine && <th>Vs line</th>}
              </tr>
            </thead>
            <tbody>
              {games.map((g, i) => {
                const cleared = includeLine && g.value > line!;
                const tied = includeLine && g.value === line!;
                const oppAbbr = mlbTeamAbbr(g.opponentTeamId);
                const oppFull = mlbTeamFullName(g.opponentTeamId);
                return (
                  <tr key={g.gameId}>
                    <td>{games.length - i}</td>
                    <td>{g.gameDate}</td>
                    <td>{g.isHome === true ? 'Home' : g.isHome === false ? 'Away' : '—'}</td>
                    <td title={oppFull ?? undefined}>
                      {oppAbbr ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <MlbTeamLogo abbr={oppAbbr} name={oppFull ?? oppAbbr} size="md" />
                          <span style={{ fontWeight: 700 }}>{oppAbbr}</span>
                        </span>
                      ) : g.opponentTeamId !== null ? (
                        <span className="muted small">team #{g.opponentTeamId}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num"><strong>{g.value}</strong></td>
                    <td style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: 12,
                      color: 'rgba(255,255,255,0.75)',
                    }}>
                      {formatStatLine(g)}
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

// Compact box-score style stat line for one game. Hitter:
// "1-4, R, 2RBI, HR, BB, K". Pitcher: "5⅓ IP · 4H · 2ER · 8K · 2BB".
// Drops zero-valued items so the line stays scannable.
function formatStatLine(g: { hitterStats?: { hits: number | null; doubles: number | null; triples: number | null; homeRuns: number | null; runs: number | null; rbis: number | null; walks: number | null; strikeouts: number | null; stolenBases: number | null } | null; pitcherStats?: { inningsPitched: string | null; outsRecorded: number | null; hitsAllowed: number | null; earnedRunsAllowed: number | null; walksAllowed: number | null; strikeouts: number | null; homeRunsAllowed: number | null } | null }): string {
  const h = g.hitterStats;
  if (h) {
    const parts: string[] = [];
    if (h.hits !== null) parts.push(`${h.hits}H`);
    if (h.runs && h.runs > 0) parts.push(`${h.runs}R`);
    if (h.rbis && h.rbis > 0) parts.push(`${h.rbis}RBI`);
    if (h.homeRuns && h.homeRuns > 0) parts.push(`${h.homeRuns}HR`);
    if (h.doubles && h.doubles > 0) parts.push(`${h.doubles}2B`);
    if (h.triples && h.triples > 0) parts.push(`${h.triples}3B`);
    if (h.walks && h.walks > 0) parts.push(`${h.walks}BB`);
    if (h.strikeouts && h.strikeouts > 0) parts.push(`${h.strikeouts}K`);
    if (h.stolenBases && h.stolenBases > 0) parts.push(`${h.stolenBases}SB`);
    return parts.length > 0 ? parts.join(' · ') : '—';
  }
  const p = g.pitcherStats;
  if (p) {
    const parts: string[] = [];
    if (p.inningsPitched) parts.push(`${p.inningsPitched} IP`);
    if (p.hitsAllowed !== null) parts.push(`${p.hitsAllowed}H`);
    if (p.earnedRunsAllowed !== null) parts.push(`${p.earnedRunsAllowed}ER`);
    if (p.strikeouts !== null) parts.push(`${p.strikeouts}K`);
    if (p.walksAllowed !== null) parts.push(`${p.walksAllowed}BB`);
    if (p.homeRunsAllowed && p.homeRunsAllowed > 0) parts.push(`${p.homeRunsAllowed}HR`);
    return parts.length > 0 ? parts.join(' · ') : '—';
  }
  return '—';
}
