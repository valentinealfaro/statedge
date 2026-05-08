// WNBA Compare page — Phase 76. Lighter than NBA Compare's full
// PvT/PvP/TvT/Last-10 multi-mode UX since WNBA doesn't yet have a
// projection engine + comparison infrastructure (those land in
// Phases 77-78). What ships now is the highest-leverage subset:
//   - Player search (live ESPN typeahead)
//   - Last-10 games view with per-stat distribution (avg, range,
//     hit-rate-against-line input)
// Same mlb-compare-shell + mlb-info-banner visual language as MLB
// and NBA so the platform reads as one engine.

import { useEffect, useMemo, useRef, useState } from 'react';
import { WnbaPlayerAvatar } from './Avatar';
import {
  getWnbaPlayerGameLog,
  searchWnbaPlayers,
  type WnbaGameLogEntry,
  type WnbaGameLogResponse,
  type WnbaSearchPlayer,
} from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { WnbaTodaysGames } from './WnbaTodaysGames';
import { useTitle } from './useTitle';

// Stat catalog — same vocabulary the slate engine will use in Phase 77.
const STATS = [
  { key: 'points',   label: 'Points',   pick: (g: WnbaGameLogEntry) => g.points },
  { key: 'rebounds', label: 'Rebounds', pick: (g: WnbaGameLogEntry) => g.rebounds },
  { key: 'assists',  label: 'Assists',  pick: (g: WnbaGameLogEntry) => g.assists },
  { key: 'three_pt_made', label: '3PT Made', pick: (g: WnbaGameLogEntry) => g.threePtMade },
  { key: 'steals',   label: 'Steals',   pick: (g: WnbaGameLogEntry) => g.steals },
  { key: 'blocks',   label: 'Blocks',   pick: (g: WnbaGameLogEntry) => g.blocks },
  { key: 'turnovers', label: 'Turnovers', pick: (g: WnbaGameLogEntry) => g.turnovers },
  { key: 'pra',      label: 'P+R+A',    pick: (g: WnbaGameLogEntry) => g.points + g.rebounds + g.assists },
  { key: 'pr',       label: 'P+R',      pick: (g: WnbaGameLogEntry) => g.points + g.rebounds },
  { key: 'pa',       label: 'P+A',      pick: (g: WnbaGameLogEntry) => g.points + g.assists },
  { key: 'ra',       label: 'R+A',      pick: (g: WnbaGameLogEntry) => g.rebounds + g.assists },
  { key: 'stocks',   label: 'STL+BLK',  pick: (g: WnbaGameLogEntry) => g.steals + g.blocks },
];

export function WnbaCompare() {
  useTitle(['WNBA Compare']);
  const [selected, setSelected] = useState<WnbaSearchPlayer | null>(null);
  const [gamelog, setGamelog] = useState<WnbaGameLogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) { setGamelog(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setGamelog(null);
    getWnbaPlayerGameLog(selected.id)
      .then((d) => { if (!cancelled) setGamelog(d); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selected]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <WnbaTodaysGames />
        <h1>WNBA · Compare</h1>
        <p className="muted small">
          Search any active WNBA player; see their last-10 distribution
          across every standard prop stat. Pulled live from ESPN's
          gamelog feed; cached 5 min per player.
        </p>

        <PlayerSearch onSelect={setSelected} selected={selected} />

        {selected && loading && (
          <Skeleton width="100%" height={300} style={{ marginTop: 16 }} />
        )}
        {selected && error && (
          <div className="mlb-info-banner mlb-info-error" style={{ marginTop: 16 }}>
            {error}
          </div>
        )}
        {selected && gamelog && gamelog.games.length === 0 && (
          <div className="mlb-info-banner" style={{ marginTop: 16 }}>
            <strong>No games logged this season.</strong> ESPN doesn't show
            any games for {selected.displayName}. They may be inactive or
            on the IL — check the standings page for team rosters.
          </div>
        )}
        {selected && gamelog && gamelog.games.length > 0 && (
          <PlayerLast10View player={selected} games={gamelog.games} />
        )}

        {gamelog && (
          <p className="mlb-disclaimer">{gamelog.disclaimer}</p>
        )}
      </div>
    </div>
  );
}

// ---------- Player typeahead search ----------

function PlayerSearch({
  onSelect,
  selected,
}: {
  onSelect: (p: WnbaSearchPlayer | null) => void;
  selected: WnbaSearchPlayer | null;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WnbaSearchPlayer[]>([]);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Debounced search — 200ms.
  useEffect(() => {
    if (selected) {
      setOpen(false);
      return;
    }
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = window.setTimeout(() => {
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      searchWnbaPlayers(query, ctrl.signal)
        .then((r) => setResults(r))
        .catch(() => { /* aborted or failed silently */ });
    }, 200);
    return () => window.clearTimeout(t);
  }, [query, selected]);

  if (selected) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          background: 'rgba(122, 162, 255, 0.08)',
          border: '1px solid rgba(122, 162, 255, 0.3)',
          borderRadius: 6,
          marginTop: 12,
        }}
      >
        <WnbaPlayerAvatar playerId={selected.id} name={selected.displayName} size="lg" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{selected.displayName}</div>
          <div className="muted small">
            {selected.team ?? '—'}{selected.position && ` · ${selected.position}`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => { onSelect(null); setQuery(''); }}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 700,
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 4,
            color: 'rgba(255,255,255,0.7)',
            cursor: 'pointer',
          }}
        >
          Change player
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', marginTop: 12 }}>
      <input
        type="search"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search WNBA player by name…"
        style={{
          width: '100%',
          padding: '12px 14px',
          fontSize: 14,
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 6,
          background: 'rgba(255,255,255,0.04)',
          color: 'inherit',
        }}
      />
      {open && results.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            background: 'var(--surface-1, #0d1117)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            maxHeight: 320,
            overflowY: 'auto',
            zIndex: 100,
          }}
        >
          {results.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => { onSelect(p); setOpen(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <WnbaPlayerAvatar playerId={p.id} name={p.displayName} size="md" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{p.displayName}</div>
                <div className="muted small">
                  {p.team ?? '—'}{p.position && ` · ${p.position}`}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {open && query.trim().length >= 2 && results.length === 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            padding: 12,
            background: 'var(--surface-1, #0d1117)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6,
            color: 'rgba(255,255,255,0.5)',
            fontSize: 12,
          }}
        >
          No players matched "{query}".
        </div>
      )}
    </div>
  );
}

// ---------- Last 10 distribution view ----------

function PlayerLast10View({
  player,
  games,
}: {
  player: WnbaSearchPlayer;
  games: WnbaGameLogEntry[];
}) {
  const [statKey, setStatKey] = useState<string>('points');
  const [lineInput, setLineInput] = useState<string>('');
  const stat = STATS.find((s) => s.key === statKey) ?? STATS[0]!;

  const last10 = useMemo(() => games.slice(0, 10), [games]);
  const last5 = useMemo(() => games.slice(0, 5), [games]);
  const season = games;
  const values10 = last10.map((g) => stat.pick(g));
  const values5 = last5.map((g) => stat.pick(g));
  const valuesSeason = season.map((g) => stat.pick(g));

  const avg = (vs: number[]): number => vs.length === 0 ? 0 : vs.reduce((s, v) => s + v, 0) / vs.length;
  const median = (vs: number[]): number => {
    if (vs.length === 0) return 0;
    const s = [...vs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
  };

  const line = Number(lineInput);
  const validLine = Number.isFinite(line) && line > 0;
  const hitsAtLine10 = validLine ? values10.filter((v) => v > line).length : 0;
  const hitsAtLine5 = validLine ? values5.filter((v) => v > line).length : 0;
  const hitsAtLineSeason = validLine ? valuesSeason.filter((v) => v > line).length : 0;

  return (
    <>
      <div className="mlb-projection" style={{ marginTop: 16 }}>
        <div className="mlb-projection-head">
          <h3>{player.displayName} · {stat.label}</h3>
          <span className="muted small">
            {games.length} game{games.length === 1 ? '' : 's'} this season
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, marginBottom: 12 }}>
          {STATS.map((s) => {
            const active = statKey === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setStatKey(s.key)}
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
                {s.label}
              </button>
            );
          })}
        </div>

        <div className="mlb-projection-grid">
          <div className="mlb-stat" title={`Average across the last 10 games for ${stat.label}`}>
            <span className="mlb-stat-label">L10 Avg</span>
            <span className="mlb-stat-value">{avg(values10).toFixed(1)}</span>
            <span className="mlb-stat-sub">{values10.length} games</span>
          </div>
          <div className="mlb-stat" title={`Median across the last 10 games`}>
            <span className="mlb-stat-label">L10 Median</span>
            <span className="mlb-stat-value">{median(values10).toFixed(1)}</span>
          </div>
          <div className="mlb-stat" title={`Average across the last 5 games`}>
            <span className="mlb-stat-label">L5 Avg</span>
            <span className="mlb-stat-value">{avg(values5).toFixed(1)}</span>
            <span className="mlb-stat-sub">{values5.length} games</span>
          </div>
          <div className="mlb-stat" title={`Season-long average`}>
            <span className="mlb-stat-label">Season Avg</span>
            <span className="mlb-stat-value">{avg(valuesSeason).toFixed(1)}</span>
            <span className="mlb-stat-sub">{valuesSeason.length} games</span>
          </div>
          <div className="mlb-stat" title="Lowest value across the last 10">
            <span className="mlb-stat-label">L10 Min</span>
            <span className="mlb-stat-value">{values10.length === 0 ? '—' : Math.min(...values10)}</span>
          </div>
          <div className="mlb-stat" title="Highest value across the last 10">
            <span className="mlb-stat-label">L10 Max</span>
            <span className="mlb-stat-value">{values10.length === 0 ? '—' : Math.max(...values10)}</span>
          </div>
        </div>
      </div>

      <div className="mlb-context" style={{ marginTop: 12 }}>
        <div className="mlb-context-heading">Hit rate against a line</div>
        <p className="muted small" style={{ marginTop: 4 }}>
          Type a line value to see how often {player.displayName} cleared it.
          Hit rate is strict (&gt; line); ties count as misses.
        </p>
        <input
          type="number"
          inputMode="decimal"
          step="0.5"
          value={lineInput}
          onChange={(e) => setLineInput(e.target.value)}
          placeholder={`e.g. ${stat.label === 'Points' ? '18.5' : stat.label === 'Rebounds' ? '7.5' : stat.label === 'Assists' ? '5.5' : '1.5'}`}
          style={{
            width: 200,
            padding: '8px 12px',
            fontSize: 14,
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 4,
            background: 'rgba(255,255,255,0.04)',
            color: 'inherit',
            marginTop: 8,
          }}
        />
        {validLine && (
          <div className="mlb-projection-grid" style={{ marginTop: 12 }}>
            <div className="mlb-stat">
              <span className="mlb-stat-label">L5 vs {line}</span>
              <span className="mlb-stat-value" style={{ color: hitsAtLine5 / Math.max(1, values5.length) >= 0.6 ? '#66bb6a' : hitsAtLine5 / Math.max(1, values5.length) <= 0.4 ? '#ef5350' : undefined }}>
                {hitsAtLine5}/{values5.length}
              </span>
              <span className="mlb-stat-sub">
                {values5.length > 0 ? `${((hitsAtLine5 / values5.length) * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
            <div className="mlb-stat">
              <span className="mlb-stat-label">L10 vs {line}</span>
              <span className="mlb-stat-value" style={{ color: hitsAtLine10 / Math.max(1, values10.length) >= 0.6 ? '#66bb6a' : hitsAtLine10 / Math.max(1, values10.length) <= 0.4 ? '#ef5350' : undefined }}>
                {hitsAtLine10}/{values10.length}
              </span>
              <span className="mlb-stat-sub">
                {values10.length > 0 ? `${((hitsAtLine10 / values10.length) * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
            <div className="mlb-stat">
              <span className="mlb-stat-label">Season vs {line}</span>
              <span className="mlb-stat-value" style={{ color: hitsAtLineSeason / Math.max(1, valuesSeason.length) >= 0.6 ? '#66bb6a' : hitsAtLineSeason / Math.max(1, valuesSeason.length) <= 0.4 ? '#ef5350' : undefined }}>
                {hitsAtLineSeason}/{valuesSeason.length}
              </span>
              <span className="mlb-stat-sub">
                {valuesSeason.length > 0 ? `${((hitsAtLineSeason / valuesSeason.length) * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="mlb-context" style={{ marginTop: 12 }}>
        <div className="mlb-context-heading">Game log</div>
        <div className="mlb-game-twocol-scroll" style={{ marginTop: 8 }}>
          <table className="mlb-mini-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Opp</th>
                <th>Result</th>
                <th className="num">MIN</th>
                <th className="num">{stat.label}</th>
                {statKey !== 'points'    && <th className="num">PTS</th>}
                {statKey !== 'rebounds'  && <th className="num">REB</th>}
                {statKey !== 'assists'   && <th className="num">AST</th>}
              </tr>
            </thead>
            <tbody>
              {last10.map((g) => (
                <tr key={g.gameId}>
                  <td>{g.date}</td>
                  <td>{g.isHome ? `vs ${g.opponentAbbr}` : `@ ${g.opponentAbbr}`}</td>
                  <td style={{ color: g.result === 'W' ? 'var(--hot, #66bb6a)' : '#ef5350' }}>
                    <strong>{g.result ?? '—'}</strong> {g.score}
                  </td>
                  <td className="num">{g.minutes}</td>
                  <td className="num" style={{ fontWeight: 800 }}>{stat.pick(g)}</td>
                  {statKey !== 'points'    && <td className="num">{g.points}</td>}
                  {statKey !== 'rebounds'  && <td className="num">{g.rebounds}</td>}
                  {statKey !== 'assists'   && <td className="num">{g.assists}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
