// /best-bets — cross-sport unified edge watchlist. Phase 147b + 148r.
//
// One page that pulls every projection-engine-scored prop across the
// NBA + MLB + UFC slates, ranks them by EV (or edge / probability /
// live status — user picks), and shows live verdicts inline.
// Bloomberg-watchlist-shaped: dense, numeric, sortable, scannable.
//
// UFC inclusion (Phase 148r): projections come from the moneyline-
// anchored Phase 136 engine (mma/projectionEngine.projectUfcProp),
// exposed via /api/mma/slate/projections. These are conservative
// market-anchored estimates, not the deeper fighter-stat fundamental
// engine that's still on the roadmap — but they're real enough to
// rank against NBA + MLB rows on the same EV scale. Live verdicts
// for the four supported UFC stat keys (sig_strikes / takedowns /
// knockdowns / control_time) tick from fightcenter (iter 44).
//
// Each row links to its source page (player profile with tonight's
// slate panel) so the watchlist is a discovery tool — you find what's
// interesting here, then drill into the source for the why.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMlbDailySlate,
  getTodaySlate,
  getUfcSlateProjections,
  liveGradeLegs,
  type EliteLegLiveState,
  type MlbDailySlateResponse,
  type SlateResponse,
  type UfcSlateProjectionsResponse,
} from './api';
import { ActivityFeed } from './ActivityFeed';
import { ClvTrustBanner } from './ClvTrustBanner';
import { NavBar } from './NavBar';
import { ProjectionBand } from './ProjectionBand';
import { Skeleton } from './Skeleton';
import { LiveVerdictPill } from './slateLiveState';
import { useStarredProps } from './starredProps';
import { TodayAtAGlance } from './TodayAtAGlance';
import { useTitle } from './useTitle';

type Sport = 'nba' | 'mlb' | 'mma';

// User-facing stat labels for UFC. Mirrors STAT_LABEL in MmaSlate /
// MmaFighterTonightSlate; kept local because the BestBets shape uses
// statLabel as a free-text field shared across sports.
const UFC_STAT_LABEL: Record<string, string> = {
  sig_strikes:     'Sig Strikes',
  rd1_sig_strikes: 'R1 Sig Strikes',
  takedowns:       'Takedowns',
  rd1_takedowns:   'R1 Takedowns',
  knockdowns:      'Knockdowns',
  rounds:          'Rounds',
  fight_time:      'Fight Time',
  fantasy_score:   'Fantasy',
  control_time:    'Control Time',
};

type UnifiedBet = {
  sport: Sport;
  playerId: number;
  // Optional ESPN athlete id for UFC rows — playerId collapses to 0
  // because UFC ids are alphanumeric, so we keep the canonical id here
  // for the href + the live-grade pass-through.
  espnAthleteId?: string;
  playerName: string;
  team: string | null;
  statKey: string;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  probability: number;       // 0..100
  edgePercent: number;       // can be negative
  marketImpliedProb: number | null;  // 0..100
  trapScore: number | null;
  fragilityScore: number | null;
  href: string;
  // Computed: EV per $1 stake = probability × payout − 1, where payout
  // is the standard 2x for a single-leg PrizePicks Flex.
  ev: number;                // -1..N
  // Projection band for confidence-interval rendering.
  projection: number | null;
  rangeLow: number | null;
  rangeHigh: number | null;
  // Per-leg reason codes from the projection engine — surfaced via
  // an inline-expand row so users can audit why the model picked it.
  reasonCodes: string[];
};

type SortKey = 'ev' | 'edge' | 'probability' | 'live';
type SortDir = 'desc' | 'asc';

const SPORT_LABEL: Record<Sport, string> = { nba: 'NBA', mlb: 'MLB', mma: 'UFC' };
const SPORT_COLOR: Record<Sport, string> = { nba: '#7aa2ff', mlb: '#66bb6a', mma: '#ef5350' };

// Single-leg payout assumption for EV computation. PrizePicks Flex
// pays roughly 2x on a 1-leg pick; this is the same constant the rest
// of the platform uses for honest EV math.
const SINGLE_LEG_PAYOUT = 2;

export function BestBetsToday() {
  useTitle(['Best Bets Today']);
  const [nba, setNba] = useState<SlateResponse | null>(null);
  const [mlb, setMlb] = useState<MlbDailySlateResponse | null>(null);
  const [ufc, setUfc] = useState<UfcSlateProjectionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('ev');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [sportFilter, setSportFilter] = useState<Sport | 'all'>('all');
  const [minEdge, setMinEdge] = useState<number>(5);
  const [liveByKey, setLiveByKey] = useState<Map<string, EliteLegLiveState>>(new Map());
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      getTodaySlate('balanced'),
      getMlbDailySlate(),
      getUfcSlateProjections(),
    ]).then(([n, m, u]) => {
      if (cancelled) return;
      if (n.status === 'fulfilled') setNba(n.value.resolved);
      else setError((n.reason as Error)?.message ?? 'NBA slate failed');
      if (m.status === 'fulfilled') setMlb(m.value);
      // UFC failure is silent — we don't want a UFC outage to mask
      // NBA + MLB content. The watchlist still shows the two sports
      // that did load. setUfc stays null and the UFC branch in
      // allBets contributes nothing.
      if (u.status === 'fulfilled') setUfc(u.value);
    });
    return () => { cancelled = true; };
  }, []);

  // Build the unified bet list once any of the three slates land.
  // Recomputed on every render — it's bounded by slate size (< 200
  // props per sport) and the work is cheap.
  const allBets = useMemo<UnifiedBet[]>(() => {
    const out: UnifiedBet[] = [];

    // NBA — pulls from `lines` directly. Each line carries a
    // projection block with edge.score + probability per direction.
    for (const l of nba?.lines ?? []) {
      const proj = l.projection;
      if (!proj || proj.noProjection) continue;
      const lean = (proj.edge.lean ?? '').toLowerCase();
      const direction: 'OVER' | 'UNDER' = lean.includes('under') ? 'UNDER' : 'OVER';
      const prob = direction === 'OVER' ? proj.probability.over : proj.probability.under;
      const edgePct = proj.edge.score ?? 0;
      // Backsolve implied from edge: implied = prob - edgePct (in pp).
      const implied = prob - edgePct;
      const ev = (prob / 100) * SINGLE_LEG_PAYOUT - 1;
      out.push({
        sport: 'nba',
        playerId: l.playerId,
        playerName: l.playerName,
        team: l.team,
        statKey: l.statKey,
        statLabel: l.statLabel,
        line: l.line,
        direction,
        probability: prob,
        edgePercent: edgePct,
        marketImpliedProb: implied,
        trapScore: null,
        fragilityScore: proj.fragility?.score ?? null,
        // Deep-link target: player profile, which now hosts a
        // tonight's-slate panel that surfaces this exact prop with
        // live verdict + star toggle. Better drill-in than the slate
        // root because the profile keeps the user on the player they
        // were looking at — and the panel is auto-filtered to them.
        href: `/nba/player/${l.playerId}`,
        ev,
        projection: proj.projection.final,
        rangeLow: proj.projection.rangeLow,
        rangeHigh: proj.projection.rangeHigh,
        // NBA exposes its reason codes as `modelNotes` (the projection
        // engine's natural-language audit trail). Same role as MLB's
        // reasonCodes; we surface them through the same expand UX.
        reasonCodes: proj.modelNotes ?? [],
      });
    }

    // MLB — combine across the day's combos with a leg-id de-dup so
    // legs that appear on multiple cards count once.
    if (mlb?.resolved) {
      const seen = new Set<string>();
      for (const slot of mlb.resolved.combos) {
        if (!slot.combo) continue;
        for (const l of slot.combo.legs) {
          const key = `${l.playerId}::${l.statKey}::${l.line}::${l.direction}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const implied = l.probability - l.edgePercent;
          const ev = (l.probability / 100) * SINGLE_LEG_PAYOUT - 1;
          out.push({
            sport: 'mlb',
            playerId: l.playerId,
            playerName: l.playerName,
            team: l.team,
            statKey: l.statKey,
            statLabel: l.statLabel,
            line: l.line,
            direction: l.direction,
            probability: l.probability,
            edgePercent: l.edgePercent,
            marketImpliedProb: implied,
            trapScore: l.trapScore ?? null,
            fragilityScore: l.fragilityScore ?? null,
            // Deep-link to the MLB player profile (which now has the
            // tonight's-slate panel showing this exact prop) instead
            // of the slate root.
            href: `/mlb/player/${l.playerId}`,
            ev,
            projection: l.projection ?? null,
            rangeLow: l.rangeLow ?? null,
            rangeHigh: l.rangeHigh ?? null,
            reasonCodes: l.reasonCodes ?? [],
          });
        }
      }
    }

    // UFC — projections come from the moneyline-anchored Phase 136
    // engine. Each row uses the model's projected direction (modelDirection)
    // since UFC slate lines are often 'both' (book line, either side
    // bookable on PrizePicks Flex). EV + probability + edge math is
    // identical to NBA + MLB so cross-sort works without weighting.
    for (const p of ufc?.projections ?? []) {
      const ev = (p.probability / 100) * SINGLE_LEG_PAYOUT - 1;
      const implied = p.fairProbability !== null ? p.fairProbability * 100 : null;
      // playerId field is `number` for back-compat with the rest of
      // the watchlist shape; UFC ESPN ids are alphanumeric strings, so
      // we use a Number() coerce that falls back to 0 (matches the
      // EliteCandidate path) and rely on espnAthleteId for the href.
      const numericId = Number(p.espnAthleteId) || 0;
      out.push({
        sport: 'mma',
        playerId: numericId,
        espnAthleteId: p.espnAthleteId ?? undefined,
        playerName: p.fighterName,
        // Surface 'vs Opponent' in the team slot — UFC has no team
        // and the matchup is the most useful context to scan.
        team: p.opponentName ? `vs ${p.opponentName}` : null,
        statKey: p.statKey,
        statLabel: UFC_STAT_LABEL[p.statKey] ?? p.statKey,
        line: p.line,
        direction: p.modelDirection,
        probability: p.probability,
        edgePercent: p.edgePercent,
        marketImpliedProb: implied,
        trapScore: p.trapScore,
        fragilityScore: p.fragilityScore,
        // Deep-link to the fighter profile when we have an ESPN id;
        // fall back to the slate page so users always have *some*
        // landing surface.
        href: p.espnAthleteId ? `/mma/fighter/${p.espnAthleteId}` : '/mma/slate',
        ev,
        // Projection band: the heuristic engine returns a central
        // projectionValue but doesn't compute a confidence interval
        // yet, so rangeLow / rangeHigh stay null and the row falls
        // through to the μ-only display in ProjectionBand.
        projection: p.projectionValue,
        rangeLow: null,
        rangeHigh: null,
        reasonCodes: p.rationale ?? [],
      });
    }

    return out;
  }, [nba, mlb, ufc]);

  const filtered = useMemo(() => {
    return allBets
      .filter((b) => sportFilter === 'all' || b.sport === sportFilter)
      .filter((b) => Math.abs(b.edgePercent) >= minEdge);
  }, [allBets, sportFilter, minEdge]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    // Direction multiplier — desc by default; asc when user clicks
    // an active header a second time.
    const m = sortDir === 'asc' ? -1 : 1;
    if (sortKey === 'ev') arr.sort((a, b) => (b.ev - a.ev) * m);
    else if (sortKey === 'edge') arr.sort((a, b) => (b.edgePercent - a.edgePercent) * m);
    else if (sortKey === 'probability') arr.sort((a, b) => (b.probability - a.probability) * m);
    else if (sortKey === 'live') {
      // Sort by live verdict — ON_PACE_HIT/HIT first, then IN_FLIGHT,
      // then PENDING, then ON_PACE_MISS/MISS at the bottom.
      const rank = (s: EliteLegLiveState | undefined) => {
        if (!s) return 4;
        if (s.verdict === 'HIT' || s.verdict === 'ON_PACE_HIT') return 0;
        if (s.verdict === 'IN_FLIGHT') return 1;
        if (s.verdict === 'PENDING') return 2;
        if (s.verdict === 'PUSH') return 3;
        return 5;     // MISS / ON_PACE_MISS / UNGRADED
      };
      arr.sort((a, b) => (rank(liveByKey.get(makeKey(a))) - rank(liveByKey.get(makeKey(b)))) * m);
    }
    return arr;
  }, [filtered, sortKey, sortDir, liveByKey]);

  // Live-grade the top 50 visible bets every 60s. Cap matches the
  // server-side limit on /api/slate/live-grade.
  const visible = sorted.slice(0, 50);
  const visibleSig = visible.map(makeKey).join('|');
  useEffect(() => {
    if (visible.length === 0) { setLiveByKey(new Map()); return; }
    let cancelled = false;
    const tick = () => {
      const payload = visible.map((b) => ({
        playerId: b.playerId,
        espnAthleteId: b.espnAthleteId,
        playerName: b.playerName,
        statKey: b.statKey,
        direction: b.direction,
        line: b.line,
      }));
      liveGradeLegs(payload)
        .then((states) => {
          if (cancelled) return;
          const m = new Map<string, EliteLegLiveState>();
          for (let i = 0; i < states.length; i++) {
            const b = visible[i]!;
            m.set(makeKey(b), states[i]!);
          }
          setLiveByKey(m);
        })
        .catch(() => { /* silent */ });
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [visibleSig]);   // eslint-disable-line react-hooks/exhaustive-deps

  const isLoading = nba === null && mlb === null && ufc === null;

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ marginBottom: 8 }}>
          <Link to="/" className="muted small">← Home</Link>
        </div>

        <div style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.10em',
          textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
        }}>
          STATEDGE BEST BETS · CROSS-SPORT
        </div>
        <h1 style={{ margin: '4px 0 8px' }}>Best Bets Today</h1>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 16, fontSize: 13, lineHeight: 1.6, maxWidth: 760 }}>
          Every prop the model has flagged across tonight's NBA + MLB + UFC slates,
          ranked by expected value. Sortable, filterable, live-tracked. Click
          any row to drill into the player profile. EV assumes a single-leg
          PrizePicks Flex payout ({SINGLE_LEG_PAYOUT}×).
          {' '}
          <span style={{ color: 'rgba(255,255,255,0.40)' }}>
            UFC rows use the moneyline-anchored projection engine — conservative
            market-anchored estimates, not deep fundamentals. Deeper fighter-stat
            engine is on the roadmap.
          </span>
        </p>

        {/* Same Bloomberg ticker that leads Home + Dashboard.
            Watchlist users want the headline numbers (live games,
            active edges, Elite verdict, CLV beat-rate) before they
            scan the row-level table below. */}
        <TodayAtAGlance />

        {/* Activity feed — Elite + starred picks that have settled or
            locked today. Pinned above the watchlist so users see
            'what just happened' first, then scan today's edges. */}
        <ActivityFeed />

        <ClvTrustBanner />

        {error && <div className="mlb-info-banner mlb-info-error" style={{ marginBottom: 12 }}>{error}</div>}

        {/* Filter bar: sport + sort + min-edge */}
        <div style={{
          display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
          marginBottom: 16, padding: '10px 14px',
          background: 'rgba(0,0,0,0.20)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
        }}>
          <SegmentedTab options={[
            { value: 'all', label: 'All' },
            { value: 'nba', label: 'NBA' },
            { value: 'mlb', label: 'MLB' },
            { value: 'mma', label: 'UFC' },
          ]} value={sportFilter} onChange={(v) => setSportFilter(v as Sport | 'all')} />
          <span style={{ color: 'rgba(255,255,255,0.25)' }}>·</span>
          <SegmentedTab options={[
            { value: 'ev', label: 'EV' },
            { value: 'edge', label: 'Edge' },
            { value: 'probability', label: 'Prob' },
            { value: 'live', label: 'Live' },
          ]} value={sortKey} onChange={(v) => setSortKey(v as SortKey)} />
          <span style={{ color: 'rgba(255,255,255,0.25)' }}>·</span>
          <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', display: 'flex', alignItems: 'center', gap: 6 }}>
            min edge
            <input
              type="number"
              value={minEdge}
              onChange={(e) => setMinEdge(Number(e.target.value) || 0)}
              style={{
                width: 60, padding: '4px 8px', fontSize: 12,
                background: 'var(--surface-0)',
                border: '1px solid var(--border-default)',
                color: 'inherit', borderRadius: 4,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
              step="1"
              min="0"
              max="50"
            />
            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>%</span>
          </label>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
            {sorted.length} {sorted.length === 1 ? 'pick' : 'picks'} · top 50 live-tracked
          </span>
          <button
            type="button"
            onClick={() => downloadCsv(sorted)}
            disabled={sorted.length === 0}
            title="Export the current filtered + sorted view to CSV"
            style={{
              fontSize: 11, fontWeight: 800, letterSpacing: '0.04em',
              padding: '5px 10px', borderRadius: 4,
              background: 'transparent',
              color: '#7aa2ff',
              border: '1px solid rgba(122,162,255,0.30)',
              cursor: sorted.length === 0 ? 'not-allowed' : 'pointer',
              opacity: sorted.length === 0 ? 0.5 : 1,
              textTransform: 'uppercase',
            }}
          >
            ⬇ CSV
          </button>
        </div>

        {isLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} width="100%" height={42} />
            ))}
          </div>
        )}

        {!isLoading && sorted.length === 0 && (
          <div className="mlb-info-banner">
            <strong>No props match these filters.</strong>
            {' '}
            Lower the min-edge threshold or change the sport filter.
            If the slates haven't published yet today, check back closer to game time.
          </div>
        )}

        {!isLoading && sorted.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%', borderCollapse: 'collapse', fontSize: 13,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontVariantNumeric: 'tabular-nums',
            }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-default)' }}>
                  <th style={th}>#</th>
                  <th style={th} title="Star — adds to your /starred watchlist">★</th>
                  <th style={th}>Sport</th>
                  <th style={th}>Player</th>
                  <th style={{ ...th, textAlign: 'left' }}>Stat / Line</th>
                  <th style={{ ...th, textAlign: 'left' }}>Projection</th>
                  <SortHeader label="Prob" align="right" thisKey="probability" sortKey={sortKey} setSortKey={setSortKey} sortDir={sortDir} setSortDir={setSortDir} />
                  <SortHeader label="Edge" align="right" thisKey="edge" sortKey={sortKey} setSortKey={setSortKey} sortDir={sortDir} setSortDir={setSortDir} />
                  <SortHeader label="EV" align="right" thisKey="ev" sortKey={sortKey} setSortKey={setSortKey} sortDir={sortDir} setSortDir={setSortDir} />
                  <SortHeader label="Live" align="right" thisKey="live" sortKey={sortKey} setSortKey={setSortKey} sortDir={sortDir} setSortDir={setSortDir} />
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 50).map((b, i) => {
                  const live = liveByKey.get(makeKey(b)) ?? null;
                  return (
                    <BetRow
                      key={makeKey(b)}
                      bet={b}
                      rank={i + 1}
                      live={live}
                      expanded={expandedKey === makeKey(b)}
                      onToggleExpand={() => setExpandedKey((k) => k === makeKey(b) ? null : makeKey(b))}
                    />
                  );
                })}
              </tbody>
            </table>
            {sorted.length > 50 && (
              <p className="muted small" style={{ marginTop: 8, fontSize: 11 }}>
                Showing top 50 of {sorted.length} matching picks. Live tracking is capped at the visible 50 to bound API traffic.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function makeKey(b: { playerId: number; statKey: string; line: number; direction: 'OVER' | 'UNDER' }): string {
  return `${b.playerId}-${b.statKey}-${b.line}-${b.direction}`;
}

// Export the current filtered + sorted bets as a CSV download.
// Institutional users move this kind of data through spreadsheets;
// shipping a one-click export is cheap and high-value. CSV-quotes
// fields that contain commas/quotes/newlines per RFC 4180.
function downloadCsv(bets: UnifiedBet[]): void {
  if (bets.length === 0) return;
  const cols = [
    'rank', 'sport', 'player', 'team',
    'stat', 'line', 'direction',
    'probability_pct', 'edge_pp', 'ev_pct',
    'projection_mu', 'projection_low', 'projection_high',
  ];
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const rows = [cols.join(',')];
  bets.forEach((b, i) => {
    rows.push([
      i + 1,
      // Use the user-facing label (UFC, not MMA) so the CSV matches
      // the in-app pill — same fix as iter 50 / 60 / 61.
      SPORT_LABEL[b.sport],
      esc(b.playerName),
      esc(b.team ?? ''),
      esc(b.statLabel),
      b.line,
      b.direction,
      b.probability.toFixed(2),
      b.edgePercent.toFixed(2),
      (b.ev * 100).toFixed(2),
      b.projection !== null ? b.projection.toFixed(2) : '',
      b.rangeLow !== null ? b.rangeLow.toFixed(2) : '',
      b.rangeHigh !== null ? b.rangeHigh.toFixed(2) : '',
    ].join(','));
  });
  const csv = rows.join('\n');
  const ts = new Date().toISOString().slice(0, 10);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `statedge-best-bets-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function BetRow({ bet, rank, live, expanded, onToggleExpand }: {
  bet: UnifiedBet;
  rank: number;
  live: EliteLegLiveState | null;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const sportColor = SPORT_COLOR[bet.sport];
  const { isStarred, toggle } = useStarredProps();
  const starredId = `${bet.sport}-${bet.playerId}-${bet.statKey}-${bet.line}-${bet.direction}`;
  const starred = isStarred(starredId);
  const hasReasons = bet.reasonCodes.length > 0;
  return (
    <>
    <tr style={{ borderBottom: '1px solid var(--border-subtle)' }} className="best-bets-row">
      <td style={{ ...td, color: 'rgba(255,255,255,0.45)', textAlign: 'right', paddingRight: 14, position: 'relative' }}>
        {hasReasons && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
            title={expanded ? 'Collapse reasoning' : 'Why this pick?'}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            style={{
              position: 'absolute',
              left: 0, top: '50%', transform: 'translateY(-50%)',
              background: 'transparent', border: 'none',
              color: expanded ? '#7aa2ff' : 'rgba(255,255,255,0.30)',
              fontSize: 10, fontWeight: 800,
              padding: '4px 6px',
              cursor: 'pointer',
              transition: 'color var(--motion-fast), transform var(--motion-fast)',
            }}
          >
            {expanded ? '▼' : '▸'}
          </button>
        )}
        {rank}
      </td>
      <td style={{ ...td, textAlign: 'center' }}>
        <button
          type="button"
          onClick={() => toggle({
            sport: bet.sport,
            playerId: bet.playerId,
            espnAthleteId: bet.espnAthleteId,
            playerName: bet.playerName,
            team: bet.team,
            statKey: bet.statKey,
            statLabel: bet.statLabel,
            line: bet.line,
            direction: bet.direction,
            snapshot: {
              probability: bet.probability,
              edgePercent: bet.edgePercent,
              projection: bet.projection,
            },
          })}
          title={starred ? 'Unstar — removes from /starred' : 'Star — track on /starred'}
          aria-label={starred ? 'Unstar' : 'Star'}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: starred ? '#ffd54f' : 'rgba(255,255,255,0.20)',
            fontSize: 16,
            padding: '4px 6px',
            transition: 'color var(--motion-fast), transform var(--motion-fast)',
          }}
        >
          {starred ? '★' : '☆'}
        </button>
      </td>
      <td style={td}>
        <span style={{
          fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
          color: sportColor,
          padding: '2px 6px',
          background: `${sportColor}14`,
          border: `1px solid ${sportColor}40`,
          borderRadius: 3,
        }}>
          {SPORT_LABEL[bet.sport]}
        </span>
      </td>
      <td style={td}>
        <Link
          to={bet.href}
          className="best-bets-player-link"
          style={{ color: 'inherit', textDecoration: 'none', fontWeight: 700, display: 'inline-block' }}
          title={`Open ${bet.playerName}'s profile (live tracking + tonight's slate panel)`}
        >
          {bet.playerName}
        </Link>
        {bet.team && <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.45)' }}>{bet.team}</span>}
      </td>
      <td style={td}>
        <Link to={bet.href} style={{ color: 'inherit', textDecoration: 'none' }}>
          <span style={{ color: 'rgba(255,255,255,0.85)' }}>{bet.statLabel}</span>{' '}
          <strong>{bet.line}</strong>{' '}
          <span style={{ color: bet.direction === 'OVER' ? '#66bb6a' : '#ef5350', fontWeight: 800 }}>
            {bet.direction === 'OVER' ? '↑' : '↓'}
          </span>
        </Link>
      </td>
      <td style={td}>
        {bet.projection !== null && bet.rangeLow !== null && bet.rangeHigh !== null ? (
          <ProjectionBand
            rangeLow={bet.rangeLow}
            projection={bet.projection}
            rangeHigh={bet.rangeHigh}
            line={bet.line}
            lean={bet.direction}
            compact
          />
        ) : bet.projection !== null ? (
          <span style={{ color: 'rgba(255,255,255,0.65)', fontVariantNumeric: 'tabular-nums' }}>
            μ {bet.projection.toFixed(1)}
          </span>
        ) : (
          <span style={{ color: 'rgba(255,255,255,0.35)' }}>—</span>
        )}
      </td>
      <td style={{ ...td, textAlign: 'right' }}>
        <strong style={{ color: bet.probability >= 60 ? '#66bb6a' : '#fff' }}>
          {bet.probability.toFixed(1)}%
        </strong>
        {bet.marketImpliedProb !== null && (
          <span style={{ marginLeft: 4, fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>
            (mkt {Math.round(bet.marketImpliedProb)}%)
          </span>
        )}
      </td>
      <td style={{
        ...td, textAlign: 'right', fontWeight: 800,
        color: bet.edgePercent >= 10 ? '#66bb6a' : bet.edgePercent >= 5 ? '#ffd54f' : '#ef5350',
      }}>
        {bet.edgePercent >= 0 ? '+' : ''}{bet.edgePercent.toFixed(1)}pp
      </td>
      <td style={{
        ...td, textAlign: 'right', fontWeight: 800,
        color: bet.ev >= 0.10 ? '#66bb6a' : bet.ev >= 0 ? '#ffd54f' : '#ef5350',
      }}>
        {bet.ev >= 0 ? '+' : ''}{(bet.ev * 100).toFixed(1)}%
      </td>
      <td style={{ ...td, textAlign: 'right' }}>
        <LiveVerdictPill state={live} compact />
      </td>
    </tr>
    {expanded && hasReasons && (
      <tr className="best-bets-expanded">
        <td colSpan={10} style={{
          padding: '10px 14px 14px 32px',
          borderBottom: '1px solid var(--border-subtle)',
          background: 'rgba(122,162,255,0.04)',
        }}>
          <div style={{
            fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
            textTransform: 'uppercase', color: '#7aa2ff', marginBottom: 6,
          }}>
            Why this pick
          </div>
          <ul style={{
            margin: 0, paddingLeft: 18,
            fontSize: 12, lineHeight: 1.55,
            color: 'rgba(255,255,255,0.85)',
            fontFamily: 'var(--font-sans, system-ui)',
            fontVariantNumeric: 'normal',
          }}>
            {bet.reasonCodes.map((r, i) => <li key={i} style={{ marginBottom: 2 }}>{r}</li>)}
          </ul>
        </td>
      </tr>
    )}
    </>
  );
}

function SegmentedTab({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{
      display: 'inline-flex',
      padding: 2,
      background: 'var(--surface-0)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-pill)',
      gap: 2,
    }}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              padding: '4px 10px',
              borderRadius: 'var(--radius-pill)',
              border: 'none',
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: '0.04em',
              cursor: 'pointer',
              background: active ? 'var(--brand-gradient)' : 'transparent',
              color: active ? '#fff' : 'var(--text-3)',
              boxShadow: active ? 'var(--shadow-brand-glow)' : 'none',
              transition: 'all var(--motion-fast)',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// Clickable column header that switches the sort key. Bloomberg
// watchlist-style: arrow rendered next to the label when the key
// matches, click anywhere on the cell to switch.
function SortHeader({
  label, align, thisKey, sortKey, setSortKey, sortDir, setSortDir,
}: {
  label: string;
  align: 'left' | 'right';
  thisKey: SortKey;
  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;
  sortDir: SortDir;
  setSortDir: (d: SortDir) => void;
}) {
  const active = sortKey === thisKey;
  return (
    <th
      style={{ ...th, textAlign: align, cursor: 'pointer', userSelect: 'none' }}
      onClick={() => {
        // First click on a non-active header switches the key + sets desc.
        // Click on the already-active header toggles direction.
        if (active) {
          setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
        } else {
          setSortKey(thisKey);
          setSortDir('desc');
        }
      }}
      title={`Sort by ${label}${active ? ` (${sortDir === 'asc' ? 'ascending' : 'descending'} — click to reverse)` : ''}`}
    >
      <span style={{
        color: active ? 'var(--text-1)' : undefined,
        textShadow: active ? '0 0 8px rgba(91,141,239,0.30)' : undefined,
      }}>
        {label}
        <span style={{
          marginLeft: 4,
          fontSize: 9,
          opacity: active ? 1 : 0.25,
          color: active ? '#5b8def' : undefined,
        }}>
          {active && sortDir === 'asc' ? '▲' : '▼'}
        </span>
      </span>
    </th>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'rgba(255,255,255,0.55)',
};

const td: React.CSSProperties = {
  padding: '10px 10px',
  fontSize: 13,
};
