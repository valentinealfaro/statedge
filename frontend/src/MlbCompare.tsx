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
  getMlbProjection,
  getMlbStats,
  searchMlbPlayers,
  type MlbHealth,
  type MlbLast10Response,
  type MlbProjectionResponse,
  type MlbSearchPlayer,
  type MlbStatMeta,
} from './api';
import { MlbPlayersByGame } from './MlbPlayersByGame';
import { MlbTodaysGames } from './MlbTodaysGames';
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
  const [projection, setProjection] = useState<MlbProjectionResponse | null>(null);
  const [projectionLoading, setProjectionLoading] = useState(false);

  // Health check — surfaces the empty-DB state honestly so users know
  // why search returns nothing on a fresh install. Auto-retries once
  // after a short delay so a brief deploy hiccup doesn't strand users
  // on an error banner.
  const [healthAttempt, setHealthAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setHealthError(null);
    getMlbHealth()
      .then((h) => { if (!cancelled) setHealth(h); })
      .catch((err: Error) => {
        if (cancelled) return;
        if (healthAttempt === 0) {
          window.setTimeout(() => {
            if (!cancelled) setHealthAttempt((n) => n + 1);
          }, 1500);
        } else {
          setHealthError(err.message);
        }
      });
    return () => { cancelled = true; };
  }, [healthAttempt]);

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
      setProjection(null);
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

    // Projection only fires when a line is provided. Without a line
    // there's nothing to project against — empty state stays clean.
    if (!includeLine) {
      setProjection(null);
      setProjectionLoading(false);
      return;
    }
    setProjectionLoading(true);
    getMlbProjection({
      playerId: selectedPlayer.id,
      stat: selectedStat,
      line: lineNum,
      direction,
    })
      .then((r) => {
        setProjection(r);
        setProjectionLoading(false);
      })
      .catch(() => {
        // Projection failure shouldn't block the L10 view — silently
        // drop it. The user still sees their distribution.
        setProjection(null);
        setProjectionLoading(false);
      });
  }, [selectedPlayer, selectedStat, lineInput, direction]);

  const dbReady = health?.ready ?? false;

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <MlbTodaysGames />
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
            Couldn't reach the MLB API: {healthError}.{' '}
            <button
              type="button"
              className="mlb-retry-btn"
              onClick={() => setHealthAttempt((n) => n + 1)}
            >
              Retry
            </button>
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
            <>
              <a
                className="mlb-clear-player"
                style={{ marginRight: 6, textDecoration: 'none' }}
                href={`/mlb/player/${selectedPlayer.id}${selectedStat ? `?stat=${selectedStat}` : ''}${lineInput && selectedStat ? `&line=${lineInput}` : ''}`}
                title="Open the full season game-by-game log for this player + stat."
              >
                Season log →
              </a>
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
            </>
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

        {projectionLoading && (
          <Skeleton width="100%" height={140} style={{ marginTop: 16 }} />
        )}
        {!projectionLoading && projection && <ProjectionPanel data={projection} />}

        {/* Per-player browse view — game-grouped accordion + search.
            Sits at the bottom of /mlb/compare so users can scan the
            whole night's board after their search/comparison work. */}
        <MlbPlayersByGame />

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

// Projection panel — surfaces what the model thinks about the line.
// Mission-aligned: probability + edge + risk + trap, plus the
// reason codes that explain WHY. No "lock" language; the soft 5-95%
// cap on the probability is the engine's regression-to-the-mean
// discipline made visible.
function ProjectionPanel({ data }: { data: MlbProjectionResponse }) {
  const evVerdict =
    data.evScore >= 12 ? { label: 'Positive EV', cls: 'ev-pos' }
    : data.evScore >= -2 ? { label: 'Neutral EV', cls: 'ev-neutral' }
    : { label: 'Negative EV', cls: 'ev-neg' };

  const trapClass =
    data.trapScore <= 20 ? 'trap-clean'
    : data.trapScore <= 40 ? 'trap-mild'
    : data.trapScore <= 60 ? 'trap-moderate'
    : data.trapScore <= 80 ? 'trap-high'
    : 'trap-extreme';

  return (
    <div className="mlb-projection">
      <div className="mlb-projection-head">
        <h3>Model projection</h3>
        <span className={`mlb-projection-verdict ${evVerdict.cls}`}>
          {evVerdict.label}
        </span>
      </div>

      {data.lineRaised && data.originalLine !== null && (
        <div className="mlb-line-raised"
             title="Elite-conviction signal — model still favors this direction even at a raised line. Probability and edge below reflect the raised line, not the original. PrizePicks doesn't actually offer alternate lines for most props, so this is analytical confidence, not a bookable bet.">
          ↑ Line raised: <strong>{data.originalLine} → {data.line}</strong>
          {data.originalProbability !== null && (
            <span className="mlb-line-raised-probs">
              {' · '}probability {data.originalProbability.toFixed(0)}% → {data.probability.toFixed(0)}%
            </span>
          )}
        </div>
      )}

      <div className="mlb-projection-grid">
        <div className="mlb-stat" title="Model's projected stat value for the upcoming game">
          <span className="mlb-stat-label">Projection</span>
          <span className="mlb-stat-value">{data.projection.toFixed(2)}</span>
        </div>
        <div className="mlb-stat" title="Probability the line hits in the chosen direction. Capped at 5-95% — no fake locks.">
          <span className="mlb-stat-label">Probability</span>
          <span className="mlb-stat-value">{data.probability.toFixed(1)}%</span>
        </div>
        <div className="mlb-stat" title="Model probability minus 50% break-even baseline">
          <span className="mlb-stat-label">Edge</span>
          <span className="mlb-stat-value">
            {data.edgePercent >= 0 ? '+' : ''}{data.edgePercent.toFixed(1)}%
          </span>
        </div>
        <div
          className={`mlb-stat ${confidenceClass(data.confidence)}`}
          title="L10 — 6-component composite: sampleQuality + projectionAgreement + matchupClarity + opportunityCertainty + calibrationStrength + dataCompleteness. Bands: 0-39 Weak / 40-59 Medium / 60-74 Strong / 75-89 Elite / 90+ Institutional (extremely rare per spec)."
        >
          <span className="mlb-stat-label">Confidence</span>
          <span className="mlb-stat-value">{data.confidence}/100</span>
          <span className="mlb-stat-sub">{data.confidenceTier}</span>
        </div>
        <div className="mlb-stat" title="Variance + stat-type risk. Higher = more fragile.">
          <span className="mlb-stat-label">Risk</span>
          <span className="mlb-stat-value">{data.riskScore}/100</span>
        </div>
        <div className={`mlb-stat ${trapClass}`} title={data.trapTier}>
          <span className="mlb-stat-label">Trap score</span>
          <span className="mlb-stat-value">{data.trapScore}/100</span>
        </div>
        <div
          className={`mlb-stat ${fragilityClass(data.fragilityScore)}`}
          title="L5 Fragility — how little must go wrong for this pick to fail. SEPARATE from probability + trap. Components: stat rarity (HR/SB are inherently fragile), margin thinness (projection vs line), sample weakness, volatility, lineup uncertainty."
        >
          <span className="mlb-stat-label">Fragility</span>
          <span className="mlb-stat-value">{data.fragilityScore.toFixed(0)}/100</span>
          <span className="mlb-stat-sub">{data.fragilityTier}</span>
        </div>
        <div
          className={`mlb-stat ${momentumClass(data.momentumExpansionScore)}`}
          title="L2 composite — production lift (L5/L10), season lift (L10/season), projection separation, L10 hit rate. Direction-aware. 50 = neutral, ≥65 = real momentum, ≤35 = anti-momentum."
        >
          <span className="mlb-stat-label">Momentum</span>
          <span className="mlb-stat-value">
            {data.momentumExpansionScore.toFixed(0)}/100
          </span>
          <span className="mlb-stat-sub">
            {momentumLabel(data.momentumExpansionScore)}
          </span>
        </div>
      </div>

      <div className="mlb-projection-eligibility">
        <span className="mlb-elig-label">Card eligibility:</span>
        <span className={`mlb-elig-chip ${data.qualifiesForCards.safe ? 'on' : 'off'}`}>
          {data.qualifiesForCards.safe ? '✓' : '✗'} Safe
        </span>
        <span className={`mlb-elig-chip ${data.qualifiesForCards.balanced ? 'on' : 'off'}`}>
          {data.qualifiesForCards.balanced ? '✓' : '✗'} Balanced
        </span>
      </div>

      <ContextAdjustments data={data} />

      {data.robustBaselineComponents && (
        <RobustBaselinePanel components={data.robustBaselineComponents} />
      )}

      <FragilityPanel
        score={data.fragilityScore}
        tier={data.fragilityTier}
        components={data.fragilityComponents}
      />

      <ConfidencePanel
        score={data.confidence}
        tier={data.confidenceTier}
        components={data.confidenceComponents}
      />

      {data.monteCarlo && <MonteCarloBands data={data} />}

      {data.reasonCodes.length > 0 && (
        <ul className="mlb-projection-reasons">
          {data.reasonCodes.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Monte Carlo distribution panel. Shows P10/P25/P50/P75/P90 along
// with the line, ceiling/floor tier labels, and the simulated
// probability for sanity-check against the deterministic engine.
// Mission-aligned: floor/ceiling shape per pick, not just point
// estimate. "Aaron Judge HR projection 1.7 with P10=0 / P90=4."
function MonteCarloBands({ data }: { data: MlbProjectionResponse }) {
  const mc = data.monteCarlo;
  if (!mc) return null;
  const p = mc.percentiles;
  // Determine the visual range the bands span — pad a bit beyond P90
  // and below 0 so the line marker has breathing room.
  const range = Math.max(p.p90, 1) * 1.1;
  const cls = (tier: 'high' | 'medium' | 'low') => `mc-tier-${tier}`;
  return (
    <div className="mlb-monte-carlo">
      <div className="mlb-monte-carlo-head">
        <h3>Monte Carlo distribution</h3>
        <span className="mlb-mc-draws">{mc.draws.toLocaleString()} draws</span>
      </div>
      <div className="mlb-mc-row">
        <Pct label="P10" value={p.p10} />
        <Pct label="P25" value={p.p25} />
        <Pct label="P50" value={p.p50} />
        <Pct label="P75" value={p.p75} />
        <Pct label="P90" value={p.p90} />
      </div>
      {/* Visual band — line marker is positioned by ratio. */}
      <div className="mlb-mc-bar-wrapper" title={`Simulated ${mc.simulatedProbability.toFixed(1)}% probability of clearing the line`}>
        <div
          className="mlb-mc-bar-band"
          style={{
            left: `${Math.min(100, (p.p10 / range) * 100)}%`,
            width: `${Math.max(2, ((p.p90 - p.p10) / range) * 100)}%`,
          }}
        />
        <div
          className="mlb-mc-bar-median"
          style={{ left: `${Math.min(100, (p.p50 / range) * 100)}%` }}
          aria-label="P50"
        />
      </div>
      <div className="mlb-mc-tiers">
        <span className={`mlb-mc-tier ${cls(mc.ceilingTier)}`}>
          Ceiling: <strong>{mc.ceilingTier}</strong>
        </span>
        <span className={`mlb-mc-tier ${cls(mc.floorTier)}`}>
          Floor: <strong>{mc.floorTier}</strong>
        </span>
        <span className="mlb-mc-sim-prob" title="Simulated hit probability — sanity-check against deterministic engine.">
          Sim: {mc.simulatedProbability.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

function Pct({ label, value }: { label: string; value: number }) {
  return (
    <div className="mlb-mc-pct">
      <span className="mlb-mc-pct-label">{label}</span>
      <span className="mlb-mc-pct-value">{value.toFixed(2)}</span>
    </div>
  );
}

// Context adjustment panel — surfaces park / weather / lineup / BvP
// multipliers so the user can see what's driving the projection
// beyond raw player history. Pitch arsenal + bullpen render with
// "data unavailable" labels because their data sources aren't
// connected yet (Statcast / reliever workload). Mission-aligned:
// honest about what's wired vs not, no fake completeness.
function ContextAdjustments({ data }: { data: MlbProjectionResponse }) {
  const c = data.contextAdjustments;
  // Skip the panel entirely when nothing is non-neutral and the
  // scaffolds are off — keeps the UI clean for player-history-only
  // projections (no gamePk supplied).
  const hasAnyContext =
    c.park !== 1 || c.weather !== 1 || c.lineup !== 1 || c.bvp !== 1 || c.gameScript !== 1;
  if (!hasAnyContext) {
    return (
      <div className="mlb-context muted-context">
        <strong>Context:</strong> player history only. Add an upcoming
        gamePk to apply park / weather / lineup / BvP adjustments.
      </div>
    );
  }
  return (
    <div className="mlb-context">
      <div className="mlb-context-heading">Context adjustments</div>
      <div className="mlb-context-grid">
        <ContextChip label="Park"     mult={c.park}     wired />
        <ContextChip label="Weather"  mult={c.weather}  wired />
        <ContextChip label="Lineup"   mult={c.lineup}   wired />
        <ContextChip label="BvP"      mult={c.bvp}      wired />
        <ContextChip label="Game Script" mult={c.gameScript} wired />
        <ContextChip label="Arsenal"  mult={c.pitchArsenal} wired={false} />
        <ContextChip label="Bullpen"  mult={c.bullpen}      wired={false} />
      </div>
      {data.baselineProjection !== data.projection && (
        <div className="mlb-context-baseline">
          Baseline {data.baselineProjection.toFixed(2)}{' '}
          → adjusted {data.projection.toFixed(2)}
        </div>
      )}
    </div>
  );
}

function ContextChip({ label, mult, wired }: { label: string; mult: number; wired: boolean }) {
  if (!wired) {
    return (
      <div className="mlb-context-chip neutral" title="Data source not yet connected — defaults to neutral.">
        <span className="mlb-context-label">{label}</span>
        <span className="mlb-context-value">N/A</span>
      </div>
    );
  }
  const pct = Math.round((mult - 1) * 100);
  const cls =
    Math.abs(pct) < 2 ? 'neutral'
    : pct > 0 ? 'positive'
    : 'negative';
  return (
    <div className={`mlb-context-chip ${cls}`}>
      <span className="mlb-context-label">{label}</span>
      <span className="mlb-context-value">
        {pct > 0 ? '+' : ''}{pct}%
      </span>
    </div>
  );
}

// L1 baseline composition — surfaces the 7-window blend the engine
// uses as the projection anchor (per the institutional MLB
// Intelligence Engine spec). Collapsible to keep the Compare page
// scannable; expand to audit how the projection was built.
function RobustBaselinePanel({
  components,
}: {
  components: {
    seasonAverage: number | null;
    last30Average: number | null;
    last20Average: number | null;
    last10Average: number | null;
    last5Average: number | null;
    median: number | null;
    trimmedMean: number | null;
  };
}) {
  const rows: Array<{ label: string; value: number | null; hint: string }> = [
    { label: 'Season',      value: components.seasonAverage,  hint: 'Full-season mean' },
    { label: 'Last 30',     value: components.last30Average,  hint: 'Most-recent 30 games (≥15 required)' },
    { label: 'Last 20',     value: components.last20Average,  hint: 'Most-recent 20 games (≥10 required)' },
    { label: 'Last 10',     value: components.last10Average,  hint: 'Most-recent 10 games (≥5 required)' },
    { label: 'Last 5',      value: components.last5Average,   hint: 'Most-recent 5 games (≥3 required)' },
    { label: 'Median',      value: components.median,         hint: 'Outlier-resistant midpoint' },
    { label: 'Trim mean',   value: components.trimmedMean,    hint: 'Top + bottom 10% trimmed' },
  ];
  const present = rows.filter((r) => r.value !== null);
  if (present.length === 0) return null;
  return (
    <details className="mlb-context" style={{ cursor: 'pointer' }}>
      <summary className="mlb-context-heading">Baseline composition (L1) <span className="muted small">— click to expand</span></summary>
      <div className="mlb-context-grid" style={{ marginTop: 8 }}>
        {present.map((r) => (
          <div key={r.label} className="mlb-context-chip neutral" title={r.hint}>
            <span className="mlb-context-label">{r.label}</span>
            <span className="mlb-context-value">{r.value!.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

// L5 fragility components panel — surfaces the 5-component breakdown
// that built the fragility score so users see WHY a pick is fragile,
// not just that it is.
function FragilityPanel({
  score,
  tier,
  components,
}: {
  score: number;
  tier: string;
  components: {
    statRarity: number;
    marginThinness: number;
    sampleWeakness: number;
    volatility: number;
    lineupUncertainty: number | null;
  };
}) {
  const rows: Array<{ label: string; value: number; hint: string }> = [
    { label: 'Stat rarity',     value: components.statRarity,     hint: 'Rare events (HR, SB, triples) are inherently fragile.' },
    { label: 'Margin thinness', value: components.marginThinness, hint: '|projection − line| / max(projection, line). Razor-thin margins fail on a single bad swing.' },
    { label: 'Sample weakness', value: components.sampleWeakness, hint: 'Inverse of Bayesian sampleStrength. Small samples mean the projection itself is uncertain.' },
    { label: 'Volatility',      value: components.volatility,     hint: 'L10 stddev / projection. High coefficient of variation = fragile.' },
  ];
  if (components.lineupUncertainty !== null) {
    rows.push({
      label: 'Lineup uncertainty',
      value: components.lineupUncertainty,
      hint: 'Hitter only — confirmed lineup = 0; unconfirmed = 60.',
    });
  }
  return (
    <details className="mlb-context" style={{ cursor: 'pointer' }}>
      <summary className="mlb-context-heading">
        Fragility breakdown (L5) · {score.toFixed(0)}/100 · <em>{tier}</em> <span className="muted small">— click to expand</span>
      </summary>
      <div className="mlb-context-grid" style={{ marginTop: 8 }}>
        {rows.map((r) => (
          <div key={r.label} className={`mlb-context-chip ${fragilityComponentClass(r.value)}`} title={r.hint}>
            <span className="mlb-context-label">{r.label}</span>
            <span className="mlb-context-value">{r.value.toFixed(0)}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function fragilityComponentClass(value: number): string {
  if (value <= 25) return 'positive';     // low fragility = green
  if (value <= 60) return 'neutral';
  return 'negative';                      // high fragility = red
}

// L10 confidence breakdown — surfaces the 6-component spec composite
// so users see WHY a projection is or isn't trustworthy.
function ConfidencePanel({
  score,
  tier,
  components,
}: {
  score: number;
  tier: string;
  components: {
    sampleQuality: number;
    projectionAgreement: number;
    matchupClarity: number;
    opportunityCertainty: number;
    calibrationStrength: number;
    dataCompleteness: number;
  };
}) {
  const rows: Array<{ label: string; value: number; hint: string }> = [
    { label: 'Sample quality',        value: components.sampleQuality,        hint: 'L10 fill + season-vs-stabilization. 100 = full sample, threshold crossed.' },
    { label: 'Projection agreement',  value: components.projectionAgreement,  hint: 'Spread between L10 / L5 / season / opponent. Tight cluster = high score.' },
    { label: 'Matchup clarity',       value: components.matchupClarity,       hint: 'Opponent sample size + handedness known.' },
    { label: 'Opportunity certainty', value: components.opportunityCertainty, hint: 'Lineup confirmed + game context loaded (hitters); probable starter (pitchers).' },
    { label: 'Calibration strength',  value: components.calibrationStrength,  hint: 'Historical bucket accuracy. Neutral 50 until L9 has accumulated enough graded predictions.' },
    { label: 'Data completeness',     value: components.dataCompleteness,     hint: 'Count of context layers (park / weather / lineup / BvP / game-script) populated.' },
  ];
  return (
    <details className="mlb-context" style={{ cursor: 'pointer' }}>
      <summary className="mlb-context-heading">
        Confidence breakdown (L10) · {score}/100 · <em>{tier}</em> <span className="muted small">— click to expand</span>
      </summary>
      <div className="mlb-context-grid" style={{ marginTop: 8 }}>
        {rows.map((r) => (
          <div key={r.label} className={`mlb-context-chip ${confidenceComponentClass(r.value)}`} title={r.hint}>
            <span className="mlb-context-label">{r.label}</span>
            <span className="mlb-context-value">{r.value}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function confidenceComponentClass(value: number): string {
  if (value >= 75) return 'positive';
  if (value >= 40) return 'neutral';
  return 'negative';
}

function confidenceClass(score: number): string {
  if (score >= 90) return 'momentum-strong';
  if (score >= 75) return 'momentum-up';
  if (score >= 60) return 'momentum-up';
  if (score >= 40) return 'momentum-neutral';
  return 'momentum-cooling';
}

function fragilityClass(score: number): string {
  if (score <= 25) return 'trap-clean';
  if (score <= 50) return 'trap-mild';
  if (score <= 75) return 'trap-moderate';
  return 'trap-high';
}

function momentumClass(score: number): string {
  if (score >= 75) return 'momentum-strong';
  if (score >= 60) return 'momentum-up';
  if (score >= 40) return 'momentum-neutral';
  if (score >= 25) return 'momentum-cooling';
  return 'momentum-fading';
}

function momentumLabel(score: number): string {
  if (score >= 75) return 'Strong';
  if (score >= 60) return 'Expanding';
  if (score >= 40) return 'Neutral';
  if (score >= 25) return 'Cooling';
  return 'Fading';
}
