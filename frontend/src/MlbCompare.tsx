// MLB compare page — Phase 2. Search a player, pick a stat, see their
// last-10 distribution with average / median / range / consistency /
// hit rate at any line. Mission-aligned: real analytical value, no
// hype copy, disclaimer always visible.
//
// Deliberately simple in v1. Charts / pitcher matchup / park context
// land in Phase 3+ once the projection engine exists.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getMlbHealth,
  getMlbPlayerLast10,
  getMlbStats,
  searchMlbPlayers,
  type MlbHealth,
  type MlbLast10Response,
  type MlbSearchPlayer,
  type MlbStatMeta,
} from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

export function MlbCompare() {
  useTitle(['MLB Compare']);

  const [health, setHealth] = useState<MlbHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MlbSearchPlayer[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState<MlbSearchPlayer | null>(null);
  const [stats, setStats] = useState<MlbStatMeta[]>([]);
  const [selectedStat, setSelectedStat] = useState<string | null>(null);
  const [lineInput, setLineInput] = useState('');
  const [direction, setDirection] = useState<'OVER' | 'UNDER'>('OVER');
  const [last10, setLast10] = useState<MlbLast10Response | null>(null);
  const [last10Error, setLast10Error] = useState<string | null>(null);
  const [last10Loading, setLast10Loading] = useState(false);

  // Health check — surfaces the empty-DB state honestly so users know
  // why search returns nothing on a fresh install.
  useEffect(() => {
    getMlbHealth()
      .then(setHealth)
      .catch((err: Error) => setHealthError(err.message));
  }, []);

  // Debounced player search. 300ms is enough to feel snappy without
  // hammering the backend on every keystroke.
  const searchTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (searchTimerRef.current) {
      window.clearTimeout(searchTimerRef.current);
    }
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    searchTimerRef.current = window.setTimeout(() => {
      searchMlbPlayers(query)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    };
  }, [query]);

  // When a player is picked, load the stat list for their type and
  // pick a sensible default (hits for hitters, ks for pitchers).
  useEffect(() => {
    if (!selectedPlayer) {
      setStats([]);
      setSelectedStat(null);
      setLast10(null);
      return;
    }
    getMlbStats(selectedPlayer.playerType)
      .then((s) => {
        setStats(s);
        const defaultStat =
          selectedPlayer.playerType === 'hitter' ? 'hits' : 'ks';
        setSelectedStat(s.find((x) => x.key === defaultStat)?.key ?? s[0]?.key ?? null);
      })
      .catch(() => {
        setStats([]);
        setSelectedStat(null);
      });
    // Reset line input when switching players so a stale line from a
    // previous pick doesn't carry over.
    setLineInput('');
  }, [selectedPlayer]);

  // Fetch last-10 whenever player + stat (and optionally line) change.
  useEffect(() => {
    if (!selectedPlayer || !selectedStat) {
      setLast10(null);
      return;
    }
    const lineNum = lineInput.trim() === '' ? undefined : Number(lineInput);
    const includeLine =
      lineNum !== undefined && Number.isFinite(lineNum) && lineNum >= 0;
    setLast10Loading(true);
    setLast10Error(null);
    getMlbPlayerLast10({
      playerId: selectedPlayer.id,
      stat: selectedStat,
      line: includeLine ? lineNum : undefined,
      direction: includeLine ? direction : undefined,
    })
      .then((r) => {
        setLast10(r);
        setLast10Loading(false);
      })
      .catch((err: Error) => {
        setLast10(null);
        setLast10Error(err.message);
        setLast10Loading(false);
      });
  }, [selectedPlayer, selectedStat, lineInput, direction]);

  const dbReady = health?.ready ?? false;

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>MLB · Player Last 10</h1>
        <p className="muted small">
          Search a player, pick a stat, optionally enter a line. Returns
          the most recent 10 games with average, median, range,
          consistency, and hit rate against your line.
        </p>

        {!dbReady && health && (
          <div className="mlb-info-banner">
            <strong>MLB data is still seeding.</strong> The first sync hasn't
            populated player stats yet. Counts so far: {health.counts.teams} teams,{' '}
            {health.counts.players} players, {health.counts.games} games,{' '}
            {health.counts.hittingStats + health.counts.pitchingStats} stat rows.
            Trigger the GitHub workflow "Sync MLB data to Neon" to seed the
            DB, then refresh this page.
          </div>
        )}
        {healthError && (
          <div className="mlb-info-banner mlb-info-error">
            Couldn't reach the MLB API: {healthError}
          </div>
        )}

        <section className="mlb-search-section">
          <label className="mlb-label" htmlFor="mlb-player-input">
            Player
          </label>
          <input
            id="mlb-player-input"
            type="text"
            className="mlb-search-input"
            placeholder="Type a name (e.g. Aaron Judge, Chris Sale)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          {searching && <p className="muted small">Searching…</p>}
          {!searching && results.length > 0 && !selectedPlayer && (
            <ul className="mlb-search-results">
              {results.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="mlb-search-result"
                    onClick={() => {
                      setSelectedPlayer(p);
                      setQuery(p.fullName);
                      setResults([]);
                    }}
                  >
                    <span className="mlb-search-name">{p.fullName}</span>
                    <span className="mlb-search-meta">
                      {p.team?.abbreviation ?? '—'} · {p.position ?? '?'}
                      {' · '}
                      <em>{p.playerType}</em>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!searching && query.trim().length >= 2 && results.length === 0 && !selectedPlayer && (
            <p className="muted small">No active players match "{query}".</p>
          )}
          {selectedPlayer && (
            <button
              type="button"
              className="mlb-clear-player"
              onClick={() => {
                setSelectedPlayer(null);
                setQuery('');
              }}
            >
              Clear
            </button>
          )}
        </section>

        {selectedPlayer && stats.length > 0 && (
          <section className="mlb-stat-section">
            <label className="mlb-label" htmlFor="mlb-stat-select">
              Stat
            </label>
            <select
              id="mlb-stat-select"
              className="mlb-stat-select"
              value={selectedStat ?? ''}
              onChange={(e) => setSelectedStat(e.target.value)}
            >
              {stats.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>

            <label className="mlb-label" htmlFor="mlb-line-input" style={{ marginTop: 12 }}>
              Line (optional — drives hit rate)
            </label>
            <div className="mlb-line-row">
              <input
                id="mlb-line-input"
                type="number"
                step="0.5"
                min="0"
                className="mlb-line-input"
                placeholder="e.g. 1.5"
                value={lineInput}
                onChange={(e) => setLineInput(e.target.value)}
              />
              <div className="mlb-direction-toggle">
                <button
                  type="button"
                  className={`mlb-dir-btn ${direction === 'OVER' ? 'active' : ''}`}
                  onClick={() => setDirection('OVER')}
                >
                  Over
                </button>
                <button
                  type="button"
                  className={`mlb-dir-btn ${direction === 'UNDER' ? 'active' : ''}`}
                  onClick={() => setDirection('UNDER')}
                >
                  Under
                </button>
              </div>
            </div>
          </section>
        )}

        {last10Loading && (
          <Skeleton width="100%" height={200} style={{ marginTop: 24 }} />
        )}
        {last10Error && (
          <div className="mlb-info-banner mlb-info-error">{last10Error}</div>
        )}
        {!last10Loading && last10 && <Last10Display data={last10} />}

        {/* Compliance disclaimer — always rendered when MLB analytics
            are visible. Sourced from the API so the wording stays in
            sync with the backend constant. */}
        {(last10 || dbReady) && (
          <p className="mlb-disclaimer">
            {last10?.disclaimer ?? health?.disclaimer ?? ''}
          </p>
        )}
      </div>
    </div>
  );
}

function Last10Display({ data }: { data: MlbLast10Response }) {
  const trendChip = useMemo(() => {
    if (data.trend === null) return null;
    if (Math.abs(data.trend) < 0.05) {
      return { label: 'Flat', cls: 'mlb-trend-flat' };
    }
    if (data.trend > 0) return { label: `+${data.trend.toFixed(2)}`, cls: 'mlb-trend-up' };
    return { label: data.trend.toFixed(2), cls: 'mlb-trend-down' };
  }, [data.trend]);

  if (data.sampleSize === 0) {
    return (
      <div className="mlb-info-banner">
        No game-log data yet for this player + stat. Either the season hasn't
        started or the sync hasn't covered this player's games.
      </div>
    );
  }

  return (
    <div className="mlb-last10">
      <div className="mlb-last10-summary">
        <Stat label="Average" value={data.average.toFixed(2)} />
        <Stat label="Median" value={data.median.toFixed(2)} />
        <Stat label="High" value={String(data.high)} />
        <Stat label="Low" value={String(data.low)} />
        <Stat label="Sample" value={`${data.sampleSize} games`} />
        <Stat
          label="Consistency"
          value={`${data.consistencyScore}/100`}
          hint="100 = perfectly stable; 0 = wildly volatile."
        />
        {data.last5Average !== null && (
          <Stat label="Last 5" value={data.last5Average.toFixed(2)} />
        )}
        {trendChip && (
          <div className={`mlb-stat ${trendChip.cls}`}>
            <span className="mlb-stat-label">L5 vs L10 trend</span>
            <span className="mlb-stat-value">{trendChip.label}</span>
          </div>
        )}
      </div>

      {data.hitRate && (
        <div className="mlb-hit-rate">
          <strong>Hit rate against {data.hitRate.line} {data.hitRate.direction}:</strong>{' '}
          {data.hitRate.hits} of {data.hitRate.games} ({data.hitRate.rate}%)
        </div>
      )}

      <h3 className="mlb-games-heading">Game-by-game (oldest → newest)</h3>
      <ol className="mlb-games-list">
        {data.games.map((g) => (
          <li key={g.gameId} className="mlb-game-row">
            <span className="mlb-game-date">{g.gameDate}</span>
            <span className="mlb-game-opp">
              {g.isHome === null ? '' : g.isHome ? 'vs' : '@'}{' '}
              {g.opponentTeamId !== null ? `Team ${g.opponentTeamId}` : '—'}
            </span>
            <span className="mlb-game-value">{g.value}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="mlb-stat" title={hint}>
      <span className="mlb-stat-label">{label}</span>
      <span className="mlb-stat-value">{value}</span>
    </div>
  );
}
