// NBA per-player browse view — Phase 73, the unified-Compare merge.
//
// Visual + structural mirror of MlbPlayersByGame.tsx so users feel
// they're using ONE institutional analytics engine across sports.
// Differences are intentional and minimal:
//   - Data source: NBA slate (getTodaySlate) instead of MLB endpoint
//   - Color accent: NBA blue (vs MLB green hero band)
//   - Filter chip predicates use NBA stat shapes
//   - Position badges (G/F/C) instead of pitcher P
// Same six filter chips, same Top Institutional Edges hero, same
// game-grouped accordion + player card pattern.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PlayerAvatar, TeamLogo } from './Avatar';
import {
  getTodayGames,
  getTodaySlate,
  type EspnScoreboardGame,
  type SlateProjection,
  type SlateResolvedLine,
} from './api';
import { Skeleton } from './Skeleton';
import { teamIdFromAbbr } from './teams';

const HOW_MANY_AUTO_EXPAND = 3;

// Same six filter chips as MLB — unified institutional vocabulary.
type FilterTag = 'all' | 'high_edge' | 'low_risk' | 'trap_watch' | 'value' | 'momentum';

const FILTER_LABELS: Record<FilterTag, string> = {
  all:        'All',
  high_edge:  'High Edge',
  low_risk:   'Low Risk',
  trap_watch: 'Trap Watch',
  value:      'Value',
  momentum:   'Momentum',
};

const FILTER_TOOLTIPS: Record<FilterTag, string> = {
  all:        'Show every player with a projected line tonight.',
  high_edge:  'Top play has +15% or better edge vs implied — strongest model conviction.',
  low_risk:   'Top play scores ≤30 fragility (Solid Floor tier) — lower variance, sturdier projection.',
  trap_watch: 'Top play has trap score ≥60 — possible public-trap line. Interpret with caution.',
  value:      'Edge ≥10% with probability in the 55-72% sweet spot — meaningful conviction without chalk pricing.',
  momentum:   'Player\'s last-5 average is materially above their last-10 — recent form trending up sharply.',
};

const EDGE_TOOLTIP =
  'Edge % = our model\'s projected probability − sportsbook implied probability. ' +
  '+15% means we have meaningful conviction the market is mispricing this prop. ' +
  'Negative edge = we agree with the market or it\'s priced too sharp for us to play.';

// Project an NBA SlateResolvedLine into the simplified shape the
// player card renders. Pulls top-line metrics from the projection
// engine output (edge, fragility, trap, probability per direction).
type UiLine = {
  statKey: string;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  probability: number;        // 0-100
  edgePercent: number;
  fragilityScore: number;
  trapScore: number;
  momentumScore: number;      // 0-100, derived from trend.deltaVsL10
};

type UiPlayer = {
  playerId: number;
  playerName: string;
  team: string | null;
  position: string | null;
  imageUrl: string | null;
  lines: UiLine[];           // sorted top-first by edge
};

function projectNbaLine(l: SlateResolvedLine): UiLine | null {
  // Use the projection engine output when present (richer than the
  // hitProbability fallback). Probability picks the side the engine
  // leans toward; edge comes from edge.score.
  const proj = l.projection;
  if (!proj) {
    // Fallback to hitProbability if projection didn't run.
    if (!l.hitProbability) return null;
    const h = l.hitProbability;
    const dir = h.lean === 'OVER' ? 'OVER' : 'UNDER';
    return {
      statKey: l.statKey,
      statLabel: l.statLabel,
      line: l.line,
      direction: dir,
      probability: dir === 'OVER' ? h.hitOver : h.hitUnder,
      edgePercent: 0,
      fragilityScore: 50,
      trapScore: 0,
      momentumScore: deriveMomentum(l),
    };
  }
  const lean = (proj.edge.lean ?? '').toUpperCase();
  const dir: 'OVER' | 'UNDER' = lean === 'UNDER' ? 'UNDER' : 'OVER';
  const probability = dir === 'OVER' ? proj.probability.over : proj.probability.under;
  return {
    statKey: l.statKey,
    statLabel: l.statLabel,
    line: l.line,
    direction: dir,
    probability,
    edgePercent: proj.edge.score,
    fragilityScore: proj.fragility.score,
    trapScore: nbaTrapScore(proj),
    momentumScore: deriveMomentum(l),
  };
}

function nbaTrapScore(proj: SlateProjection): number {
  // The NBA projection engine doesn't surface a single "trap" number
  // directly the way MLB does. We approximate from the risk score's
  // upper tail — a tier of 'High'/'Severe' on risk maps to trap-like
  // public-trap conditions. Falls back to 0 when not available.
  const score = proj.risk?.score ?? 0;
  return score >= 60 ? score : 0;
}

function deriveMomentum(l: SlateResolvedLine): number {
  // Map the player's L5-vs-L10 lift onto a 0-100 momentum score.
  // delta of +2 (or more) → 100; -2 (or worse) → 0; 0 → 50.
  const delta = l.trend?.deltaVsL10 ?? 0;
  const clamped = Math.max(-2, Math.min(2, delta));
  return Math.round(((clamped + 2) / 4) * 100);
}

function passesFilter(player: UiPlayer, tag: FilterTag): boolean {
  if (tag === 'all') return true;
  const top = player.lines[0];
  if (!top) return false;
  if (tag === 'high_edge')  return top.edgePercent >= 15;
  if (tag === 'low_risk')   return top.fragilityScore <= 30;
  if (tag === 'trap_watch') return top.trapScore >= 60;
  if (tag === 'value')      return top.edgePercent >= 10 && top.probability >= 55 && top.probability <= 72;
  if (tag === 'momentum')   return top.momentumScore >= 65;
  return true;
}

type GameGroup = {
  matchupKey: string;            // sorted abbr pair, e.g. "DEN-OKC"
  away: EspnScoreboardGame['away'] | null;
  home: EspnScoreboardGame['home'] | null;
  startDetail: string | null;     // ESPN status detail (e.g. "7:30 PM EST")
  state: 'pre' | 'in' | 'post';
  players: UiPlayer[];
};

export function NbaPlayersByGame() {
  const [lines, setLines] = useState<SlateResolvedLine[] | null>(null);
  const [games, setGames] = useState<EspnScoreboardGame[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterTag>('all');
  const [manuallyExpanded, setManuallyExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getTodaySlate('balanced').then((d) => d.resolved?.lines ?? []),
      getTodayGames().then((d) => d.games),
    ])
      .then(([sl, gm]) => {
        if (cancelled) return;
        setLines(sl);
        setGames(gm);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  // Build a team-abbr → game lookup for matchup grouping.
  const teamToGame = useMemo(() => {
    const m = new Map<string, EspnScoreboardGame>();
    if (!games) return m;
    for (const g of games) {
      m.set(g.away.abbreviation, g);
      m.set(g.home.abbreviation, g);
    }
    return m;
  }, [games]);

  const grouped = useMemo<GameGroup[]>(() => {
    if (!lines) return [];
    // Group: matchupKey → playerId → lines
    const byMatchup = new Map<string, {
      key: string;
      away: EspnScoreboardGame['away'] | null;
      home: EspnScoreboardGame['home'] | null;
      startDetail: string | null;
      state: 'pre' | 'in' | 'post';
      players: Map<number, UiPlayer>;
    }>();

    for (const l of lines) {
      const ui = projectNbaLine(l);
      if (!ui) continue;
      const team = l.team;
      if (!team) continue;
      const game = teamToGame.get(team);
      if (!game) continue;
      // Stable matchup key — alphabetical sort so both sides land in
      // the same bucket regardless of which team ships first.
      const pair = [game.away.abbreviation, game.home.abbreviation].sort();
      const key = `${pair[0]}-${pair[1]}`;
      let entry = byMatchup.get(key);
      if (!entry) {
        entry = {
          key,
          away: game.away,
          home: game.home,
          startDetail: game.status?.detail ?? null,
          state: game.status?.state ?? 'pre',
          players: new Map(),
        };
        byMatchup.set(key, entry);
      }
      let player = entry.players.get(l.playerId);
      if (!player) {
        player = {
          playerId: l.playerId,
          playerName: l.playerName,
          team,
          position: l.position,
          imageUrl: l.imageUrl,
          lines: [],
        };
        entry.players.set(l.playerId, player);
      }
      player.lines.push(ui);
    }

    // Sort lines per player by edge desc, players per game by top
    // edge desc, games by start time (proxied by the games array
    // ordering ESPN ships).
    const out: GameGroup[] = [];
    for (const entry of byMatchup.values()) {
      const players = [...entry.players.values()].map((p) => ({
        ...p,
        lines: p.lines.sort((a, b) => b.edgePercent - a.edgePercent),
      })).sort((a, b) =>
        (b.lines[0]?.edgePercent ?? 0) - (a.lines[0]?.edgePercent ?? 0),
      );
      out.push({
        matchupKey: entry.key,
        away: entry.away,
        home: entry.home,
        startDetail: entry.startDetail,
        state: entry.state,
        players,
      });
    }
    return out;
  }, [lines, teamToGame]);

  const trimmedSearch = search.trim().toLowerCase();

  const expandedSet = useMemo(() => {
    if (grouped.length === 0) return new Set<string>();
    if (trimmedSearch.length > 0) {
      const s = new Set<string>();
      for (const g of grouped) {
        if (g.players.some((p) => p.playerName.toLowerCase().includes(trimmedSearch))) {
          s.add(g.matchupKey);
        }
      }
      return s;
    }
    const auto = new Set(grouped.slice(0, HOW_MANY_AUTO_EXPAND).map((g) => g.matchupKey));
    const out = new Set(auto);
    for (const id of manuallyExpanded) {
      if (out.has(id)) out.delete(id);
      else out.add(id);
    }
    return out;
  }, [grouped, trimmedSearch, manuallyExpanded]);

  // Top edges across the slate.
  const topEdges = useMemo(() => {
    if (grouped.length === 0) return [];
    const all: Array<{ game: GameGroup; player: UiPlayer }> = [];
    for (const g of grouped) {
      for (const p of g.players) {
        if (p.lines.length > 0) all.push({ game: g, player: p });
      }
    }
    return all
      .sort((a, b) => (b.player.lines[0]?.edgePercent ?? 0) - (a.player.lines[0]?.edgePercent ?? 0))
      .slice(0, 5);
  }, [grouped]);

  if (error) {
    return (
      <div className="mlb-info-banner mlb-info-error" style={{ marginTop: 16 }}>
        Couldn't load player breakdown: {error}
      </div>
    );
  }
  if (!lines || !games) {
    return <Skeleton width="100%" height={500} style={{ marginTop: 16 }} />;
  }
  if (grouped.length === 0) {
    return (
      <div className="mlb-info-banner" style={{ marginTop: 16 }}>
        No projected players for today's slate yet.
      </div>
    );
  }

  const totalPlayers = grouped.reduce((s, g) => s + g.players.length, 0);
  const totalLines = grouped.reduce(
    (s, g) => s + g.players.reduce((ps, p) => ps + p.lines.length, 0),
    0,
  );

  return (
    <div style={{ marginTop: 16 }}>
      {topEdges.length > 0 && <TopInstitutionalEdges entries={topEdges} />}

      <div className="mlb-context-heading" style={{ marginBottom: 8, marginTop: 24, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span>Browse all players by game</span>
        <span className="muted small">
          {totalPlayers} players · {totalLines} lines · {grouped.length} games
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
          marginBottom: 8,
        }}
      />

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {(Object.keys(FILTER_LABELS) as FilterTag[]).map((tag) => {
          const active = activeFilter === tag;
          return (
            <button
              key={tag}
              type="button"
              onClick={() => setActiveFilter(tag)}
              title={FILTER_TOOLTIPS[tag]}
              style={{
                padding: '5px 10px',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                borderRadius: 4,
                cursor: 'pointer',
                background: active ? 'rgba(122, 162, 255, 0.18)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${active ? 'rgba(122, 162, 255, 0.5)' : 'rgba(255,255,255,0.1)'}`,
                color: active ? '#7aa2ff' : 'rgba(255,255,255,0.7)',
              }}
            >
              {FILTER_LABELS[tag]}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {grouped.map((game) => (
          <GameCard
            key={game.matchupKey}
            game={game}
            expanded={expandedSet.has(game.matchupKey)}
            onToggle={() => {
              setManuallyExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(game.matchupKey)) next.delete(game.matchupKey);
                else next.add(game.matchupKey);
                return next;
              });
            }}
            search={trimmedSearch}
            activeFilter={activeFilter}
          />
        ))}
      </div>
    </div>
  );
}

// NBA blue accent (vs MLB green) — same hero structure.
function TopInstitutionalEdges({
  entries,
}: {
  entries: Array<{ game: GameGroup; player: UiPlayer }>;
}) {
  return (
    <div
      style={{
        marginBottom: 20,
        padding: '14px 16px',
        background: 'linear-gradient(135deg, rgba(122, 162, 255, 0.10), rgba(102, 187, 106, 0.04))',
        border: '1px solid rgba(122, 162, 255, 0.30)',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: '0.02em' }}>
          🔥 Top Institutional Edges
        </span>
        <span className="muted small">
          highest-conviction picks across the board · sorted by edge %
        </span>
        <span
          title={EDGE_TOOLTIP}
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            color: 'rgba(255,255,255,0.5)',
            cursor: 'help',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '50%',
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ?
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 10,
        }}
      >
        {entries.map(({ game, player }, i) => {
          const top = player.lines[0]!;
          const isOver = top.direction === 'OVER';
          return (
            <div
              key={`${player.playerId}-${i}`}
              style={{
                background: 'rgba(0,0,0,0.18)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 6,
                padding: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <PlayerAvatar playerId={player.playerId} name={player.playerName} size="md" />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {player.playerName}
                  </div>
                  <div className="muted small" style={{ fontSize: 10 }}>
                    {player.team ?? '—'} · {game.away?.abbreviation} @ {game.home?.abbreviation}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                {top.statLabel} {top.line}
                <span style={{ marginLeft: 6, color: top.probability >= 70 ? '#66bb6a' : '#7aa2ff' }}>
                  {isOver ? '↑' : '↓'} {Math.round(top.probability)}%
                </span>
              </div>
              <div
                title={EDGE_TOOLTIP}
                style={{
                  fontSize: 18,
                  fontWeight: 800,
                  color: top.edgePercent >= 0 ? '#66bb6a' : '#ef5350',
                  cursor: 'help',
                }}
              >
                {top.edgePercent >= 0 ? '+' : ''}{top.edgePercent.toFixed(0)}% EDGE
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GameCard({
  game,
  expanded,
  onToggle,
  search,
  activeFilter,
}: {
  game: GameGroup;
  expanded: boolean;
  onToggle: () => void;
  search: string;
  activeFilter: FilterTag;
}) {
  const live = game.state === 'in';
  const final = game.state === 'post';

  const filteredPlayers = game.players
    .filter((p) => passesFilter(p, activeFilter))
    .filter((p) => !search || p.playerName.toLowerCase().includes(search));

  if (activeFilter !== 'all' && !search && filteredPlayers.length === 0) {
    return null;
  }

  // Find the ESPN gameId so the "Full matchup →" link can deep-link.
  // We don't have it directly on GameGroup but the away team's
  // abbreviation pair maps back to the games list at the parent.
  const matchupHref = game.away && game.home
    ? `/compare?m=tvt&ta=${teamIdFromAbbr(game.away.abbreviation) ?? 0}&tb=${teamIdFromAbbr(game.home.abbreviation) ?? 0}`
    : '#';

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
        {game.away && <TeamLogo abbr={game.away.abbreviation} name={game.away.displayName} size="md" />}
        <span style={{ fontSize: 15, fontWeight: 700 }}>
          {game.away?.abbreviation ?? '—'}
          {game.away?.record && (
            <span className="muted small" style={{ marginLeft: 6, fontWeight: 400 }}>
              ({game.away.record})
            </span>
          )}
          <span style={{ margin: '0 8px', opacity: 0.5 }}>@</span>
        </span>
        {game.home && <TeamLogo abbr={game.home.abbreviation} name={game.home.displayName} size="md" />}
        <span style={{ fontSize: 15, fontWeight: 700 }}>
          {game.home?.abbreviation ?? '—'}
          {game.home?.record && (
            <span className="muted small" style={{ marginLeft: 6, fontWeight: 400 }}>
              ({game.home.record})
            </span>
          )}
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
            {live ? '● LIVE' : final ? 'FINAL' : (game.startDetail ?? 'Pre-Game')}
          </span>
        </span>
      </button>

      {expanded && (
        <div style={{ padding: '12px 16px 16px' }}>
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
            <span className="muted small">{game.startDetail ?? '—'}</span>
            <Link
              to={matchupHref}
              style={{ marginLeft: 'auto', color: '#7aa2ff', textDecoration: 'none', fontWeight: 700 }}
            >
              Compare teams →
            </Link>
          </div>

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

function PlayerCard({ player }: { player: UiPlayer }) {
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
        <PlayerAvatar playerId={player.playerId} name={player.playerName} size="md" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {player.playerName}
          </div>
          <div className="muted small" style={{ display: 'flex', gap: 6 }}>
            <span>{player.team ?? '—'}</span>
            {player.position && <span style={{ color: '#7aa2ff' }}>{player.position}</span>}
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

function LineRow({ line, highlight }: { line: UiLine; highlight?: boolean }) {
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
        title={EDGE_TOOLTIP}
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: line.edgePercent >= 5 ? '#66bb6a' : line.edgePercent <= -5 ? '#ef5350' : 'rgba(255,255,255,0.5)',
          minWidth: 50,
          textAlign: 'right',
          cursor: 'help',
        }}
      >
        {line.edgePercent >= 0 ? '+' : ''}{line.edgePercent.toFixed(0)}% edge
      </span>
    </div>
  );
}

