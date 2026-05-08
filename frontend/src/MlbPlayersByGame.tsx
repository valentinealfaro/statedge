// MLB slate per-player browse view — game-grouped accordion + search.
//
// Default render: collapsed game cards sorted by start time, top 3
// auto-expanded so users see action immediately. Each game card
// shows the matchup header (logos + records + probable pitchers +
// odds + weather) and a grid of player cards.
//
// Player card mirrors the NBA per-player UX:
//   [★] [👤 avatar] Player Name        ▶
//                   Team
//                   Top play: Stat Line ↑Prob%   +N more
// Click → expands inline to show all alternative lines for that
// player tonight.
//
// Search bar at the top filters by player name across all games.
// When searching, all matching games auto-expand.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MlbPlayerAvatar, MlbTeamLogo } from './Avatar';
import {
  getMlbSlatePlayers,
  type MlbPlayerSlateEntry,
  type MlbPlayerSlateLine,
  type MlbSlateGameGroup,
  type MlbSlatePlayersResponse,
} from './api';
import { Skeleton } from './Skeleton';

const HOW_MANY_AUTO_EXPAND = 3;

export function MlbPlayersByGame() {
  const [data, setData] = useState<MlbSlatePlayersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [manuallyExpanded, setManuallyExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    getMlbSlatePlayers()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  const trimmedSearch = search.trim().toLowerCase();

  // When searching, every game with a matching player is "expanded"
  // by virtue of the filter. Otherwise, top-N games (by start time)
  // auto-expand and any user-toggled ones override.
  const expandedSet = useMemo(() => {
    if (!data) return new Set<number>();
    if (trimmedSearch.length > 0) {
      // Auto-expand any game with at least one matching player.
      const s = new Set<number>();
      for (const g of data.games) {
        if (g.players.some((p) => p.playerName.toLowerCase().includes(trimmedSearch))) {
          s.add(g.gamePk);
        }
      }
      return s;
    }
    // Default: first N games auto-expand. User toggles override.
    const auto = new Set(data.games.slice(0, HOW_MANY_AUTO_EXPAND).map((g) => g.gamePk));
    // Manual XOR: toggling a default-expanded game closes it; toggling
    // a default-collapsed one opens it.
    const out = new Set<number>(auto);
    for (const id of manuallyExpanded) {
      if (out.has(id)) out.delete(id);
      else out.add(id);
    }
    return out;
  }, [data, trimmedSearch, manuallyExpanded]);

  if (error) {
    return (
      <div className="mlb-info-banner mlb-info-error" style={{ marginTop: 16 }}>
        Couldn't load player breakdown: {error}
      </div>
    );
  }
  if (!data) {
    return <Skeleton width="100%" height={500} style={{ marginTop: 16 }} />;
  }
  if (data.games.length === 0) {
    return (
      <div className="mlb-info-banner" style={{ marginTop: 16 }}>
        No projected players for today's slate yet.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div className="mlb-context-heading" style={{ marginBottom: 8, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span>Browse all players by game</span>
        <span className="muted small">
          {data.totalPlayers} players · {data.totalLines} lines · {data.totalGames} games
        </span>
      </div>

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search player name…"
        style={{
          width: '100%',
          padding: '10px 14px',
          fontSize: 14,
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 6,
          background: 'rgba(255,255,255,0.04)',
          color: 'inherit',
          marginBottom: 12,
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {data.games.map((game) => (
          <GameCard
            key={game.gamePk}
            game={game}
            expanded={expandedSet.has(game.gamePk)}
            onToggle={() => {
              setManuallyExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(game.gamePk)) next.delete(game.gamePk);
                else next.add(game.gamePk);
                return next;
              });
            }}
            search={trimmedSearch}
          />
        ))}
      </div>
    </div>
  );
}

function GameCard({
  game,
  expanded,
  onToggle,
  search,
}: {
  game: MlbSlateGameGroup;
  expanded: boolean;
  onToggle: () => void;
  search: string;
}) {
  const time = game.gameDate
    ? new Date(game.gameDate).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '—';
  const live = game.status?.inProgress ?? false;
  const final = game.status?.abstractGameState === 'Final';

  const filteredPlayers = search
    ? game.players.filter((p) => p.playerName.toLowerCase().includes(search))
    : game.players;

  return (
    <div className="mlb-projection" style={{ padding: 0 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          padding: '12px 16px',
          background: 'transparent',
          border: 'none',
          borderBottom: expanded ? '1px solid var(--border-subtle)' : 'none',
          cursor: 'pointer',
          color: 'inherit',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 16, opacity: 0.6, width: 16 }}>{expanded ? '▾' : '▸'}</span>
        {game.away && <MlbTeamLogo abbr={game.away.abbreviation} name={game.away.name} size="md" />}
        <span style={{ fontSize: 15, fontWeight: 700 }}>
          {game.away?.abbreviation ?? '—'}
          <span className="muted small" style={{ marginLeft: 6, fontWeight: 400 }}>
            ({game.away?.record ?? '—'})
          </span>
          <span style={{ margin: '0 8px', opacity: 0.5 }}>@</span>
        </span>
        {game.home && <MlbTeamLogo abbr={game.home.abbreviation} name={game.home.name} size="md" />}
        <span style={{ fontSize: 15, fontWeight: 700 }}>
          {game.home?.abbreviation ?? '—'}
          <span className="muted small" style={{ marginLeft: 6, fontWeight: 400 }}>
            ({game.home?.record ?? '—'})
          </span>
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="muted small">{game.players.length} players</span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.04em',
              color: live ? '#ef5350' : final ? undefined : '#7aa2ff',
              opacity: final ? 0.7 : 1,
            }}
          >
            {live ? '● LIVE' : final ? 'FINAL' : time}
          </span>
        </span>
      </button>

      {expanded && (
        <div style={{ padding: '12px 16px 16px' }}>
          {/* Probable pitchers + matchup signals row */}
          {game.probablePitchers && (game.probablePitchers.away || game.probablePitchers.home) && (
            <div
              style={{
                display: 'flex',
                gap: 16,
                flexWrap: 'wrap',
                padding: '8px 12px',
                background: 'rgba(122, 162, 255, 0.06)',
                borderRadius: 4,
                marginBottom: 12,
                fontSize: 12,
              }}
            >
              {game.probablePitchers.away && (
                <span>
                  <strong>{game.away?.abbreviation}</strong> {game.probablePitchers.away.fullName}
                  <span className="muted small" style={{ marginLeft: 4 }}>
                    {game.probablePitchers.away.wins ?? 0}-{game.probablePitchers.away.losses ?? 0}
                    {game.probablePitchers.away.era !== null && ` · ${game.probablePitchers.away.era.toFixed(2)} ERA`}
                  </span>
                </span>
              )}
              {game.probablePitchers.home && (
                <span>
                  <strong>{game.home?.abbreviation}</strong> {game.probablePitchers.home.fullName}
                  <span className="muted small" style={{ marginLeft: 4 }}>
                    {game.probablePitchers.home.wins ?? 0}-{game.probablePitchers.home.losses ?? 0}
                    {game.probablePitchers.home.era !== null && ` · ${game.probablePitchers.home.era.toFixed(2)} ERA`}
                  </span>
                </span>
              )}
              {game.weather && game.weather.temp && (
                <span className="muted small">
                  {game.weather.temp}° {game.weather.condition ?? ''}
                </span>
              )}
              <Link
                to={`/mlb/game/${game.gamePk}`}
                style={{ marginLeft: 'auto', color: '#7aa2ff', textDecoration: 'none', fontWeight: 700 }}
              >
                Full matchup →
              </Link>
            </div>
          )}

          {filteredPlayers.length === 0 ? (
            <p className="muted small">No players match "{search}" in this game.</p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 8,
              }}
            >
              {filteredPlayers.map((p) => <PlayerCard key={p.playerId} player={p} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlayerCard({ player }: { player: MlbPlayerSlateEntry }) {
  const [showAll, setShowAll] = useState(false);
  const top = player.lines[0];
  if (!top) return null;
  const moreCount = Math.max(0, player.lines.length - 1);

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 6,
        padding: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <MlbPlayerAvatar playerId={player.playerId} name={player.playerName} size="md" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {player.playerName}
          </div>
          <div className="muted small" style={{ display: 'flex', gap: 6 }}>
            <span>{player.team ?? '—'}</span>
            {player.isPitcher && <span style={{ color: '#7aa2ff' }}>P</span>}
          </div>
        </div>
        {moreCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            style={{
              fontSize: 11,
              color: '#7aa2ff',
              fontWeight: 700,
              background: 'transparent',
              border: '1px solid rgba(122, 162, 255, 0.3)',
              borderRadius: 4,
              padding: '4px 8px',
              cursor: 'pointer',
            }}
            title={showAll ? 'Hide alternates' : `Show ${moreCount} more lines`}
          >
            {showAll ? '−' : `+${moreCount}`}
          </button>
        )}
      </div>

      <LineRow line={top} highlight />
      {showAll && player.lines.slice(1).map((l, i) => (
        <LineRow key={i} line={l} />
      ))}
    </div>
  );
}

function LineRow({ line, highlight }: { line: MlbPlayerSlateLine; highlight?: boolean }) {
  const isOver = line.direction === 'OVER';
  const probColor = line.probability >= 70 ? '#66bb6a'
    : line.probability >= 55 ? '#7aa2ff'
    : line.probability <= 45 ? '#ef5350'
    : undefined;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 8,
        padding: highlight ? '6px 8px' : '4px 8px',
        background: highlight ? 'rgba(122, 162, 255, 0.06)' : 'transparent',
        borderRadius: 4,
        fontSize: 12,
      }}
    >
      <span className="muted small" style={{ minWidth: 56 }}>
        {highlight ? 'Top play:' : ''}
      </span>
      <span style={{ fontWeight: 600, flex: 1 }}>
        {line.statLabel} {line.line}
      </span>
      <span style={{ fontWeight: 700, color: probColor }}>
        {isOver ? '↑' : '↓'} {Math.round(line.probability)}%
      </span>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: line.edgePercent >= 5 ? '#66bb6a' : line.edgePercent <= -5 ? '#ef5350' : 'rgba(255,255,255,0.5)',
          minWidth: 50,
          textAlign: 'right',
        }}
      >
        {line.edgePercent >= 0 ? '+' : ''}{line.edgePercent.toFixed(0)}% edge
      </span>
    </div>
  );
}
