import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  analyzeSlateLegs,
  getBackendVersion,
  getDataFreshness,
  getNbaLiveToday,
  getSlateAuto,
  getSlateInsight,
  getTodaySlate,
  liveGradeLegs,
  postSlateImage,
  type BackendVersion,
  type DataFreshness,
  type EliteLegLiveState,
  type NbaLiveTodayPlayer,
  type NbaLiveTodayResponse,
  type SlateCombo,
  type SlateComboLeg,
  type SlateMode,
  type SlateProjection,
  type SlateResolvedLine,
  type SlateResponse,
  type SlateUnresolvedLine,
} from './api';
import { PlayerAvatar, TeamLogo } from './Avatar';
import { edgeScore } from './edgeScore';
import { ClvTrustBanner } from './ClvTrustBanner';
import { useFavorites, type FavoritesAPI } from './favorites';
import { HomeEliteTeaser } from './HomeEliteTeaser';
import { LatestNewsRail } from './LatestNewsRail';
import { NavBar } from './NavBar';
import { NbaPlayerDrilldown, type NbaDrilldownPlayer } from './NbaPlayerDrilldown';
import { WhyPickPanel } from './WhyPickPanel';
import { usePlan } from './plan';
import { ProjectionBand } from './ProjectionBand';
import { Skeleton } from './Skeleton';
import { useSavedParlays, type SavedParlay } from './savedParlays';
import { SlateCalibration } from './SlateCalibration';
import { LiveVerdictPill, SlateLiveStateProvider, useLiveLegState } from './slateLiveState';
import { useStarredProps } from './starredProps';
import { SlateHistory } from './SlateHistory';
import { SlateManualEntry } from './SlateManualEntry';
import { SlatePaywall } from './SlatePaywall';
import { TonightsGames } from './TonightsGames';
import { computeHitProbability } from './slateMath';
import { useTitle } from './useTitle';

export function Slate() {
  useTitle(['Slate']);

  const { plan, isAdmin } = usePlan();
  const favorites = useFavorites();
  const isPro = plan === 'pro' || isAdmin;
  const { items: savedParlays, save: saveParlay, remove: removeParlay } = useSavedParlays();
  const [data, setData] = useState<SlateResponse | null>(null);
  // User-chosen slate strategy mode. Persisted to localStorage so the
  // pick survives reloads. Defaults to 'balanced' (the EV-engine
  // default) on first visit.
  const [slateMode, setSlateModeState] = useState<SlateMode>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('statedge.slate.mode') : null;
    if (
      saved === 'safe' || saved === 'balanced' || saved === 'aggressive'
      || saved === 'insane' || saved === 'auto'
    ) return saved;
    return 'balanced';
  });
  function setSlateMode(m: SlateMode): void {
    setSlateModeState(m);
    try { localStorage.setItem('statedge.slate.mode', m); } catch { /* ignore */ }
  }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<'auto' | 'upload' | null>(null);
  const [autoTried, setAutoTried] = useState(false);
  const [backendVer, setBackendVer] = useState<BackendVersion | null>(null);
  // Distinct from `backendVer === null` (which can mean 'still loading'):
  // true when /api/version 404s, signalling the backend deploy is on
  // pre-version-endpoint code. Drives the stale-backend banner.
  const [backendStale, setBackendStale] = useState(false);
  const [freshness, setFreshness] = useState<DataFreshness | null>(null);
  const [filter, setFilter] = useState<'all' | 'over' | 'under' | 'strong'>('all');
  const [hideOut, setHideOut] = useState(true);
  const [teamFilter, setTeamFilter] = useState<string>('');
  const [statFilter, setStatFilter] = useState<string>('');
  const [sort, setSort] = useState<'confidence' | 'edge' | 'tipoff'>('confidence');
  // Default to 'build' since auto-pull is unreliable (PrizePicks Cloudflare)
  // and OCR depends on env-config the user may not have. Manual entry just
  // works with the data we always have.
  // Mode tabs are temporarily hidden — Build my own is the only path.
  // Auto-pull (Cloudflare 403s) and Upload screenshot (4.5 MB body limit
  // on Hobby) are kept in code for easy re-enable once each is fixed.

  // Parlay builder: selected card identifiers ("playerId-statKey-line").
  // Combined probability assumes leg independence — it's a model, not a
  // promise; the receipts ('hit X/10' per leg) keep users honest.
  // Pre-populated from ?legs= URL param so shared links work.
  const [searchParams, setSearchParams] = useSearchParams();
  // Tab: 'today' shows the live prop board; 'history' shows past
  // pre-built parlays graded against actuals; 'calibration' shows
  // predicted-vs-actual hit rate aggregated across all graded days.
  // Synced to ?tab= so the views are shareable / bookmarkable.
  const [tab, setTab] = useState<'today' | 'history' | 'calibration'>(() => {
    const t = searchParams.get('tab');
    if (t === 'history') return 'history';
    if (t === 'calibration') return 'calibration';
    return 'today';
  });
  const [parlay, setParlay] = useState<string[]>(() => {
    const raw = searchParams.get('legs');
    if (!raw) return [];
    return raw.split(',').filter(Boolean);
  });
  function cardKey(l: SlateResolvedLine): string {
    return `${l.playerId}-${l.statKey}-${l.line}`;
  }
  // Hard cap at 6 legs per the new prop-board spec — building beyond
  // 6 silently caps so the user has to drop a leg to add a new one.
  const PARLAY_MAX_LEGS = 6;
  function toggleParlay(l: SlateResolvedLine) {
    const k = cardKey(l);
    setParlay((prev) => {
      if (prev.includes(k)) return prev.filter((x) => x !== k);
      if (prev.length >= PARLAY_MAX_LEGS) {
        // Surface a quick error toast — drop the user's add silently
        // would be confusing. Use the existing setError so the slate
        // banner shows it.
        setError(`Parlay caps at ${PARLAY_MAX_LEGS} legs — drop one before adding more.`);
        return prev;
      }
      setError(null);
      return [...prev, k];
    });
  }
  function removeFromParlay(k: string) {
    setParlay((prev) => prev.filter((x) => x !== k));
  }
  function clearParlay() { setParlay([]); }

  // Mirror parlay state into the URL so a 'Copy parlay link' button
  // can just hand the user `window.location.href`. replace:true keeps
  // the back/forward stack clean.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (parlay.length === 0) sp.delete('legs');
        else sp.set('legs', parlay.join(','));
        return sp;
      },
      { replace: true },
    );
  }, [parlay, setSearchParams]);

  // Mirror the active tab to ?tab= so deep links to /slate?tab=history
  // (or ?tab=calibration) land directly on those views.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (tab === 'today') sp.delete('tab');
        else sp.set('tab', tab);
        return sp;
      },
      { replace: true },
    );
  }, [tab, setSearchParams]);

  // We no longer auto-fire the PrizePicks pull on mount — it usually
  // 403s because of their Cloudflare bot layer, and the manual-entry
  // flow is now the primary path. Auto-pull only fires when the user
  // explicitly clicks the button under the 'auto' mode.
  useEffect(() => {
    getDataFreshness().then(setFreshness).catch(() => {});
    getBackendVersion()
      .then((v) => {
        setBackendVer(v);
        // Null = endpoint missing (404 or network) — backend is stale.
        setBackendStale(v === null);
      })
      .catch(() => setBackendStale(true));
  }, []);

  // Mode change → refetch /slate/today with the new mode so the rail
  // re-ranks. SlateManualEntry handles the initial load (always
  // 'balanced'); we only kick in for subsequent mode flips.
  const initialModeRef = useRef(true);
  useEffect(() => {
    if (initialModeRef.current) {
      initialModeRef.current = false;
      return;
    }
    if (!data) return;            // nothing to re-rank yet
    let alive = true;
    getTodaySlate(slateMode)
      .then((today) => {
        if (!alive) return;
        if (today.resolved) setData(today.resolved);
      })
      .catch(() => { /* keep current data on transient errors */ });
    return () => { alive = false; };
  }, [slateMode]);    // eslint-disable-line react-hooks/exhaustive-deps

  // Background refresh: only meaningful for the PrizePicks auto-pull
  // path — manual-entry and uploaded slates are static by design. PP
  // lines move during the day so we re-pull every 5 minutes while the
  // tab is visible.
  useEffect(() => {
    if (!data || data.source !== 'prizepicks_auto') return;
    let alive = true;
    const silentRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      getSlateAuto()
        .then((d) => { if (alive) setData(d); })
        .catch(() => { /* keep stale data on transient errors */ });
    };
    const interval = setInterval(silentRefresh, 5 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') silentRefresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [data]);

  function retryAuto() {
    setLoading(true);
    setError(null);
    setErrorSource(null);
    getSlateAuto()
      .then((d) => { setData(d); setError(null); })
      .catch((e) => { setError((e as Error).message); setErrorSource('auto'); })
      .finally(() => setLoading(false));
  }

  async function handleFile(file: File) {
    setLoading(true);
    setError(null);
    setErrorSource(null);
    try {
      const result = await postSlateImage(file);
      setData(result);
    } catch (e) {
      setError((e as Error).message);
      setErrorSource('upload');
    } finally {
      setLoading(false);
    }
  }

  const lines = data?.lines ?? [];
  const outCount = lines.filter((l) => l.injury?.status === 'Out').length;

  // Build the team/stat facets from the current slate. Sorted; null
  // teams (rare) are dropped from the team dropdown.
  const teams = Array.from(
    new Set(lines.map((l) => l.team).filter((t): t is string => !!t)),
  ).sort();
  const stats = Array.from(
    new Set(lines.map((l) => l.statLabel)),
  ).sort();

  const filtered = lines.filter((l) => {
    if (hideOut && l.injury?.status === 'Out') return false;
    if (teamFilter && l.team !== teamFilter) return false;
    if (statFilter && l.statLabel !== statFilter) return false;
    if (filter === 'all') return true;
    const lean = l.hitProbability?.lean;
    if (filter === 'over') return lean === 'OVER';
    if (filter === 'under') return lean === 'UNDER';
    if (filter === 'strong') return (l.hitProbability?.mightHitPct ?? 0) >= 75;
    return true;
  });

  // Apply user-chosen sort. Default 'confidence' matches the
  // server-side ordering. 'edge' uses the composite score that
  // accounts for line-gap, vsOpp agreement, trend agreement, and
  // injury penalty. 'tipoff' surfaces the soonest games first.
  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'edge') return edgeScore(b) - edgeScore(a);
    if (sort === 'tipoff') {
      const at = a.startTime ? Date.parse(a.startTime) : Number.POSITIVE_INFINITY;
      const bt = b.startTime ? Date.parse(b.startTime) : Number.POSITIVE_INFINITY;
      return at - bt;
    }
    return (b.hitProbability?.mightHitPct ?? 0) - (a.hitProbability?.mightHitPct ?? 0);
  });

  const isStale = (freshness?.daysStale ?? 0) > 3;

  // Free / signed-out users see a marketing preview + upgrade CTA in
  // place of the actual slate. Admins and Pro subscribers fall through
  // to the full prop-board experience below.
  if (!isPro) {
    return (
      <div className="app">
        <NavBar />
        <SlatePaywall />
      </div>
    );
  }

  return (
    <div className="app">
      <NavBar />

      {isStale && (
        <div className="freshness stale" style={{ marginBottom: 16 }}>
          Heads up: NBA data is {freshness?.daysStale} days old — these
          percentages may not reflect tonight's form.
        </div>
      )}

      {/* Diagnostic banners — admin-only. Customers should never see
          deploy/env warnings; those are operations issues for the
          owner to act on, not user-facing copy. */}
      {isAdmin && backendStale && (
        <div className="slate-error admin-only" style={{ marginBottom: 16 }}>
          <span className="admin-tag">ADMIN</span>{' '}
          <strong>Backend deploy is out of date.</strong> Run{' '}
          <code>npx vercel --prod</code> from the repo root to redeploy.
          The roster modal will fall back to a search input until then.
        </div>
      )}

      {isAdmin && backendVer && !backendVer.hasGeminiKey && (
        <div className="slate-error admin-only" style={{ marginBottom: 16 }}>
          <span className="admin-tag">ADMIN</span>{' '}
          <strong>Backend missing GEMINI_API_KEY.</strong> Set{' '}
          <code>GEMINI_API_KEY</code> in the backend Vercel project's env
          (Production scope) and redeploy.
          {backendVer.commit !== 'local' && (
            <span className="muted small"> Currently serving commit <code>{backendVer.commit}</code>.</span>
          )}
        </div>
      )}

      <h1 style={{ marginTop: 8 }}>Slate</h1>
      <p className="tag">
        Tonight's prop board with the model's probability on every line.
        Tap any card to add it to your parlay (up to 6 legs) and we'll
        score the combined hit probability.
      </p>

      {/* Truth metric pinned above the board — institutional users
          check the scoreboard before they trust tonight's picks.
          Sport-scoped to NBA so the banner reports tonight's-sport
          beat rate, not cross-sport noise. */}
      <ClvTrustBanner sport="nba" />

      {/* Cross-sport Elite teaser — surfaces today's play even on
          the NBA-specific slate page. Self-hides if no qualifying
          combination. */}
      <HomeEliteTeaser />

      {/* Tonight's NBA games — sits at the top so users orient on
          the actual game context before scanning the pre-built
          parlays below. Self-contained component handles its own
          fetch and renders nothing when the schedule is empty. */}
      <TonightsGames />

      {/* Top-level tabs — Today's prop board, past graded picks
          (History), and predicted-vs-actual calibration aggregates. */}
      <div className="slate-tabs" role="tablist" aria-label="Slate view">
        <button
          role="tab"
          aria-selected={tab === 'today'}
          className={`slate-tab ${tab === 'today' ? 'active' : ''}`}
          onClick={() => setTab('today')}
        >
          Today
        </button>
        <button
          role="tab"
          aria-selected={tab === 'history'}
          className={`slate-tab ${tab === 'history' ? 'active' : ''}`}
          onClick={() => setTab('history')}
        >
          History
        </button>
        <button
          role="tab"
          aria-selected={tab === 'calibration'}
          className={`slate-tab ${tab === 'calibration' ? 'active' : ''}`}
          onClick={() => setTab('calibration')}
        >
          Calibration
        </button>
      </div>

      {tab === 'history' && <SlateHistory />}
      {tab === 'calibration' && <SlateCalibration />}

      {tab === 'today' && (
        <SlateTodayBody
          lines={lines}
          loading={loading}
          error={error}
          autoTried={autoTried}
          data={data}
          freshness={freshness}
          isPro={isPro}
          favorites={favorites}
          parlay={parlay}
          setParlay={setParlay}
          toggleParlay={toggleParlay}
          cardKey={cardKey}
          savedParlays={savedParlays}
          removeParlay={removeParlay}
          sorted={sorted}
          outCount={outCount}
          hideOut={hideOut}
          setHideOut={setHideOut}
          setFilter={setFilter}
          setTeamFilter={setTeamFilter}
          setStatFilter={setStatFilter}
          onManualResult={(r) => { setData(r); setError(null); setErrorSource(null); }}
          slateMode={slateMode}
          setSlateMode={setSlateMode}
        />
      )}

      {/* The parlay tray sits outside the tab so adding a leg from the
          Today board persists if the user toggles to History and back. */}
      {tab === 'today' && parlay.length > 0 && lines.length > 0 && (
        <ParlayTray
          legs={lines.filter((l) => parlay.includes(cardKey(l)))}
          onRemove={(l) => removeFromParlay(cardKey(l))}
          onClear={clearParlay}
          onSave={(name) => saveParlay(name, parlay)}
          canSave={isPro}
          canAnalyze={isPro}
        />
      )}

      {/* News rail at the foot of the slate so users see auto-recaps
          + edge analysis articles in the sport context they're shopping. */}
      <LatestNewsRail sport="nba" limit={4} heading="NBA News & Analysis" />
    </div>
  );
}

// Body of the "Today" tab — extracted so the tabs split is a clean
// switch rather than a deeply-indented conditional. All the existing
// Today behavior moves here; the page wrapper above just chooses
// which body to render.
type SlateTodayBodyProps = {
  lines: SlateResolvedLine[];
  loading: boolean;
  error: string | null;
  autoTried: boolean;
  data: SlateResponse | null;
  freshness: DataFreshness | null;
  isPro: boolean;
  favorites: FavoritesAPI;
  parlay: string[];
  setParlay: (legs: string[]) => void;
  toggleParlay: (l: SlateResolvedLine) => void;
  cardKey: (l: SlateResolvedLine) => string;
  savedParlays: SavedParlay[];
  removeParlay: (id: string) => void;
  sorted: SlateResolvedLine[];
  outCount: number;
  hideOut: boolean;
  setHideOut: (b: boolean) => void;
  setFilter: (f: 'all' | 'over' | 'under' | 'strong') => void;
  setTeamFilter: (s: string) => void;
  setStatFilter: (s: string) => void;
  onManualResult: (r: SlateResponse) => void;
  slateMode: SlateMode;
  setSlateMode: (m: SlateMode) => void;
};

function SlateTodayBody(props: SlateTodayBodyProps) {
  const {
    lines,
    loading,
    error,
    autoTried,
    data,
    isPro,
    favorites,
    parlay,
    setParlay,
    toggleParlay,
    cardKey,
    savedParlays,
    removeParlay,
    sorted,
    outCount,
    hideOut,
    setFilter,
    setTeamFilter,
    setStatFilter,
    setHideOut,
    onManualResult,
    slateMode,
    setSlateMode,
  } = props;

  const [drilldownPlayer, setDrilldownPlayer] = useState<NbaDrilldownPlayer | null>(null);

  return (
    <SlateLiveStateProvider lines={lines} topN={40}>
      {/* Slate freshness — show how recently the slate was pulled from
          PrizePicks so users know whether the lines they're scanning
          are fresh. fetchedAt = when the slate snapshot landed in the
          database. Self-hides when no data yet. */}
      {data?.fetchedAt && (
        <div className="muted small" style={{
          marginBottom: 8, fontSize: 11,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          color: 'rgba(255,255,255,0.55)',
        }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
            color: '#7aa2ff', textTransform: 'uppercase',
          }}>
            <span style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: 3,
              background: '#7aa2ff',
            }} />
            NBA slate
          </span>
          <span title={new Date(data.fetchedAt).toLocaleString()}>
            {data.lines.length} lines · published {nbaSlateTimeAgo(data.fetchedAt)}
          </span>
          {data.source && (
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
              · source: {data.source.replace('_', ' ')}
            </span>
          )}
        </div>
      )}

      {/* Pinned favorites — your starred players' props at the top
          of the page so you don't have to scroll the full slate to
          find the names you actually care about. Hidden if you
          haven't favorited anyone. */}
      {favorites.players.length > 0 && lines.length > 0 && (
        <FavoritesSection
          lines={lines}
          favorites={favorites}
          parlay={parlay}
          onToggleParlay={toggleParlay}
          cardKey={cardKey}
        />
      )}

      {/* Pre-built parlays sit at the top of the page when a slate
          is loaded — they're the highest-signal view of the slate
          and what most users come here for. Computed server-side
          (see backend slateCombos.ts) so every visitor sees the same
          picks the snapshot/history path uses.
          Strategy mode selector lets users pick the angle: Safe
          (highest probability, lowest variance), Balanced (default,
          best risk-adjusted EV), or Aggressive (largest projection
          separation, ceiling outcomes). */}
      {data?.combos && data.combos.length > 0 && (
        <>
          <SlateModeSelector
            mode={slateMode}
            onChange={setSlateMode}
            resolvedMode={data.resolvedMode}
          />
          <BestPicksRail
            combos={data.combos}
            lines={lines}
            onLoad={(legs) => setParlay(legs)}
            activeKeys={parlay}
            cardKey={cardKey}
            onPlayerClick={setDrilldownPlayer}
          />
        </>
      )}

      {drilldownPlayer && data?.combos && (
        <NbaPlayerDrilldown
          player={drilldownPlayer}
          combos={data.combos}
          onClose={() => setDrilldownPlayer(null)}
        />
      )}

      {/* Always render — admin panel + today's-games rail + empty
          state all live in here, and the admin needs the panel
          accessible even after a slate has been published. */}
      <SlateManualEntry onResult={onManualResult} />

      {error && (
        <div className="slate-error">
          <strong>Slate failed:</strong> {error}
        </div>
      )}

      {isPro && savedParlays.length > 0 && (
        <SavedParlaysSection
          parlays={savedParlays}
          onOpen={(p) => setParlay(p.legs)}
          onRemove={removeParlay}
          lines={lines}
        />
      )}

      {loading && lines.length === 0 && (
        <div className="slate-grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="slate-card">
              <Skeleton width={56} height={56} radius="50%" />
              <Skeleton width="80%" height={14} style={{ marginTop: 10 }} />
              <Skeleton width="50%" height={12} style={{ marginTop: 4 }} />
              <Skeleton width="100%" height={28} style={{ marginTop: 12 }} />
              <Skeleton width="100%" height={20} style={{ marginTop: 8 }} />
            </div>
          ))}
        </div>
      )}

      {!loading && lines.length === 0 && !error && autoTried && !data?.source && (
        <p className="muted">No lines returned.</p>
      )}

      {sorted.length > 0 && (
        <GameGroupedBoard
          lines={sorted}
          parlay={parlay}
          onToggleParlay={toggleParlay}
          cardKey={cardKey}
          favorites={favorites}
        />
      )}

      {!loading && lines.length > 0 && sorted.length === 0 && (
        <div className="slate-empty">
          <h3>No props match your filters</h3>
          <p className="muted small">
            {hideOut && outCount > 0 && (
              <>
                {outCount} player{outCount === 1 ? ' is' : 's are'} OUT and hidden.{' '}
              </>
            )}
            Loosen the filters or pick a different team / stat above.
          </p>
          <button
            className="cta"
            onClick={() => {
              setFilter('all');
              setTeamFilter('');
              setStatFilter('');
              setHideOut(false);
            }}
          >
            Clear all filters
          </button>
        </div>
      )}

      {data && data.unresolved.length > 0 && (
        <UnresolvedSection unresolved={data.unresolved} />
      )}
    </SlateLiveStateProvider>
  );
}

function FilterTab({
  v,
  cur,
  onSet,
  children,
}: {
  v: 'all' | 'over' | 'under' | 'strong';
  cur: typeof v;
  onSet: (v: 'all' | 'over' | 'under' | 'strong') => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={cur === v ? 'pick-btn active' : 'pick-btn'}
      onClick={() => onSet(v)}
    >
      {children}
    </button>
  );
}

function LineCard({
  line,
  inParlay,
  onToggleParlay,
  showEdge,
  canInsight,
}: {
  line: SlateResolvedLine;
  inParlay: boolean;
  onToggleParlay: () => void;
  showEdge?: boolean;
  canInsight?: boolean;
}) {
  // Per-card AI insight — fetched lazily on click, cached locally so
  // re-clicking doesn't re-bill. State lives in the card so multiple
  // cards on screen don't share fetch state.
  const [insight, setInsight] = useState<string | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightErr, setInsightErr] = useState<string | null>(null);
  async function loadInsight(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (insight || insightLoading) return;
    setInsightLoading(true);
    setInsightErr(null);
    try {
      const r = await getSlateInsight(line);
      setInsight(r.insight);
    } catch (err) {
      setInsightErr((err as Error).message);
    } finally {
      setInsightLoading(false);
    }
  }
  const hit = line.hitProbability;
  const pct = hit?.mightHitPct ?? 0;
  const lean = hit?.lean ?? 'OVER';
  const cls = pct >= 75 && lean === 'OVER'
    ? 'slate-badge green'
    : pct >= 75 && lean === 'UNDER'
    ? 'slate-badge red'
    : 'slate-badge gray';

  const ratio = hit?.lean === 'OVER' ? hit?.hitOver : hit?.hitUnder;
  const hitCount = ratio != null ? Math.round(ratio * line.gamesAnalyzed) : 0;
  const aboveOrBelow = lean === 'OVER' ? 'over' : 'under';

  const inj = line.injury;
  const cardCls = [
    'slate-card',
    inParlay ? 'in-parlay' : '',
    inj?.status === 'Out' ? 'is-out' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cardCls}>
      <button
        className={inParlay ? 'slate-pin pinned' : 'slate-pin'}
        onClick={onToggleParlay}
        title={inParlay ? 'Remove from parlay' : 'Add to parlay'}
        aria-label={inParlay ? 'Remove from parlay' : 'Add to parlay'}
      >
        {inParlay ? '✓' : '+'}
      </button>

      <LineCardStar line={line} />

      {inj && <InjuryChip injury={inj} />}
      {showEdge && (
        <div className="slate-edge" title="Composite edge score: confidence + line-gap + vs-opp + trend, minus injury penalty">
          ⚡ {edgeScore(line)}
        </div>
      )}

      <Link
        className="slate-card-body"
        to={`/compare?m=last10&pid=${line.playerId}`}
        title="See player's last 10 games"
      >
        <PlayerAvatar playerId={line.playerId} name={line.playerName} size="lg" />
        <div className="slate-card-name">{line.playerName}</div>
        <div className="slate-card-meta">
          {line.team && (
            <TeamLogo abbr={line.team} name={line.team} size="md" />
          )}
          <span>
            {line.team ?? '—'}
            {line.position && ` · ${line.position}`}
          </span>
        </div>
        <div className="slate-line">
          <span className="slate-line-num">{line.line}</span>
          <span className="slate-line-stat">{line.statLabel}</span>
        </div>
        {hit ? (
          <>
            <div className={cls}>
              <span className="slate-pct">{pct}%</span>
              <span className="slate-lean">{lean}</span>
            </div>
            <div className="slate-receipts">
              Hit {hitCount}/{line.gamesAnalyzed} {aboveOrBelow} · L10 avg{' '}
              <strong>{line.last10Avg.toFixed(1)}</strong>
            </div>
          </>
        ) : line.statKey === 'double_double' ? (
          <div className="slate-receipts">
            DD rate: <strong>{Math.round((line.ddRate ?? 0) * 100)}%</strong> in last {line.gamesAnalyzed}
          </div>
        ) : (
          <div className="slate-receipts">No probability available.</div>
        )}
        {line.vsOpponent && (
          <VsOppRow
            opp={line.vsOpponent}
            line={line.line}
            isDD={line.statKey === 'double_double'}
          />
        )}
        {line.trend && line.last10Avg > 0 && (
          <TrendChip trend={line.trend} l10Avg={line.last10Avg} />
        )}
        {line.archetype && line.archetype.archetype !== 'Insufficient Data' && (
          <ArchetypeChip archetype={line.archetype} />
        )}
        {line.projection && !line.projection.noProjection && (
          <ProjectionLeanBadge projection={line.projection} />
        )}
      </Link>

      {line.projection && !line.projection.noProjection && (
        <ProjectionPanel projection={line.projection} />
      )}

      {line.projection && !line.projection.noProjection && (
        <div style={{ padding: '6px 12px 0' }}>
          <ProjectionBand
            rangeLow={line.projection.projection.rangeLow}
            projection={line.projection.projection.final}
            rangeHigh={line.projection.projection.rangeHigh}
            line={line.line}
            lean={(line.projection.edge.lean ?? '').toLowerCase().includes('under') ? 'UNDER' : 'OVER'}
          />
        </div>
      )}

      <LineCardLivePill
        playerId={line.playerId}
        statKey={line.statKey}
        line={line.line}
        leanDirection={lean === 'OVER' ? 'OVER' : 'UNDER'}
      />

      {/* Engine reasoning — modelNotes from the projection. Free-tier
          surface; appears alongside the Pro AI-insight button so users
          on either plan see WHY the model picked this leg. */}
      {line.projection?.modelNotes && line.projection.modelNotes.length > 0 && (
        <div style={{
          margin: '8px 12px 0',
          padding: '8px 10px',
          background: 'rgba(122,162,255,0.06)',
          border: '1px solid rgba(122,162,255,0.18)',
          borderLeft: '2px solid rgba(122,162,255,0.45)',
          borderRadius: 'var(--radius-sm)',
        }}>
          <div style={{
            fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
            textTransform: 'uppercase', color: '#7aa2ff', marginBottom: 4,
          }}>
            Why this pick
          </div>
          <ul style={{ margin: 0, paddingLeft: 14, fontSize: 11, lineHeight: 1.5, color: 'rgba(255,255,255,0.78)' }}>
            {line.projection.modelNotes.slice(0, 3).map((n, i) => (
              <li key={i} style={{ marginBottom: 1 }}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {canInsight && !insight && !insightLoading && (
        <button className="slate-why" onClick={loadInsight}>
          Why? <span className="slate-why-icon" aria-hidden>✨</span>
        </button>
      )}
      {!canInsight && (
        <button className="slate-why locked" disabled title="AI insights are a Pro feature">
          Why? <span className="lock-pill small">PRO</span>
        </button>
      )}
      {canInsight && insightLoading && (
        <div className="slate-insight loading">Analyzing…</div>
      )}
      {insight && (
        <div className="slate-insight">{insight}</div>
      )}
      {insightErr && (
        <div className="slate-insight error">{insightErr}</div>
      )}
    </div>
  );
}

// "Best Picks" rail — pre-computed parlay combos at sizes 2-6 plus a
// "Wild Card" longshot. Computed server-side (backend slateCombos.ts)
// per the slate-builder spec: top-down progressive structure (Best 6
// is the max slate; smaller cards are subsets), exposure caps to
// prevent over-concentration on one player/team/game/stat, and a
// correlation-adjusted combined hit %. Frontend is a pure renderer
// — every visitor sees the same combos the snapshot writer stores.
// Polls /api/live/today every 30s while there's at least one live
// game; otherwise re-fetches on a slower 60s cadence so the UI
// catches the moment the first game starts. Server-side cache
// debounces upstream traffic — clients can poll freely.
function useNbaLiveToday(): NbaLiveTodayResponse | null {
  const [feed, setFeed] = useState<NbaLiveTodayResponse | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getNbaLiveToday()
      .then((d) => { if (!cancelled) setFeed(d); })
      .catch(() => { /* silent — pre-game or out-of-season is fine */ });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    const anyLive = feed
      ? Object.values(feed.byGame).some((g) => g.state === 'live')
      : false;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    // 45s while live / 90s otherwise. Stays well within Vercel Pro's
    // 1M-invocation/month included quota even with sustained traffic.
    }, anyLive ? 45_000 : 90_000);
    return () => window.clearInterval(interval);
  }, [feed]);

  return feed;
}

// Map slate stat keys to live ESPN-projected fields. Keep in sync
// with backend/src/services/last10.ts Last10StatId.
function nbaLiveValueForStat(stats: NbaLiveTodayPlayer, statKey: string): number | null {
  switch (statKey) {
    case 'points':              return stats.points;
    case 'rebounds':            return stats.rebounds;
    case 'assists':             return stats.assists;
    case 'three_pt_made':       return stats.threePtMade;
    case 'fg_made':             return stats.fgMade;
    case 'fg_attempted':        return stats.fgAttempted;
    case 'ft_made':             return stats.ftMade;
    case 'ft_attempted':        return stats.ftAttempted;
    case 'personal_fouls':      return stats.personalFouls;
    case 'steals':              return stats.steals;
    case 'blocks':              return stats.blocks;
    case 'turnovers':           return stats.turnovers;
    case 'offensive_rebounds':  return stats.offensiveRebounds;
    case 'defensive_rebounds':  return stats.defensiveRebounds;
    case 'pra':                 return stats.pra;
    case 'pr':                  return stats.pr;
    case 'pa':                  return stats.pa;
    case 'ra':                  return stats.ra;
    case 'stocks':              return stats.stocks;
    case 'double_double':       return stats.doubleDouble;
    default:                    return null;
  }
}

type LiveGrade = 'HIT' | 'MISS' | 'PROGRESS' | 'PUSH' | 'PENDING';

function gradeNbaLeg(
  direction: 'OVER' | 'UNDER',
  line: number,
  current: number | null,
  state: 'pregame' | 'live' | 'final' | undefined,
): LiveGrade {
  if (current === null || !state || state === 'pregame') return 'PENDING';
  const isFinal = state === 'final';
  if (direction === 'OVER') {
    if (current > line) return 'HIT';
    if (isFinal) return current === line ? 'PUSH' : 'MISS';
    return 'PROGRESS';
  }
  if (current > line) return 'MISS';
  if (isFinal) return current === line ? 'PUSH' : 'HIT';
  return 'PROGRESS';
}

function resolveNbaLegLive(
  liveToday: NbaLiveTodayResponse | null,
  leg: { playerId: number; statKey: string; line: number; direction: 'OVER' | 'UNDER' },
): { grade: LiveGrade; current: number | null } {
  if (!liveToday) return { grade: 'PENDING', current: null };
  const ps = liveToday.byPlayer[String(leg.playerId)];
  if (!ps) return { grade: 'PENDING', current: null };
  const game = liveToday.byGame[ps.eventId];
  const current = nbaLiveValueForStat(ps, leg.statKey);
  return { grade: gradeNbaLeg(leg.direction, leg.line, current, game?.state), current };
}

function BestPicksRail({
  combos,
  onLoad,
  activeKeys,
  onPlayerClick,
}: {
  combos: SlateCombo[];
  // Lines kept on the props for a future "click leg → scroll to card"
  // affordance. Not strictly needed today.
  lines: SlateResolvedLine[];
  onLoad: (legs: string[]) => void;
  activeKeys: string[];
  cardKey: (l: SlateResolvedLine) => string;
  onPlayerClick: (p: NbaDrilldownPlayer) => void;
}) {
  // Live grading — fetched once at the rail level, threaded into
  // each card. When no games are live, every leg is PENDING and the
  // cards render exactly as before.
  const liveToday = useNbaLiveToday();

  if (combos.length === 0) return null;

  function legKey(l: SlateCombo['legs'][number]): string {
    return `${l.playerId}-${l.statKey}-${l.line}`;
  }

  // Aggregate live status across every combo. Same shape as MLB's
  // SlateLiveSummary — cleared / dead / live / pending counters +
  // simulated $1-stake P/L for settled cards.
  type CardStatus = 'cleared' | 'dead' | 'live' | 'pending';
  function statusForLegs(legs: SlateCombo['legs']): CardStatus {
    const grades = legs.map((l) => resolveNbaLegLive(liveToday, l));
    if (grades.some((g) => g.grade === 'MISS')) return 'dead';
    const allHit = grades.length > 0 && grades.every((g) => g.grade === 'HIT' || g.grade === 'PUSH');
    if (allHit) return 'cleared';
    if (grades.some((g) => g.grade === 'PROGRESS' || g.grade === 'HIT')) return 'live';
    return 'pending';
  }
  const FLEX_PAYOUTS: Record<string, number> = {
    'Best 2': 3, 'Best 3': 5, 'Best 4': 10, 'Best 5': 7, 'Best 6': 25, 'Wild Card': 5,
  };
  const cardsWithStatus = combos
    .filter((c) => c.legs.length > 0)
    .map((c) => ({ name: c.label, status: statusForLegs(c.legs) }));
  const liveSummary = (() => {
    if (!liveToday) return null;
    const cleared = cardsWithStatus.filter((c) => c.status === 'cleared').length;
    const dead = cardsWithStatus.filter((c) => c.status === 'dead').length;
    const live = cardsWithStatus.filter((c) => c.status === 'live').length;
    const pending = cardsWithStatus.filter((c) => c.status === 'pending').length;
    if (cleared + dead + live === 0) return null;
    let profit = 0;
    for (const c of cardsWithStatus) {
      if (c.status === 'cleared') profit += (FLEX_PAYOUTS[c.name] ?? 1) - 1;
      else if (c.status === 'dead') profit -= 1;
    }
    // Phase 92: per-leg totals (de-duped — same player+stat+line+dir
    // can appear on multiple cards).
    const seenLeg = new Set<string>();
    let legHit = 0, legMiss = 0, legProgress = 0, legPending = 0;
    for (const c of combos) {
      for (const l of c.legs) {
        const key = `${l.playerId}::${l.statKey}::${l.line}::${l.direction}`;
        if (seenLeg.has(key)) continue;
        seenLeg.add(key);
        const g = resolveNbaLegLive(liveToday, l);
        if (g.grade === 'HIT')           legHit += 1;
        else if (g.grade === 'MISS')     legMiss += 1;
        else if (g.grade === 'PROGRESS') legProgress += 1;
        else                              legPending += 1;
      }
    }
    return { cleared, dead, live, pending, profit, legHit, legMiss, legProgress, legPending };
  })();

  return (
    <div className="best-picks">
      <div className="best-picks-head">
        <h3>Pre-built parlays</h3>
        <span className="muted small">
          Each card is independent — different picks where the slate
          allows, so one bad leg only sinks the cards using it. Best 6
          anchors the safest picks; smaller cards draw fresh ones.
        </span>
      </div>
      {/* Iter 14 (user 2026-05-10): "Safe core, value, positive ev,
          elite, medium what does all that mean". The chip vocabulary
          is internal jargon — surface a plain-English glossary
          inline so users can read the cards without guessing. */}
      <PicksGlossary />
      {liveSummary && (
        <div
          style={{
            margin: '12px 0',
            padding: '10px 14px',
            borderRadius: 6,
            background: liveSummary.dead > 0 && liveSummary.cleared === 0
              ? 'rgba(239, 83, 80, 0.10)'
              : liveSummary.cleared > 0
              ? 'rgba(102, 187, 106, 0.10)'
              : 'rgba(122, 162, 255, 0.10)',
            border: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            gap: 16,
            flexWrap: 'wrap',
            alignItems: 'baseline',
            fontSize: 13,
          }}
          title="Live aggregate across every card on tonight's slate. Cleared = all legs hit; Dead = at least one leg missed; Live = still in progress; Pending = game hasn't started."
        >
          <strong style={{ fontSize: 14, letterSpacing: '0.02em' }}>
            Slate live status
          </strong>
          <span style={{ color: '#66bb6a', fontWeight: 700 }}>● {liveSummary.cleared} CLEARED</span>
          <span style={{ color: '#ef5350', fontWeight: 700 }}>● {liveSummary.dead} DEAD</span>
          <span style={{ color: '#7aa2ff', fontWeight: 700 }}>● {liveSummary.live} LIVE</span>
          {liveSummary.pending > 0 && (
            <span className="muted small">{liveSummary.pending} pending tipoff</span>
          )}
          <span
            title="Per-leg totals across every card. De-duped so a leg on multiple cards counts once."
            style={{
              paddingLeft: 12,
              marginLeft: 4,
              borderLeft: '1px solid rgba(255,255,255,0.12)',
              display: 'flex',
              gap: 10,
              alignItems: 'baseline',
            }}
          >
            <span className="muted small">Legs ({liveSummary.legHit + liveSummary.legMiss + liveSummary.legProgress + liveSummary.legPending})</span>
            <span style={{ color: '#66bb6a', fontWeight: 700 }}>{liveSummary.legHit} hit</span>
            <span style={{ color: '#ef5350', fontWeight: 700 }}>{liveSummary.legMiss} miss</span>
            <span style={{ color: '#7aa2ff', fontWeight: 700 }}>{liveSummary.legProgress} live</span>
            {liveSummary.legPending > 0 && (
              <span className="muted small">{liveSummary.legPending} pending</span>
            )}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span className="muted small">Simulated $1 P/L</span>
            <strong
              style={{
                fontSize: 14,
                color: liveSummary.profit > 0 ? '#66bb6a' : liveSummary.profit < 0 ? '#ef5350' : undefined,
              }}
            >
              {liveSummary.profit >= 0 ? '+' : ''}${liveSummary.profit.toFixed(2)}
            </strong>
          </span>
        </div>
      )}
      <div className="best-picks-rail">
        {combos.map((c) => {
          const keys = c.legs.map(legKey);
          const isActive = keys.length > 0
            && keys.every((k) => activeKeys.includes(k))
            && keys.length === activeKeys.length;
          const isWild = c.tag === 'wild';
          // No-edge fallback: chain found nothing across all six tiers.
          // Render the "closest candidates" view instead of an empty
          // tile, so the section stays informative per spec §"Closest
          // Candidate Logic".
          if (isWild && c.wildCardKind === 'no_edge') {
            return (
              <div key={c.label} className="best-pick-card wild empty-wild" aria-disabled="true">
                <div className="best-pick-head">
                  <div className="best-pick-titles">
                    <span className="best-pick-label">{c.label}</span>
                    <span className="best-pick-subtitle">No Strong Wild Card Tonight</span>
                  </div>
                </div>
                <div className="empty-wild-body">
                  <p>No high-upside opportunity met the model's thresholds.</p>
                  <p className="muted small">
                    Showing closest candidates so you can see how near we got.
                  </p>
                </div>
                {c.closestCandidates && c.closestCandidates.length > 0 && (
                  <div className="best-pick-legs">
                    {c.closestCandidates.map((l, i) => (
                      <div key={i} className="best-pick-leg-block">
                        <div className="best-pick-leg">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPlayerClick({ playerId: l.playerId, playerName: l.playerName, team: l.team });
                            }}
                            className="best-pick-leg-name slate-leg-button"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                            title="Click for player drilldown"
                          >
                            <PlayerAvatar playerId={l.playerId} name={l.playerName} size="md" />
                            {l.playerName}
                            {l.team && (
                              <span className="slate-leg-team">
                                <TeamLogo abbr={l.team} name={l.team} size="md" />
                                <span>{l.team}</span>
                              </span>
                            )}
                          </button>
                          <span className="best-pick-leg-stat">
                            {l.statLabel} {l.line}
                          </span>
                          <span className={`best-pick-leg-dir ${l.direction === 'OVER' ? 'over' : 'under'}`}>
                            {l.direction === 'OVER' ? '↑' : '↓'} {Math.round(l.probability)}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          // Empty Wild Card with no kind metadata (legacy snapshots
          // before the chain rewrite). Fall back to the simple
          // placeholder rather than crashing.
          if (isWild && c.legs.length === 0) {
            return (
              <div key={c.label} className="best-pick-card wild empty-wild" aria-disabled="true">
                <div className="best-pick-head">
                  <div className="best-pick-titles">
                    <span className="best-pick-label">{c.label}</span>
                    <span className="best-pick-subtitle">Higher Risk / Higher Upside</span>
                  </div>
                </div>
                <div className="empty-wild-body">
                  <p>No Wild Card available tonight</p>
                  <p className="muted small">
                    Not enough historical support — needs ≥3 of last 10 + ≥1 vs current opponent.
                  </p>
                </div>
              </div>
            );
          }
          // Live grading: evaluate each leg against current ESPN
          // boxscore stats. When no game is live yet, every leg is
          // PENDING and we render the static design unchanged.
          const grades = c.legs.map((l) => resolveNbaLegLive(liveToday, l));
          const tally = {
            hit: grades.filter((g) => g.grade === 'HIT').length,
            miss: grades.filter((g) => g.grade === 'MISS').length,
            progress: grades.filter((g) => g.grade === 'PROGRESS').length,
            push: grades.filter((g) => g.grade === 'PUSH').length,
          };
          const anyLive = tally.hit + tally.miss + tally.progress + tally.push > 0;
          const cardDead = tally.miss > 0;
          const cardCleared = !cardDead && tally.hit === c.legs.length;

          return (
            <button
              key={c.label}
              className={`best-pick-card ${isWild ? 'wild' : ''} ${isActive ? 'active' : ''}`}
              onClick={() => onLoad(keys)}
              title={`Load ${c.label} (${c.subtitle}) into your parlay tray`}
            >
              <div className="best-pick-head">
                <div className="best-pick-titles">
                  <span className="best-pick-label">{c.label}</span>
                  <span className="best-pick-subtitle">{c.subtitle}</span>
                </div>
                <span className="best-pick-size">{c.legs.length}-leg</span>
              </div>
              {anyLive && (
                <div
                  style={{
                    margin: '0 16px 8px',
                    padding: '6px 10px',
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    background: cardCleared ? 'rgba(102, 187, 106, 0.16)' : cardDead ? 'rgba(239, 83, 80, 0.16)' : 'rgba(122, 162, 255, 0.12)',
                    color: cardCleared ? '#66bb6a' : cardDead ? '#ef5350' : '#7aa2ff',
                    display: 'flex',
                    gap: 12,
                    flexWrap: 'wrap',
                    textAlign: 'left',
                  }}
                  title="Live grading — each leg checked against current ESPN box score. ANY miss kills the whole parlay."
                >
                  {cardCleared && <span>✓ ALL {c.legs.length} HIT — CARD CLEARED</span>}
                  {cardDead && <span>✗ {tally.miss} LEG{tally.miss === 1 ? '' : 'S'} DEAD</span>}
                  {!cardCleared && !cardDead && <span>● {tally.hit}/{c.legs.length} HIT · {tally.progress} LIVE</span>}
                </div>
              )}
              <div
                className="best-pick-pct"
                title={`Adjusted combined hit %. Multiplies each leg's probability and applies a correlation penalty (${c.correlationRisk} risk this card). Raw uncorrected: ${c.rawCombinedHit.toFixed(1)}%.`}
              >
                {c.adjustedCombinedHit.toFixed(1)}%
              </div>
              <div className="best-pick-pct-label">
                adjusted hit · {c.correlationRisk} correlation
              </div>
              {/* Insane mode: lottery-payout banner. Power Play +
                  Demon-stacked target payout is the headline number
                  on these cards. Iter 10 corrected the per-Demon
                  multiplier label (1.05× per FAQ, not 1.25×) and the
                  realistic ceiling (~18× on a 6-leg all-Demon card,
                  not 100×+). The displayed `payoutMultiplier` IS
                  computed correctly per card from the 14× / 9× base
                  ladder and demon count. */}
              {c.playType === 'power' && c.payoutMultiplier !== undefined && (
                <div
                  className="best-pick-lottery"
                  title={`Power Play (all-or-nothing) target payout. ${c.demonCount ? `${c.demonCount} of ${c.legs.length} legs are PrizePicks Demons (1.05× each). ` : ''}$1 stake → $${Math.round(c.payoutMultiplier)} if every leg hits. Hit rate is intentionally low — this is a lottery ticket.`}
                >
                  <span className="lottery-payout">~{Math.round(c.payoutMultiplier)}×</span>
                  <span className="lottery-target"> target · $1 → ${Math.round(c.payoutMultiplier)}</span>
                  {/* Iter 11: be HONEST about the demon makeup. The
                      pre-iter-11 copy said "6 Demons stacked" whenever
                      the badge rendered — even when only some legs
                      were demons. Now we say "all 6 Demons" only when
                      it's actually all-demon, otherwise "N of M Demons"
                      so the user can see at a glance whether this is
                      a true lottery card or a mixed bag. */}
                  {c.demonCount && c.demonCount > 0 ? (
                    <span className="lottery-demons">
                      {' '}· {c.demonCount === c.legs.length
                        ? `all ${c.demonCount} Demon${c.demonCount === 1 ? '' : 's'} stacked`
                        : `${c.demonCount} of ${c.legs.length} Demon${c.demonCount === 1 ? '' : 's'}`}
                    </span>
                  ) : null}
                </div>
              )}
              {/* EV verdict + payout (standard Flex Play modes only).
                  Positive EV means the card's expected return per $1
                  staked beats break-even. Surfacing this prevents the
                  "5.8x payout, 18% combined hit = bad value" trap.
                  Suppressed on Power Play / Insane because the
                  lottery banner above carries the same information. */}
              {c.playType !== 'power' && c.evVerdict && c.expectedValue !== undefined && (
                <div className={`best-pick-ev ${c.evVerdict.toLowerCase().replace(' ', '-')}`}
                  title={`Expected value per $1 staked. Win prob ${c.adjustedCombinedHit.toFixed(1)}% × payout ${c.payoutMultiplier ?? '?'}× − $1 = ${c.expectedValue >= 0 ? '+' : ''}${c.expectedValue.toFixed(2)}. Average leg edge vs implied break-even: ${c.averageEdge !== undefined ? (c.averageEdge >= 0 ? '+' : '') + c.averageEdge.toFixed(1) : '—'}%.`}
                >
                  {c.evVerdict} · {c.expectedValue >= 0 ? '+' : ''}{c.expectedValue.toFixed(2)} EV
                  {c.payoutMultiplier !== undefined && (
                    <span className="best-pick-ev-payout"> · {c.payoutMultiplier}× payout</span>
                  )}
                </div>
              )}
              {/* Card-level market-disagreement signals. Tells the
                  user at a glance whether the card found genuine
                  inefficiency (high disagreement, low trap exposure)
                  or just stacked safe-looking props. */}
              {(c.averageEdge !== undefined || c.averageProjectionGap !== undefined) && (
                <div className="best-pick-signals">
                  {c.averageEdge !== undefined && (
                    <div className="best-pick-signal">
                      <span className="muted small">Avg Edge</span>
                      <strong className={c.averageEdge >= 10 ? 'pos' : c.averageEdge <= -5 ? 'neg' : ''}>
                        {c.averageEdge >= 0 ? '+' : ''}{c.averageEdge.toFixed(1)}%
                      </strong>
                    </div>
                  )}
                  {c.averageProjectionGap !== undefined && (
                    <div className="best-pick-signal">
                      <span className="muted small">Proj Gap</span>
                      <strong>+{c.averageProjectionGap.toFixed(1)}</strong>
                    </div>
                  )}
                  {c.trapExposure && (
                    <div className="best-pick-signal">
                      <span className="muted small">Trap</span>
                      <strong className={`trap-${c.trapExposure.toLowerCase()}`}>{c.trapExposure}</strong>
                    </div>
                  )}
                  {c.marketDisagreementRating && (
                    <div className="best-pick-signal">
                      <span className="muted small">Mkt Disagree</span>
                      <strong className={`disagree-${c.marketDisagreementRating.toLowerCase()}`}>
                        {c.marketDisagreementRating}
                      </strong>
                    </div>
                  )}
                </div>
              )}
              {/* One-Short Prevention call-out — names the leg most
                  likely to fail and explains why. Drives user
                  decisions about whether to trim the card. Only shows
                  when a card is Fragile or worse; Strong/Acceptable
                  cards stay quiet. */}
              {c.weakestLegName && c.cardFragility
                && c.cardFragility !== 'Strong' && c.cardFragility !== 'Acceptable' && (
                <div
                  className={`best-pick-weakest weakest-${(c.cardFragility ?? '').toLowerCase().replace(/ /g, '-')}`}
                  title="The leg most likely to short this card. If you're going to trim, start here."
                >
                  <span>Weakest leg: <strong>{c.weakestLegName}</strong>
                  {c.weakestLegReason && <> — {c.weakestLegReason}</>}
                  </span>
                </div>
              )}
              <div className="best-pick-legs">
                {c.legs.map((l, i) => {
                  const live = grades[i];
                  return (
                  <div key={i} className="best-pick-leg-block">
                    <div className="best-pick-leg">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlayerClick({ playerId: l.playerId, playerName: l.playerName, team: l.team });
                        }}
                        className="best-pick-leg-name slate-leg-button"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                        title="Click for player drilldown"
                      >
                        <PlayerAvatar playerId={l.playerId} name={l.playerName} size="md" />
                        {l.playerName}
                        {l.team && (
                          <span className="slate-leg-team">
                            <TeamLogo abbr={l.team} name={l.team} size="md" />
                            <span>{l.team}</span>
                          </span>
                        )}
                      </button>
                      <span className="best-pick-leg-stat">
                        {l.statLabel}{' '}
                        {l.lineRaised && l.originalLine !== undefined ? (
                          <>
                            <span className="best-pick-leg-line-orig">{l.originalLine}</span>
                            {' → '}
                            <strong className="best-pick-leg-line-raised">{l.line}</strong>
                          </>
                        ) : (
                          l.line
                        )}
                      </span>
                      <span className={`best-pick-leg-dir ${l.direction === 'OVER' ? 'over' : 'under'}`}>
                        {l.direction === 'OVER' ? '↑' : '↓'} {Math.round(l.probability)}%
                      </span>
                      <span
                        className={`best-pick-leg-conf conf-${l.confidenceLabel.toLowerCase()}`}
                        title={
                          l.confidenceLabel === 'Elite'
                            ? 'Elite confidence — model has 75-100 conviction (deep sample, multiple windows agree, low variance).'
                            : l.confidenceLabel === 'Strong'
                            ? 'Strong confidence — 65-74. Most signals align; small concerns prevent Elite tier.'
                            : l.confidenceLabel === 'Medium'
                            ? 'Medium confidence — 50-64. Mixed signals; usable but not a lock.'
                            : 'Low confidence — under 50. Sample is thin or windows disagree; treat with caution.'
                        }
                      >
                        {l.confidenceLabel}
                      </span>
                      <NbaComboLegStar leg={l} />
                    </div>
                    {/* EV-engine per-leg metadata: edge%, category,
                        trap badge (when flagged). Edge% tells the user
                        how mispriced this leg is vs implied. Category
                        labels Safe Core / Value / Ceiling / Contrarian.
                        Trap badge only appears for High/Extreme tiers. */}
                    {(l.edgePercent !== undefined || l.category || live.grade !== 'PENDING') && (
                      <div className="best-pick-leg-evbar">
                        {l.edgePercent !== undefined && (
                          <span
                            className={`best-pick-leg-edge ${l.edgePercent >= 5 ? 'pos' : l.edgePercent <= -5 ? 'neg' : 'flat'}`}
                            title="Edge % vs implied break-even. Positive = market underpricing."
                          >
                            {l.edgePercent >= 0 ? '+' : ''}{l.edgePercent.toFixed(0)}% edge
                          </span>
                        )}
                        {l.category && (
                          <span
                            className={`best-pick-leg-cat cat-${l.category.toLowerCase().replace(' ', '-')}`}
                            title={
                              l.category === 'Safe Core'
                                ? 'Safe Core — high-probability anchor leg, low variance. The kind of leg you build a card around.'
                                : l.category === 'Value'
                                ? 'Value — model thinks the line is mispriced (real edge vs the de-vigged market). The bet you make money on long-run.'
                                : l.category === 'Ceiling'
                                ? 'Ceiling — high-upside leg. Player has blow-out potential when the matchup or pace breaks right.'
                                : l.category === 'Contrarian'
                                ? 'Contrarian — model disagrees with public sentiment / market consensus. Risky but high-edge when right.'
                                : `${l.category} — leg category`
                            }
                          >
                            {l.category}
                          </span>
                        )}
                        {(l.trapTier === 'High Trap Risk' || l.trapTier === 'Extreme Trap Risk') && (
                          <span
                            className="best-pick-leg-trap"
                            title={`Possible public-trap line: recent spike + line inflation. Trap score ${l.trapScore ?? '—'}. Interpret with caution.`}
                          >
                            ⚠ {l.trapTier}
                          </span>
                        )}
                        {live.grade !== 'PENDING' && (
                          <span
                            style={{
                              marginLeft: 'auto',
                              fontSize: 11,
                              fontWeight: 700,
                              letterSpacing: '0.04em',
                              color:
                                live.grade === 'HIT' ? '#66bb6a'
                                : live.grade === 'MISS' ? '#ef5350'
                                : live.grade === 'PUSH' ? '#ffb74d'
                                : '#7aa2ff',
                            }}
                            title={live.current !== null ? `Current: ${live.current}` : 'Game not started'}
                          >
                            {live.grade}{live.current !== null ? ` · ${live.current}` : ''}
                          </span>
                        )}
                      </div>
                    )}
                    {/* Wild Card legs surface their historical evidence
                        + a one-line "why this is a Wild Card" narrative
                        so the user can read the support, not just the %. */}
                    {isWild && l.wildCardReason && (
                      <div className="best-pick-wild-evidence">
                        {l.wildCardReason}
                      </div>
                    )}
                    {l.lineRaised && (
                      <div
                        className="best-pick-leg-raised-note"
                        title="The model has elite conviction at the offered line — surfacing this as a higher-line analytical signal. Not bookable on PrizePicks; treat as upside reference."
                      >
                        ↑ raised line · model still favors {l.direction.toLowerCase()}
                      </div>
                    )}
                    <WhyPickPanel
                      sportColor="#7aa2ff"
                      leg={{
                        playerName: l.playerName,
                        statLabel: l.statLabel,
                        line: l.line,
                        direction: l.direction,
                        probability: l.probability,
                        edgePercent: l.edgePercent ?? 0,
                        projection: l.projection,
                        trapScore: l.trapScore,
                        trapTier: l.trapTier,
                        fragilityScore: l.fragilityScore,
                        fragilityTier: l.fragilityTier,
                        riskScore: l.risk,
                        l10HitCount: l.last10HitCount,
                        l10HitRate: l.last10HitRate,
                        vsOpponentHitRate: l.vsOpponentHitRate,
                        vsOpponentGames: l.vsOpponentGames,
                      }}
                    />
                  </div>
                  );
                })}
              </div>
              {c.warnings.length > 0 && (
                <div className="best-pick-warnings">
                  {c.warnings.map((w, i) => (
                    <span key={i} className="best-pick-warning"><span>{w}</span></span>
                  ))}
                </div>
              )}
              <div className="best-pick-cta">
                {isActive ? '✓ Loaded' : 'Load parlay →'}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Iter 14 — plain-English glossary for the chip vocabulary. User
// directive 2026-05-10: "Safe core, value, positive ev, elite, medium
// what does all that mean". Renders a collapsed-by-default help row
// under the picks header. Definition strings are deliberately short
// and concrete; if a user wants the math, the per-chip title tooltips
// carry it.
function PicksGlossary() {
  const [open, setOpen] = useState(false);
  const items: Array<[string, string]> = [
    ['Elite',       'Confidence 75-100. Deep sample, multiple windows agree, low variance.'],
    ['Strong',      'Confidence 65-74. Most signals align; minor concerns hold it back from Elite.'],
    ['Medium',      'Confidence 50-64. Mixed signals; usable but not a lock.'],
    ['Safe Core',   'High-probability anchor leg, low variance. The kind of leg you build a card around.'],
    ['Value',       'Model thinks the line is mispriced (real edge vs the de-vigged sportsbook). Where long-run profit comes from.'],
    ['Ceiling',     'High-upside leg. Player has blow-out potential when matchup or pace breaks right.'],
    ['Contrarian',  'Model disagrees with public sentiment. Risky but high-edge when right.'],
    ['Positive EV', 'Card is +EV: win-prob × payout > 1. Profitable long-run even if individual cards lose.'],
    ['Neutral EV',  'Card breaks even. No real edge over PrizePicks pricing.'],
    ['Negative EV', 'Card is −EV: payout doesn\'t beat the implied break-even. Don\'t play.'],
  ];
  return (
    <div style={{
      margin: '0 0 14px',
      borderRadius: 10,
      border: '1px solid rgba(255,255,255,0.08)',
      background: 'linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0.005) 100%)',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          background: 'transparent',
          border: 0,
          color: 'rgba(255,255,255,0.65)',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.02em',
          textAlign: 'left',
        }}
      >
        <span>
          <span style={{
            fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: '#7aa2ff', marginRight: 8,
          }}>
            Legend
          </span>
          What do <em style={{ fontStyle: 'normal', color: 'var(--text-1)' }}>Safe Core, Value, Elite, Positive EV</em> mean?
        </span>
        <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{open ? '▾ hide' : '▸ show'}</span>
      </button>
      {open && (
        <div style={{
          padding: '4px 14px 14px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '8px 16px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}>
          {items.map(([term, def]) => (
            <div key={term} style={{ fontSize: 12, lineHeight: 1.45 }}>
              <strong style={{ color: 'var(--text-1)', fontWeight: 700, marginRight: 6 }}>{term}</strong>
              <span style={{ color: 'rgba(255,255,255,0.65)' }}>{def}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Tooltip text helpers — when the user hovers a probability or edge
// chip, explain what the number actually represents. Kept short so
// the native title tooltip stays one or two readable lines.
function pctTooltip({
  pct,
  dir,
  isDD,
  isOverridden,
  statLabel,
  line,
}: {
  pct: number;
  dir: 'over' | 'under' | 'flat';
  isDD: boolean;
  isOverridden: boolean;
  statLabel: string;
  line: number;
}): string {
  if (isDD) {
    return `Double-Double rate: this player has hit a DD in ${pct}% of their last 10 games. There's no Over/Under line on a DD prop — it's a binary outcome.`;
  }
  const side = dir === 'over' ? 'OVER' : dir === 'under' ? 'UNDER' : 'either side';
  const dirText = dir === 'flat'
    ? `Coin flip — model has no clear edge on this prop.`
    : `Model says the ${side} side hits ${pct}% of the time.`;
  const blend = `Probability blends two signals: (1) the player's historical hit rate against this line over their last 10 games + every game vs this opponent this season, and (2) a normal-distribution z-score using the same blended sample's mean and variance.`;
  const override = isOverridden
    ? `\n\nYou've overridden the line to ${line} for ${statLabel} — this % was recomputed locally against the player's L10 sample.`
    : '';
  return `${dirText} ${blend}${override}`;
}

function edgeTooltip(score: number, label: string | null): string {
  const tier = score >= 75 ? 'Elite Edge'
    : score >= 60 ? 'Strong Edge'
    : score >= 40 ? 'Moderate Edge'
    : 'Weak Edge';
  return `${label ?? tier} (${score}/100). Composite score combining probability edge (35%), distance from the line vs variance (25%), historical hit rates (20%), confidence (15%), minus a risk penalty (5%). Score ≥ 60 = strong, ≥ 40 = moderate, < 40 = weak — likely a coin flip.`;
}

// Pinned-favorites section. Renders the user's starred players'
// cards above the rest of the slate so they're always one scroll
// away. Same PlayerCard component as the game sections — just
// surfaced first.
function FavoritesSection({
  lines,
  favorites,
  parlay,
  onToggleParlay,
  cardKey,
}: {
  lines: SlateResolvedLine[];
  favorites: FavoritesAPI;
  parlay: string[];
  onToggleParlay: (l: SlateResolvedLine) => void;
  cardKey: (l: SlateResolvedLine) => string;
}) {
  // Group favorited players' lines by playerId.
  const byPlayer = new Map<number, SlateResolvedLine[]>();
  for (const l of lines) {
    if (!favorites.isFavoritePlayer(l.playerId)) continue;
    const arr = byPlayer.get(l.playerId) ?? [];
    arr.push(l);
    byPlayer.set(l.playerId, arr);
  }
  if (byPlayer.size === 0) return null;

  return (
    <section className="favorites-section">
      <div className="favorites-section-head">
        <span className="favorites-section-star" aria-hidden>★</span>
        <h3>Your favorites</h3>
        <span className="muted small">
          {byPlayer.size} pinned player{byPlayer.size === 1 ? '' : 's'}
        </span>
      </div>
      <div className="player-card-grid">
        {[...byPlayer.values()].map((plines) => (
          <PlayerCard
            key={plines[0].playerId}
            lines={plines}
            parlay={parlay}
            onToggleParlay={onToggleParlay}
            cardKey={cardKey}
            favorites={favorites}
          />
        ))}
      </div>
    </section>
  );
}

// Game-grouped board: every line is bucketed by its matchup
// (team + opponent, normalized so PHI/NYK and NYK/PHI are the same
// game), and within each game players' props are merged into a
// single card so a player with 16 lines becomes 1 card with 16
// rows instead of 16 separate cards across the grid. Strongest game
// floats to the top by best in-game edge.
function GameGroupedBoard({
  lines,
  parlay,
  onToggleParlay,
  cardKey,
  favorites,
}: {
  lines: SlateResolvedLine[];
  parlay: string[];
  onToggleParlay: (l: SlateResolvedLine) => void;
  cardKey: (l: SlateResolvedLine) => string;
  favorites: FavoritesAPI;
}) {
  // Group: gameKey → { teams, players: Map<playerId, lines[]> }
  type Group = {
    teams: [string, string];
    players: Map<number, SlateResolvedLine[]>;
  };
  const groups = new Map<string, Group>();
  const ungrouped: SlateResolvedLine[] = [];

  for (const line of lines) {
    const team = line.team;
    const opp = line.vsOpponent?.opponentAbbr;
    if (!team || !opp) {
      ungrouped.push(line);
      continue;
    }
    const sortedPair = [team, opp].sort();
    const key = sortedPair.join('-');
    let g = groups.get(key);
    if (!g) {
      g = { teams: sortedPair as [string, string], players: new Map() };
      groups.set(key, g);
    }
    const arr = g.players.get(line.playerId) ?? [];
    arr.push(line);
    g.players.set(line.playerId, arr);
  }

  // Sort games by the best edge inside the game (so the matchup with
  // the most action surfaces first), then by alphabetical key as a
  // tiebreaker.
  const gameList = [...groups.entries()]
    .map(([key, g]) => {
      const allLines = [...g.players.values()].flat();
      const bestEdge = allLines.reduce(
        (m, l) => Math.max(m, l.projection?.edge.score ?? 0),
        0,
      );
      return { key, group: g, bestEdge };
    })
    .sort((a, b) => b.bestEdge - a.bestEdge || a.key.localeCompare(b.key));

  return (
    <div className="game-board">
      {gameList.map(({ key, group }) => (
        <GameSection
          key={key}
          teams={group.teams}
          players={group.players}
          parlay={parlay}
          onToggleParlay={onToggleParlay}
          cardKey={cardKey}
          favorites={favorites}
        />
      ))}
      {ungrouped.length > 0 && (
        <div className="game-section">
          <div className="game-section-head">
            <h3>Other</h3>
            <span className="muted small">{ungrouped.length} lines without a matchup</span>
          </div>
          <div className="player-card-grid">
            {[...new Map(ungrouped.map((l) => [l.playerId, ungrouped.filter((x) => x.playerId === l.playerId)])).entries()].map(
              ([pid, plines]) => (
                <PlayerCard
                  key={pid}
                  lines={plines}
                  parlay={parlay}
                  onToggleParlay={onToggleParlay}
                  cardKey={cardKey}
                  favorites={favorites}
                />
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GameSection({
  teams,
  players,
  parlay,
  onToggleParlay,
  cardKey,
  favorites,
}: {
  teams: [string, string];
  players: Map<number, SlateResolvedLine[]>;
  parlay: string[];
  onToggleParlay: (l: SlateResolvedLine) => void;
  cardKey: (l: SlateResolvedLine) => string;
  favorites: FavoritesAPI;
}) {
  // Sort players by best edge across their props — but favorited
  // players always rank above non-favorites within a game so your
  // names sit at the top of their matchup section.
  const playerList = [...players.values()]
    .map((plines) => ({
      lines: plines,
      bestEdge: plines.reduce((m, l) => Math.max(m, l.projection?.edge.score ?? 0), 0),
      isFav: favorites.isFavoritePlayer(plines[0].playerId),
    }))
    .sort((a, b) => {
      if (a.isFav !== b.isFav) return a.isFav ? -1 : 1;
      return b.bestEdge - a.bestEdge;
    });

  const allLines = [...players.values()].flat();
  const totalProps = allLines.length;
  const strongPlays = allLines.filter(
    (l) => (l.projection?.edge.score ?? 0) >= 60,
  ).length;

  // Either team in the matchup can be a favorite — we star whichever
  // matches the user's saved abbr.
  const favoriteTeam = favorites.isFavoriteTeam(teams[0])
    ? teams[0]
    : favorites.isFavoriteTeam(teams[1]) ? teams[1] : null;

  function toggleTeamFav(abbr: string) {
    favorites.setFavoriteTeam(favorites.isFavoriteTeam(abbr) ? null : abbr);
  }

  return (
    <section className={`game-section ${favoriteTeam ? 'has-fav-team' : ''}`}>
      <div className="game-section-head">
        <div className="game-section-teams">
          <button
            type="button"
            className={`team-fav-btn ${favorites.isFavoriteTeam(teams[0]) ? 'active' : ''}`}
            onClick={() => toggleTeamFav(teams[0])}
            title={favorites.isFavoriteTeam(teams[0]) ? `Unstar ${teams[0]}` : `Make ${teams[0]} your favorite team`}
            aria-label={`Favorite ${teams[0]}`}
          >
            <TeamLogo abbr={teams[0]} name={teams[0]} size="lg" />
            {favorites.isFavoriteTeam(teams[0]) && <span className="team-fav-star" aria-hidden>★</span>}
          </button>
          <span className="game-section-vs">vs</span>
          <button
            type="button"
            className={`team-fav-btn ${favorites.isFavoriteTeam(teams[1]) ? 'active' : ''}`}
            onClick={() => toggleTeamFav(teams[1])}
            title={favorites.isFavoriteTeam(teams[1]) ? `Unstar ${teams[1]}` : `Make ${teams[1]} your favorite team`}
            aria-label={`Favorite ${teams[1]}`}
          >
            <TeamLogo abbr={teams[1]} name={teams[1]} size="lg" />
            {favorites.isFavoriteTeam(teams[1]) && <span className="team-fav-star" aria-hidden>★</span>}
          </button>
          <h3>{teams[0]} @ {teams[1]}</h3>
        </div>
        <div className="game-section-stats">
          <span title="Number of unique players in this game with at least one prop on the board">
            <strong>{playerList.length}</strong> players
          </span>
          <span className="dot">·</span>
          <span title="Total number of individual prop lines across all players in this game">
            <strong>{totalProps}</strong> props
          </span>
          {strongPlays > 0 && (
            <>
              <span className="dot">·</span>
              <span
                className="hot"
                title="Props with an edge score ≥ 60 — the model considers these the highest-conviction plays in this game (strong probability lean + supporting confidence + manageable risk)"
              >
                <strong>{strongPlays}</strong> strong edges
              </span>
            </>
          )}
        </div>
      </div>
      <div className="player-card-grid">
        {playerList.map(({ lines: plines }) => (
          <PlayerCard
            key={plines[0].playerId}
            lines={plines}
            parlay={parlay}
            onToggleParlay={onToggleParlay}
            cardKey={cardKey}
            favorites={favorites}
          />
        ))}
      </div>
    </section>
  );
}

function PlayerCard({
  lines,
  parlay,
  onToggleParlay,
  cardKey,
  favorites,
}: {
  lines: SlateResolvedLine[];
  parlay: string[];
  onToggleParlay: (l: SlateResolvedLine) => void;
  cardKey: (l: SlateResolvedLine) => string;
  favorites: FavoritesAPI;
}) {
  // Collapsed by default — at scale a single game can have 17 players
  // × 16 props = 270+ rows expanded all at once. Now the page loads
  // with just the player headers + each player's strongest play as a
  // preview. Click anywhere on the header to expand the full list.
  const [expanded, setExpanded] = useState(false);

  const head = lines[0];
  const sorted = [...lines].sort(
    (a, b) => (b.projection?.edge.score ?? 0) - (a.projection?.edge.score ?? 0),
  );
  const inj = head.injury;
  const isOut = inj?.status === 'Out';
  const propCount = sorted.length;

  // The number of legs the user has already locked in for this player.
  const lockedCount = sorted.filter((l) => parlay.includes(cardKey(l))).length;

  // The strongest play to surface as a preview when collapsed.
  const top = sorted[0];
  const topProj = top?.projection;
  const topPct = topProj && !topProj.noProjection
    ? topProj.edge.lean.includes('Over')
      ? topProj.probability.over
      : topProj.edge.lean.includes('Under')
      ? topProj.probability.under
      : null
    : null;
  const topDir = topProj?.edge.lean.includes('Over') ? 'over'
    : topProj?.edge.lean.includes('Under') ? 'under' : 'flat';

  const isFav = favorites.isFavoritePlayer(head.playerId);

  return (
    <div className={`player-card ${isOut ? 'is-out' : ''} ${expanded ? 'expanded' : ''} ${isFav ? 'is-fav' : ''}`}>
      <div className="player-card-head-row">
        <button
          type="button"
          className={`player-fav-btn ${isFav ? 'active' : ''}`}
          onClick={(e) => { e.stopPropagation(); favorites.toggleFavoritePlayer(head.playerId); }}
          title={isFav ? `Unstar ${head.playerName}` : `Star ${head.playerName} — pin to your favorites`}
          aria-label={`Favorite ${head.playerName}`}
        >
          {isFav ? '★' : '☆'}
        </button>
        <button
          type="button"
          className="player-card-head player-card-head-button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
          <PlayerAvatar playerId={head.playerId} name={head.playerName} size="lg" />
          <div className="player-card-name-block">
            <div className="player-card-name">{head.playerName}</div>
            <div className="muted small">
              {head.team ?? '—'}
              {head.position && ` · ${head.position}`}
            </div>
          </div>
          {inj && <InjuryChip injury={inj} />}
          {lockedCount > 0 && (
            <span className="player-card-locked-pill" title={`${lockedCount} leg${lockedCount === 1 ? '' : 's'} from this player in your parlay`}>
              {lockedCount} in parlay
            </span>
          )}
          <span className="player-card-toggle">
            {expanded ? '▾' : '▸'}
          </span>
        </button>
      </div>

      {!expanded && top && topPct !== null && (
        <div className="player-card-preview">
          <span className="muted small">Top play:</span>
          <span className="player-card-preview-stat">{top.statLabel} {top.line}</span>
          <span
            className={`prop-row-pct ${topDir}`}
            title={pctTooltip({
              pct: topPct,
              dir: topDir as 'over' | 'under' | 'flat',
              isDD: top.statKey === 'double_double',
              isOverridden: false,
              statLabel: top.statLabel,
              line: top.line,
            })}
          >
            {topDir === 'over' ? '↑' : topDir === 'under' ? '↓' : '→'} {topPct}%
          </span>
          <span className="player-card-preview-more">
            +{propCount - 1} more
          </span>
        </div>
      )}

      {expanded && (
        <>
          <div className="prop-row-list">
            {sorted.map((l) => (
              <PropRow
                key={cardKey(l)}
                line={l}
                inParlay={parlay.includes(cardKey(l))}
                onToggleParlay={() => onToggleParlay(l)}
              />
            ))}
          </div>
          <div className="player-card-foot">
            <Link
              to={`/compare?m=last10&pid=${head.playerId}`}
              className="link"
              title="See player's last 10 games"
            >
              View last 10 →
            </Link>
            <button
              type="button"
              className="link"
              onClick={() => setExpanded(false)}
            >
              Collapse
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PropRow({
  line,
  inParlay,
  onToggleParlay,
}: {
  line: SlateResolvedLine;
  inParlay: boolean;
  onToggleParlay: () => void;
}) {
  // Local override for the line value. The published line comes from
  // the admin's prop sheet; the user can override it in the UI when
  // their sportsbook is showing a different number — we recompute
  // probability locally using the player's L10 sample.
  const [overrideLine, setOverrideLine] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(String(line.line));

  const isDD = line.statKey === 'double_double';
  const activeLine = overrideLine ?? line.line;
  const isOverridden = overrideLine !== null && overrideLine !== line.line;

  // If the user has set an override and we have last10Values, run the
  // frontend recompute. Otherwise fall back to the backend's pre-baked
  // projection. DD lines aren't recomputed (binary, not continuous).
  let pct: number;
  let dir: 'over' | 'under' | 'flat';
  let edgeLabel: string | null = null;
  let edgeScoreVal: number | null = null;

  if (isDD) {
    const ddPct = Math.round((line.ddRate ?? 0) * 100);
    pct = ddPct;
    dir = ddPct >= 50 ? 'over' : 'under';
  } else if (isOverridden && line.last10Values && line.last10Values.length > 0) {
    const hp = computeHitProbability(line.last10Values, activeLine);
    pct = hp.mightHitPct;
    dir = hp.lean === 'OVER' ? 'over' : 'under';
    edgeScoreVal = Math.abs(pct - 50) * 2;
    edgeLabel = pct >= 70 ? 'Strong' : pct >= 60 ? 'Slight' : 'Weak';
  } else {
    const p = line.projection;
    const lean = p?.edge.lean ?? '';
    pct = lean.includes('Over')
      ? p?.probability.over ?? 50
      : lean.includes('Under')
      ? p?.probability.under ?? 50
      : 50;
    dir = lean.includes('Over') ? 'over' : lean.includes('Under') ? 'under' : 'flat';
    edgeScoreVal = p?.edge.score ?? null;
    edgeLabel = p?.edge.label ?? null;
  }

  const tone = (edgeScoreVal ?? 0) >= 60 ? 'hot' : (edgeScoreVal ?? 0) >= 40 ? 'mid' : 'cool';

  // Direction restriction handling. PrizePicks Demons are over-only,
  // Goblins are under-only — if the model leans the opposite way,
  // the user can't actually bet the model's pick. Show why and
  // disable the + button so they don't add an unbettable leg.
  const restriction = line.direction === 'over' || line.direction === 'under'
    ? line.direction : null;
  const restrictionConflict = restriction !== null
    && !isDD
    && dir !== 'flat'
    && dir !== restriction;
  const canAdd = !restrictionConflict || inParlay;
  const restrictionLabel = restriction === 'over' ? 'OVER ONLY'
    : restriction === 'under' ? 'UNDER ONLY' : null;

  function commitEdit() {
    const v = parseFloat(editText);
    if (!Number.isFinite(v) || v <= 0) {
      setEditText(String(activeLine));
      setEditing(false);
      return;
    }
    setOverrideLine(v === line.line ? null : v);
    setEditing(false);
  }

  function resetLine() {
    setOverrideLine(null);
    setEditText(String(line.line));
  }

  return (
    <div className={`prop-row ${inParlay ? 'in-parlay' : ''} ${tone} ${isOverridden ? 'overridden' : ''} ${restrictionConflict ? 'restricted' : ''}`}>
      <button
        className={`prop-row-pin ${inParlay ? 'pinned' : ''}`}
        onClick={onToggleParlay}
        disabled={!canAdd}
        title={
          !canAdd
            ? `This is a ${restrictionLabel} prop and the model leans ${dir === 'over' ? 'OVER' : 'UNDER'} — that side isn't available to bet.`
            : inParlay ? 'Remove from parlay' : 'Add to parlay'
        }
        aria-label={inParlay ? 'Remove from parlay' : 'Add to parlay'}
      >
        {inParlay ? '✓' : '+'}
      </button>
      <span className="prop-row-stat">
        {line.statLabel}
        {restrictionLabel && (
          <span
            className={`prop-row-restriction ${restriction}`}
            title={
              restriction === 'over'
                ? 'PrizePicks Demon — only the OVER side is available (higher payout multiplier)'
                : 'PrizePicks Goblin — only the UNDER side is available (lower payout multiplier)'
            }
          >
            {restrictionLabel}
          </span>
        )}
      </span>
      {editing ? (
        <input
          type="number"
          step="0.5"
          inputMode="decimal"
          className="prop-row-line-edit"
          value={editText}
          autoFocus
          onChange={(e) => setEditText(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') {
              setEditText(String(activeLine));
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={`prop-row-line ${isOverridden ? 'overridden' : ''}`}
          onClick={() => { setEditText(String(activeLine)); setEditing(true); }}
          title="Click to override the line — we'll recompute probability against the player's last 10"
        >
          {activeLine}
          {isOverridden && <span className="prop-row-line-mark" aria-hidden>•</span>}
        </button>
      )}
      <span
        className={`prop-row-pct ${dir}`}
        title={pctTooltip({ pct, dir, isDD, isOverridden, statLabel: line.statLabel, line: activeLine })}
      >
        {dir === 'over' ? '↑' : dir === 'under' ? '↓' : '→'} {pct}%
      </span>
      {edgeScoreVal !== null && (
        <span
          className="prop-row-edge"
          title={edgeTooltip(edgeScoreVal, edgeLabel)}
        >
          edge {Math.round(edgeScoreVal)}
        </span>
      )}
      <PropRowLivePill
        playerId={line.playerId}
        statKey={line.statKey}
        line={line.line}
        leanDirection={dir === 'under' ? 'UNDER' : 'OVER'}
      />
      {isOverridden && (
        <button
          type="button"
          className="prop-row-reset"
          onClick={resetLine}
          title={`Reset to published line (${line.line})`}
          aria-label="Reset line to published value"
        >
          ↺
        </button>
      )}
    </div>
  );
}

// Star button for an NBA combo card leg in the BestPicksRail. Same
// /starred watchlist as the LineCard star and the Best Bets row star.
function NbaComboLegStar({ leg }: { leg: SlateComboLeg }) {
  const { isStarred, toggle } = useStarredProps();
  const id = `nba-${leg.playerId}-${leg.statKey}-${leg.line}-${leg.direction}`;
  const starred = isStarred(id);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle({
          sport: 'nba',
          playerId: leg.playerId,
          playerName: leg.playerName,
          team: leg.team,
          statKey: leg.statKey,
          statLabel: leg.statLabel,
          line: leg.line,
          direction: leg.direction,
          snapshot: {
            probability: leg.probability,
            edgePercent: leg.edgePercent ?? 0,
            projection: leg.projection ?? null,
          },
        });
      }}
      title={starred ? 'Unstar — removes from /starred' : 'Star — track on /starred'}
      aria-label={starred ? 'Unstar' : 'Star'}
      style={{
        marginLeft: 'auto',
        background: 'transparent',
        border: 'none',
        color: starred ? '#ffd54f' : 'rgba(255,255,255,0.30)',
        fontSize: 14, fontWeight: 800,
        cursor: 'pointer',
        padding: '0 4px',
        lineHeight: 1,
        transition: 'color var(--motion-fast)',
      }}
    >
      {starred ? '★' : '☆'}
    </button>
  );
}

// Star button for the LineCard — toggles add/remove from /starred
// watchlist. Persists via useStarredProps localStorage hook. Sits next
// to the parlay-pin in the top-right corner of the card.
function LineCardStar({ line }: { line: SlateResolvedLine }) {
  const { isStarred, toggle } = useStarredProps();
  const lean = (line.projection?.edge.lean ?? '').toLowerCase().includes('under') ? 'UNDER' : 'OVER';
  const id = `nba-${line.playerId}-${line.statKey}-${line.line}-${lean}`;
  const starred = isStarred(id);
  const prob = lean === 'OVER'
    ? (line.projection?.probability.over ?? line.hitProbability?.hitOver ?? 50)
    : (line.projection?.probability.under ?? line.hitProbability?.hitUnder ?? 50);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle({
          sport: 'nba',
          playerId: line.playerId,
          playerName: line.playerName,
          team: line.team,
          statKey: line.statKey,
          statLabel: line.statLabel,
          line: line.line,
          direction: lean,
          snapshot: {
            probability: prob,
            edgePercent: line.projection?.edge.score ?? 0,
            projection: line.projection?.projection.final ?? null,
          },
        });
      }}
      title={starred ? 'Unstar — removes from /starred' : 'Star — track on /starred'}
      aria-label={starred ? 'Unstar' : 'Star'}
      className="slate-star"
      style={{
        position: 'absolute',
        top: 8,
        right: 44,
        width: 28, height: 28,
        borderRadius: '50%',
        border: '1px solid var(--border-default)',
        background: starred ? 'rgba(255,213,79,0.16)' : 'var(--surface-0)',
        color: starred ? '#ffd54f' : 'rgba(255,255,255,0.45)',
        fontSize: 14, fontWeight: 800,
        cursor: 'pointer',
        zIndex: 2,
        transition: 'color var(--motion-fast), background var(--motion-fast), border-color var(--motion-fast)',
      }}
    >
      {starred ? '★' : '☆'}
    </button>
  );
}

// Live-state pill wrapper for PropRow. Calls the slate-live-state
// hook (context-backed) and only renders when the state is non-null
// AND has progressed beyond PENDING. Keeps PropRow clean.
function PropRowLivePill({
  playerId, statKey, line, leanDirection,
}: {
  playerId: number;
  statKey: string;
  line: number;
  leanDirection: 'OVER' | 'UNDER';
}) {
  const state = useLiveLegState(playerId, statKey, line, leanDirection);
  return <LiveVerdictPill state={state} compact />;
}

// Same wrapper for the larger LineCard variant — sits inside the card
// body and shows the same verdict pill (non-compact) once the prop
// has progressed beyond PENDING.
function LineCardLivePill({
  playerId, statKey, line, leanDirection,
}: {
  playerId: number;
  statKey: string;
  line: number;
  leanDirection: 'OVER' | 'UNDER';
}) {
  const state = useLiveLegState(playerId, statKey, line, leanDirection);
  if (!state) return null;
  return (
    <div style={{ padding: '8px 12px 0', display: 'flex', justifyContent: 'flex-start' }}>
      <LiveVerdictPill state={state} />
    </div>
  );
}

// Quick stats above the slate grid — totals, strong leans, OUT count,
// and the highest edge score across the board. Just orientation, no
// interactivity.
function SlateSummary({ lines }: { lines: SlateResolvedLine[] }) {
  const total = lines.length;
  const strongOver = lines.filter((l) =>
    (l.hitProbability?.mightHitPct ?? 0) >= 75 && l.hitProbability?.lean === 'OVER').length;
  const strongUnder = lines.filter((l) =>
    (l.hitProbability?.mightHitPct ?? 0) >= 75 && l.hitProbability?.lean === 'UNDER').length;
  const outCount = lines.filter((l) => l.injury?.status === 'Out').length;
  const bestEdge = lines.reduce(
    (max, l) => Math.max(max, edgeScore(l)),
    0,
  );

  return (
    <div className="slate-summary">
      <div className="slate-summary-cell">
        <div className="slate-summary-v">{total}</div>
        <div className="slate-summary-k">props</div>
      </div>
      <div className="slate-summary-cell pos">
        <div className="slate-summary-v">{strongOver}</div>
        <div className="slate-summary-k">strong over</div>
      </div>
      <div className="slate-summary-cell neg">
        <div className="slate-summary-v">{strongUnder}</div>
        <div className="slate-summary-k">strong under</div>
      </div>
      {outCount > 0 && (
        <div className="slate-summary-cell out">
          <div className="slate-summary-v">{outCount}</div>
          <div className="slate-summary-k">OUT</div>
        </div>
      )}
      <div className="slate-summary-cell edge">
        <div className="slate-summary-v">⚡ {bestEdge}</div>
        <div className="slate-summary-k">best edge</div>
      </div>
    </div>
  );
}

// Auto-curated starter parlay: top 3 best-edge legs from the current
// slate, OUT players removed. Shown only when the user has no legs
// selected — disappears the moment they pin or add anything. Click
// 'Try this slip' to pin all three legs at once.
function SuggestedParlay({
  lines,
  onAccept,
}: {
  lines: SlateResolvedLine[];
  onAccept: (legs: string[]) => void;
}) {
  const top3 = lines
    .filter((l) => l.injury?.status !== 'Out')
    .map((l) => ({ line: l, edge: edgeScore(l) }))
    .filter((r) => r.edge >= 65)
    .sort((a, b) => b.edge - a.edge)
    .slice(0, 3)
    .map((r) => r.line);

  // Live verdict polling — keyed on the suggested legs so the chip
  // updates without a full slate refresh while games are in progress.
  const [liveByKey, setLiveByKey] = useState<Map<string, EliteLegLiveState>>(new Map());
  const legsKey = top3.map((l) => `${l.playerId}-${l.statKey}-${l.line}`).join('|');
  useEffect(() => {
    if (top3.length === 0) { setLiveByKey(new Map()); return; }
    let cancelled = false;
    const tick = () => {
      const payload = top3.map((l) => ({
        playerId: l.playerId,
        playerName: l.playerName,
        statKey: l.statKey,
        // Suggested parlay always leans the model's preferred direction.
        direction: (l.hitProbability?.lean === 'UNDER' ? 'UNDER' : 'OVER') as 'OVER' | 'UNDER',
        line: l.line,
      }));
      liveGradeLegs(payload)
        .then((legs) => {
          if (cancelled) return;
          const m = new Map<string, EliteLegLiveState>();
          for (let i = 0; i < legs.length; i++) {
            const t = top3[i]!;
            m.set(`${t.playerId}-${t.statKey}-${t.line}`, legs[i]!);
          }
          setLiveByKey(m);
        })
        .catch(() => { /* silent — chip stays static */ });
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [legsKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (top3.length < 3) return null;

  // Combined hit % assuming independence (matches the tray's math).
  const combined = Math.round(
    top3.reduce((p, l) => p * ((l.hitProbability?.mightHitPct ?? 50) / 100), 1) * 100,
  );

  const legs = top3.map((l) => `${l.playerId}-${l.statKey}-${l.line}`);

  // Roll up the live state into a quick chip.
  let liveHit = 0, liveMiss = 0, liveInFlight = 0;
  for (const s of liveByKey.values()) {
    if (s.verdict === 'HIT' || s.verdict === 'ON_PACE_HIT') liveHit++;
    else if (s.verdict === 'MISS' || s.verdict === 'ON_PACE_MISS' || s.verdict === 'PUSH') liveMiss++;
    else if (s.verdict === 'IN_FLIGHT') liveInFlight++;
  }
  const showLive = (liveHit + liveMiss + liveInFlight) > 0;

  return (
    <div className="suggested-parlay">
      <div className="suggested-parlay-head">
        <strong>Suggested 3-leg parlay</strong>
        <span className="muted small">
          combined ≈ {combined}% · pays {PRIZEPICKS_PAYOUTS[3]}× on PrizePicks
        </span>
        {showLive && (
          <span style={{
            marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>
            <span className="live-pulse" style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: 3,
              background: liveMiss > 0 ? '#ef5350' : liveInFlight > 0 ? '#ffd54f' : '#66bb6a',
            }} />
            {liveHit > 0 && <span style={{ color: '#66bb6a' }}>{liveHit} hit</span>}
            {liveInFlight > 0 && <span style={{ color: '#ffd54f' }}>{liveInFlight} live</span>}
            {liveMiss > 0 && <span style={{ color: '#ef5350' }}>{liveMiss} miss</span>}
          </span>
        )}
      </div>
      <div className="suggested-parlay-legs">
        {top3.map((l) => {
          const liveKey = `${l.playerId}-${l.statKey}-${l.line}`;
          const live = liveByKey.get(liveKey) ?? null;
          let liveLabel: string | null = null;
          let liveColor = 'inherit';
          if (live) {
            const v = live.verdict;
            if (v === 'HIT' || v === 'ON_PACE_HIT') { liveLabel = '✓'; liveColor = '#66bb6a'; }
            else if (v === 'MISS' || v === 'ON_PACE_MISS') { liveLabel = '✗'; liveColor = '#ef5350'; }
            else if (v === 'PUSH') { liveLabel = '—'; liveColor = '#ffd54f'; }
            else if (v === 'IN_FLIGHT' && live.currentValue !== null) { liveLabel = String(live.currentValue); liveColor = '#ffd54f'; }
          }
          return (
            <span key={liveKey} className="suggested-parlay-leg">
              <strong>{l.playerName}</strong> {l.statLabel} {l.line}{' '}
              <span className="muted">{l.hitProbability?.lean === 'OVER' ? '↑' : '↓'}</span>
              {liveLabel && (
                <span style={{ marginLeft: 6, color: liveColor, fontWeight: 800, fontSize: 11 }}>
                  · {liveLabel}
                </span>
              )}
            </span>
          );
        })}
      </div>
      <button className="cta primary" onClick={() => onAccept(legs)}>
        Try this slip →
      </button>
    </div>
  );
}

function SavedParlaysSection({
  parlays,
  onOpen,
  onRemove,
  lines,
}: {
  parlays: SavedParlay[];
  onOpen: (p: SavedParlay) => void;
  onRemove: (id: string) => void;
  lines: SlateResolvedLine[];
}) {
  return (
    <div className="saved-parlays">
      <h3>Your saved parlays</h3>
      <ul className="saved-parlays-list">
        {parlays.map((p) => (
          <li key={p.id}>
            <button className="saved-parlay-open" onClick={() => onOpen(p)}>
              <span className="saved-parlay-name">{p.name}</span>
              <span className="saved-parlay-meta">
                {p.legs.length} {p.legs.length === 1 ? 'leg' : 'legs'} ·
                {' '}{new Date(p.savedAt).toLocaleDateString()}
              </span>
              <SavedParlayLiveRollup parlay={p} lines={lines} />
            </button>
            <button
              className="link saved-parlay-remove"
              onClick={() => onRemove(p.id)}
              title="Remove"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Live rollup chip for a saved parlay. Resolves each leg id through
// the current slate's resolved-lines (to recover lean direction since
// saved parlays persist only `playerId-statKey-line`), reads each
// leg's live state from the SlateLiveStateProvider context, and
// renders a compact "1H · 1L · 0M" chip beside the parlay name.
// Self-hides when no leg has progressed.
function SavedParlayLiveRollup({
  parlay,
  lines,
}: {
  parlay: SavedParlay;
  lines: SlateResolvedLine[];
}) {
  // Decode each leg-id "playerId-statKey-line" by scanning from both
  // ends so multi-token statKeys (e.g. `three_pt_made`) parse
  // correctly. statKey contains hyphens? No — statKeys are snake_case.
  // The id format is unambiguous: first segment = playerId (numeric),
  // last segment = line (numeric), middle = statKey.
  const resolved = parlay.legs.map((id) => {
    const firstDash = id.indexOf('-');
    const lastDash = id.lastIndexOf('-');
    if (firstDash < 0 || lastDash <= firstDash) {
      return null;
    }
    const playerId = Number(id.slice(0, firstDash));
    const statKey = id.slice(firstDash + 1, lastDash);
    const lineNum = Number(id.slice(lastDash + 1));
    if (!Number.isFinite(playerId) || !Number.isFinite(lineNum)) return null;
    const slateLine = lines.find(
      (l) => l.playerId === playerId && l.statKey === statKey && l.line === lineNum,
    );
    const dir = (slateLine?.hitProbability?.lean === 'UNDER' ? 'UNDER' : 'OVER') as 'OVER' | 'UNDER';
    return { playerId, statKey, line: lineNum, dir };
  });
  return <SavedParlayLiveTally resolved={resolved.filter((r): r is NonNullable<typeof r> => r !== null)} />;
}

// Internal — read each leg's live state via the slate context and
// render a compact rollup chip. Calls the hook in a loop, which is
// safe here because parlay.legs is a stable-length array per render.
function SavedParlayLiveTally({
  resolved,
}: {
  resolved: Array<{ playerId: number; statKey: string; line: number; dir: 'OVER' | 'UNDER' }>;
}) {
  const legStates: Array<ReturnType<typeof useLiveLegState>> = [];
  for (const r of resolved) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const st = useLiveLegState(r.playerId, r.statKey, r.line, r.dir);
    legStates.push(st);
  }
  let hit = 0, miss = 0, live = 0;
  for (const s of legStates) {
    if (!s) continue;
    const v = s.verdict;
    if (v === 'HIT' || v === 'ON_PACE_HIT') hit++;
    else if (v === 'MISS' || v === 'ON_PACE_MISS' || v === 'PUSH') miss++;
    else if (v === 'IN_FLIGHT') live++;
  }
  if (hit + miss + live === 0) return null;
  const dotColor = miss > 0 ? '#ef5350' : live > 0 ? '#ffd54f' : '#66bb6a';
  return (
    <span style={{
      marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 10, fontWeight: 800, letterSpacing: '0.04em',
    }}>
      <span className="live-pulse" style={{
        display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: dotColor,
      }} />
      {hit > 0 && <span style={{ color: '#66bb6a' }}>{hit}H</span>}
      {live > 0 && <span style={{ color: '#ffd54f' }}>{live}L</span>}
      {miss > 0 && <span style={{ color: '#ef5350' }}>{miss}M</span>}
    </span>
  );
}

function VsOppRow({
  opp,
  line,
  isDD,
}: {
  opp: { opponentAbbr: string; gamesPlayed: number; avg: number };
  line: number;
  isDD: boolean;
}) {
  // Color-code the matchup signal: green if historically the player
  // was ABOVE the prop line vs this opponent, red if below, gray if
  // sample is too small to lean on.
  const lean = opp.avg > line ? 'over' : opp.avg < line ? 'under' : 'even';
  const cls =
    opp.gamesPlayed < 2
      ? 'slate-vs-opp small'
      : lean === 'over'
      ? 'slate-vs-opp pos'
      : lean === 'under'
      ? 'slate-vs-opp neg'
      : 'slate-vs-opp';

  if (isDD) {
    return (
      <div className={cls}>
        vs <strong>{opp.opponentAbbr}</strong>:{' '}
        {Math.round(opp.avg * 100)}% DD rate · {opp.gamesPlayed} game{opp.gamesPlayed === 1 ? '' : 's'}
      </div>
    );
  }
  return (
    <div className={cls}>
      vs <strong>{opp.opponentAbbr}</strong>:{' '}
      <strong>{opp.avg.toFixed(1)}</strong>
      {' avg · '}
      {opp.gamesPlayed} game{opp.gamesPlayed === 1 ? '' : 's'}
    </div>
  );
}

function TrendChip({
  trend,
  l10Avg,
}: {
  trend: { last5Avg: number; deltaVsL10: number };
  l10Avg: number;
}) {
  // Don't render directional chip for noise — require the L5 to differ
  // from L10 by at least 10% of the L10 magnitude (or 0.5 raw units for
  // small-counter stats like DD rate or stocks).
  const threshold = Math.max(0.5, Math.abs(l10Avg) * 0.1);
  const dir = trend.deltaVsL10 > threshold ? 'up'
    : trend.deltaVsL10 < -threshold ? 'down'
    : 'flat';
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  const cls = dir === 'up' ? 'slate-trend hot'
    : dir === 'down' ? 'slate-trend cold'
    : 'slate-trend flat';
  const label = dir === 'up' ? 'hot' : dir === 'down' ? 'cold' : 'steady';
  return (
    <div className={cls}>
      L5 <strong>{trend.last5Avg.toFixed(1)}</strong> {arrow} {label}
    </div>
  );
}

// Volatility archetype chip — surfaces "Boom/Bust", "Stable Producer",
// etc next to the projection so users can read the variance profile
// at a glance. Backend classifies based on stat CV, minutes CV, and
// boom/bust tail rates over the player's last 20 games.
// Strategy mode selector — five buttons covering the user-risk
// spectrum (spec §"REQUIRED USER RISK MODES"). Each button shows
// a label, a one-line hint, and a "risk meter" (filled segments
// out of 5 conveying variance/aggression). The active mode highlights;
// Auto mode also surfaces the underlying mode the resolver picked
// ("Auto · using Aggressive tonight"). Persists to localStorage so
// the user's choice survives reloads.
function SlateModeSelector({
  mode,
  onChange,
  resolvedMode,
}: {
  mode: SlateMode;
  onChange: (m: SlateMode) => void;
  // What the auto resolver actually picked. Only set when mode='auto'.
  resolvedMode?: 'safe' | 'balanced' | 'aggressive' | 'insane';
}) {
  // Risk-meter fill (out of 5) per mode — visual variance/aggression
  // indicator from the spec. `recommended` flags the model's tested
  // default so first-time users see which mode to start with.
  const opts: Array<{
    id: SlateMode;
    label: string;
    hint: string;
    meter: number;
    recommended?: boolean;
  }> = [
    { id: 'safe',       label: 'Safe',       hint: 'Higher hit rate · lowest variance · 2-4 leg cards', meter: 1 },
    { id: 'balanced',   label: 'Balanced',   hint: 'Best risk-adjusted EV across all card sizes',       meter: 2, recommended: true },
    { id: 'aggressive', label: 'Aggressive', hint: 'Edge-hunting · projection gaps · 3-6 leg cards',     meter: 4 },
    { id: 'insane',     label: 'Insane',     hint: 'Market-disagreement lottery · ~160× ceiling on 6 Demons',   meter: 5 },
    { id: 'auto',       label: 'Auto',       hint: 'Adapts to slate quality · picks the right mode',     meter: 3 },
  ];
  const showAutoBadge = mode === 'auto' && resolvedMode !== undefined;
  return (
    <div className="slate-mode-section">
      <div className="slate-mode-selector" role="tablist" aria-label="Slate strategy">
        {opts.map((o) => (
          <button
            key={o.id}
            role="tab"
            aria-selected={mode === o.id}
            className={`slate-mode-btn ${mode === o.id ? 'active' : ''} ${o.recommended ? 'recommended' : ''} mode-${o.id}`}
            onClick={() => onChange(o.id)}
            title={o.hint}
          >
            {o.recommended && (
              <span className="slate-mode-recommended-badge" aria-label="Recommended">
                Recommended
              </span>
            )}
            <span className="slate-mode-label">{o.label}</span>
            <span className="slate-mode-hint">{o.hint}</span>
            <span className="slate-mode-meter" aria-hidden>
              {Array.from({ length: 5 }, (_, i) => (
                <span key={i} className={`mode-meter-bar ${i < o.meter ? 'filled' : ''}`} />
              ))}
            </span>
          </button>
        ))}
      </div>
      {showAutoBadge && (
        <div className="slate-mode-auto-badge">
          <strong>Auto</strong> · tonight's slate resolves to{' '}
          <strong>{resolvedMode}</strong> · the system picks the right mode based on edge concentration.
        </div>
      )}
      {mode === 'insane' && (
        <div className="slate-mode-insane-warn">
          🎟 Market-disagreement lottery. Insane only surfaces Demon
          legs where our model says <strong>might hit</strong> AND the
          de-vigged sportsbook market disagrees by{' '}
          <strong>≥12pp</strong>. That gap is the lottery edge — the
          payout exists because the book thinks it won't hit. Real
          PrizePicks Power Play ceiling with 6 Demons stacked is{' '}
          <strong>~160×</strong> (verified user lineup, May 2026). When
          the slate has no Demon legs that clear the disagreement bar,
          Insane shows nothing rather than fabricating a lottery out
          of consensus picks.
        </div>
      )}
    </div>
  );
}

function ArchetypeChip({
  archetype,
}: {
  archetype: NonNullable<SlateResolvedLine['archetype']>;
}) {
  const a = archetype.archetype;
  // Tone: green for stable, neutral for moderate, warning for high
  // variance / boom-bust, blue for minutes-sensitive (different cause).
  const tone =
    a === 'Stable Producer' ? 'hot'
    : a === 'Boom/Bust' ? 'cold'
    : a === 'High Variance' ? 'warn'
    : a === 'Minutes Sensitive' ? 'info'
    : 'flat';
  return (
    <div className={`slate-archetype tone-${tone}`} title={archetype.reason}>
      {a}
    </div>
  );
}

// Lean + edge-score badge from the layered projection engine. Sits at
// the bottom of the card front so the user sees the model's verdict at
// a glance without expanding details. Tone matches confidence/risk.
function ProjectionLeanBadge({ projection }: { projection: SlateProjection }) {
  const lean = projection.edge.lean;
  const tone =
    lean.startsWith('Strong')
      ? 'hot'
      : lean.startsWith('Slight')
      ? 'mid'
      : 'flat';
  return (
    <div className={`slate-lean-badge ${tone}`} title={`Edge ${projection.edge.score} · Confidence ${projection.confidence.score} · Risk ${projection.risk.score}`}>
      <strong>{lean}</strong>
      <span className="muted small">
        edge {projection.edge.score} · conf {projection.confidence.score} · risk {projection.risk.score}
      </span>
    </div>
  );
}

// Expandable details panel — shows the projection range, the factor
// breakdown the user would expect from a "professional model", and the
// human-readable model notes. Collapsed by default to keep cards small.
function ProjectionPanel({ projection }: { projection: SlateProjection }) {
  const [open, setOpen] = useState(false);
  const p = projection.projection;
  const fb = projection.factorBreakdown;
  const hr = projection.historicalHitRates;
  const overUnderTone =
    projection.probability.over >= 60
      ? 'hot'
      : projection.probability.under >= 60
      ? 'cold'
      : 'flat';

  return (
    <div className="slate-projection">
      <button
        className="slate-projection-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Projection details · {p.final.toFixed(1)} ({p.rangeLow.toFixed(1)}–{p.rangeHigh.toFixed(1)})
      </button>
      {open && (
        <div className="slate-projection-body">
          <div className="slate-projection-grid">
            <div className={`slate-projection-cell ${overUnderTone}`}>
              <span className="muted small">Over</span>
              <strong>{projection.probability.over}%</strong>
            </div>
            <div className="slate-projection-cell">
              <span className="muted small">Under</span>
              <strong>{projection.probability.under}%</strong>
            </div>
            <div className="slate-projection-cell">
              <span className="muted small">Confidence</span>
              <strong>{projection.confidence.label}</strong>
              <span className="muted small">{projection.confidence.score}</span>
            </div>
            <div className="slate-projection-cell">
              <span className="muted small">Risk</span>
              <strong>{projection.risk.label}</strong>
              <span className="muted small">{projection.risk.score}</span>
            </div>
            <div className="slate-projection-cell" title="L5 Fragility — how little must go wrong for this leg to fail. Separate from probability + risk. Stat rarity + margin thinness + sample weakness + volatility + minutes uncertainty.">
              <span className="muted small">Fragility</span>
              <strong>{projection.fragility.tier}</strong>
              <span className="muted small">{projection.fragility.score.toFixed(0)}</span>
            </div>
            <div className="slate-projection-cell" title="L2 Momentum Expansion — direction-aware composite of recent production lift, season trend, projection separation, and L10 hit rate. 50 = neutral, ≥65 = real momentum, ≤35 = anti-momentum.">
              <span className="muted small">Momentum</span>
              <strong>
                {projection.momentumExpansionScore >= 75 ? 'Strong'
                  : projection.momentumExpansionScore >= 60 ? 'Expanding'
                  : projection.momentumExpansionScore >= 40 ? 'Neutral'
                  : projection.momentumExpansionScore >= 25 ? 'Cooling'
                  : 'Fading'}
              </strong>
              <span className="muted small">{projection.momentumExpansionScore.toFixed(0)}</span>
            </div>
          </div>

          <div className="slate-projection-factors">
            <div className="slate-projection-factor-row">
              <span>Baseline → Adjusted</span>
              <span><strong>{p.baseline.toFixed(1)}</strong> → <strong>{p.contextAdjusted.toFixed(1)}</strong></span>
            </div>
            <div className="slate-projection-factor-row">
              <span>Std dev (blended)</span>
              <span>{fb.blendedStdDev.toFixed(2)}</span>
            </div>
            <div className="slate-projection-factor-row">
              <span>Model agreement</span>
              <span>{fb.modelAgreementScore}%</span>
            </div>

            <FactorMultiplier label="Minutes" value={fb.minutesMultiplier} />
            <FactorMultiplier label="Usage" value={fb.usageMultiplier} />
            <FactorMultiplier label="Injury" value={fb.injuryMultiplier} />
            <FactorMultiplier label="Opp defense" value={fb.opponentDefenseMultiplier} />
            <FactorMultiplier label="Pace" value={fb.paceMultiplier} />
            <FactorMultiplier label="Rest" value={fb.restMultiplier} />
            <FactorMultiplier label="Game importance" value={fb.gameImportanceMultiplier} />
            <FactorMultiplier label="Blowout" value={fb.blowoutMultiplier} />

            <div className="slate-projection-factor-row" style={{ marginTop: 6 }}>
              <span className="muted small">Hit rates</span>
              <span className="muted small">
                S {hr.season ?? '—'}% · L10 {hr.last10 ?? '—'}% · L5 {hr.last5 ?? '—'}%
                {hr.vsOpponent != null && ` · vs-opp ${hr.vsOpponent}%`}
              </span>
            </div>
          </div>

          {projection.modelNotes.length > 0 && (
            <ul className="slate-projection-notes">
              {projection.modelNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <div className="muted small slate-projection-disclaimer">
            {projection.disclaimer}
          </div>
        </div>
      )}
    </div>
  );
}

// Single multiplier row. Tinted green/red when the multiplier is
// meaningfully above/below 1.0 so the eye picks up which factors are
// driving the adjustment.
function FactorMultiplier({ label, value }: { label: string; value: number }) {
  const tone =
    value >= 1.03 ? 'hot' : value <= 0.97 ? 'cold' : 'flat';
  return (
    <div className={`slate-projection-factor-row ${tone}`}>
      <span>{label}</span>
      <span>×{value.toFixed(2)}</span>
    </div>
  );
}

function InjuryChip({ injury }: { injury: { status: string; type?: string } }) {
  const s = injury.status.toLowerCase();
  const cls = s.includes('out')
    ? 'slate-injury out'
    : s.startsWith('day')
    ? 'slate-injury d2d'
    : s.includes('quest') || s.includes('doubt')
    ? 'slate-injury q'
    : 'slate-injury';
  const label = injury.status.toUpperCase();
  return (
    <div className={cls} title={injury.type ?? injury.status}>
      {label}
    </div>
  );
}

// Sticky tray at the bottom of /slate. Combined probability assumes
// independence between legs — that's a real assumption since one
// player's points and another's rebounds are roughly uncorrelated, but
// it isn't a guarantee. The "≈" in the label is the visual disclaimer.
function ParlayTray({
  legs,
  onRemove,
  onClear,
  onSave,
  canSave,
  canAnalyze,
}: {
  legs: SlateResolvedLine[];
  onRemove: (line: SlateResolvedLine) => void;
  onClear: () => void;
  onSave: (name: string) => void;
  canSave: boolean;
  canAnalyze: boolean;
}) {
  const probs = legs.map((l) => (l.hitProbability?.mightHitPct ?? 50) / 100);
  const combined = probs.reduce((p, q) => p * q, 1);
  const combinedPct = Math.round(combined * 100);
  const tooFew = legs.length < 2;
  const ppPayout = PRIZEPICKS_PAYOUTS[legs.length];

  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saved, setSaved] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analysisErr, setAnalysisErr] = useState<string | null>(null);

  async function runAnalyze() {
    setAnalyzing(true);
    setAnalysisErr(null);
    try {
      const r = await analyzeSlateLegs(legs);
      setAnalysis(r.summary);
    } catch (err) {
      setAnalysisErr((err as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  function startSave() { setSaving(true); }
  function commitSave() {
    onSave(saveName);
    setSaving(false);
    setSaveName('');
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function copyLink() {
    const url = window.location.href;
    try { await navigator.clipboard.writeText(url); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* nothing else */ }
      finally { ta.remove(); }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="parlay-tray">
      <div className="parlay-tray-inner">
        <div className="parlay-summary">
          <div className="parlay-count">
            <strong>{legs.length}</strong>
            <span> {legs.length === 1 ? 'leg' : 'legs'}</span>
          </div>
          <div className="parlay-prob">
            <span className="parlay-prob-pct">≈ {combinedPct}%</span>
            <span className="parlay-prob-label">
              {tooFew
                ? 'add 1+ more for a parlay'
                : 'combined hit (assumes independence)'}
            </span>
          </div>
          {ppPayout != null && !tooFew && (
            <div className="parlay-payout">
              PP {legs.length}-pick: <strong>{ppPayout}×</strong>
            </div>
          )}
          <button
            className={copied ? 'parlay-copy copied' : 'parlay-copy'}
            onClick={copyLink}
          >
            {copied ? 'Link copied ✓' : 'Copy link'}
          </button>
          {canSave ? (
            saving ? (
              <div className="parlay-save-row">
                <input
                  className="parlay-save-input"
                  autoFocus
                  placeholder="Slip name…"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitSave();
                    if (e.key === 'Escape') setSaving(false);
                  }}
                />
                <button className="parlay-copy" onClick={commitSave}>Save</button>
              </div>
            ) : (
              <button
                className={saved ? 'parlay-copy copied' : 'parlay-copy'}
                onClick={startSave}
                disabled={legs.length === 0}
              >
                {saved ? 'Saved ✓' : 'Save parlay'}
              </button>
            )
          ) : (
            <button className="parlay-copy locked" disabled title="Saving parlays is a Pro feature">
              Save parlay <span className="lock-pill small">PRO</span>
            </button>
          )}
          {canAnalyze ? (
            <button
              className="parlay-copy"
              onClick={runAnalyze}
              disabled={analyzing || legs.length === 0}
            >
              {analyzing ? 'Analyzing…' : 'Analyze slip'}
            </button>
          ) : (
            <button className="parlay-copy locked" disabled title="AI analysis is a Pro feature">
              Analyze slip <span className="lock-pill small">PRO</span>
            </button>
          )}
          <button className="link" onClick={onClear}>Clear</button>
        </div>
        {(analysis || analysisErr) && (
          <div className="parlay-analysis">
            {analysisErr && <p className="error small">{analysisErr}</p>}
            {analysis && <p>{analysis}</p>}
          </div>
        )}
        <div className="parlay-legs">
          {legs.map((l) => {
            const lean = l.hitProbability?.lean ?? 'OVER';
            const pct = l.hitProbability?.mightHitPct ?? 0;
            return (
              <ParlayTrayLeg
                key={`${l.playerId}-${l.statKey}-${l.line}`}
                line={l}
                lean={lean}
                pct={pct}
                onRemove={() => onRemove(l)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Single parlay-tray leg button. Reads its own live state from the
// SlateLiveStateProvider context so users see verdict pills tick on
// the legs they've actively added to a slip.
function ParlayTrayLeg({
  line, lean, pct, onRemove,
}: {
  line: SlateResolvedLine;
  lean: 'OVER' | 'UNDER';
  pct: number;
  onRemove: () => void;
}) {
  const live = useLiveLegState(line.playerId, line.statKey, line.line, lean);
  return (
    <button
      className="parlay-leg"
      onClick={onRemove}
      title="Remove from parlay"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}
    >
      <span className="parlay-leg-name">{line.playerName}</span>
      <span className="parlay-leg-stat">
        {line.statLabel} {line.line} {lean === 'OVER' ? '↑' : '↓'}
      </span>
      <span className="parlay-leg-pct">{pct}%</span>
      <LiveVerdictPill state={live} compact />
      <span className="parlay-leg-x" aria-hidden>✕</span>
    </button>
  );
}

// Reference PrizePicks payout multipliers. Verified against May 2026
// in-app screenshots — these are the n-of-n hit payouts (the standard
// payout a user pocketing every leg actually receives), NOT the
// contest 1st-place leaderboard "minimum guarantee" prize. Pre-iter-10
// the 6-leg value was 35, descending from a misread of the 1st-place
// 37.5× number; real 6/6 payout is 14×.
const PRIZEPICKS_PAYOUTS: Record<number, number | undefined> = {
  2: 3,
  3: 5,
  4: 10,
  5: 20,
  6: 14,            // VERIFIED May 2026: "6 correct pays 14X" on Power Play
};


function UnresolvedSection({ unresolved }: { unresolved: SlateUnresolvedLine[] }) {
  return (
    <div className="slate-unresolved">
      <h3>Couldn't match {unresolved.length} {unresolved.length === 1 ? 'line' : 'lines'}</h3>
      <p className="muted small">
        These lines didn't map cleanly to a player or to a supported stat. Most
        often it's a player traded mid-season or a prop type our cache doesn't
        track (e.g. fantasy score, "first 3 minutes" props).
      </p>
      <ul className="slate-unresolved-list">
        {unresolved.map((u, i) => (
          <li key={i}>
            <span className="slate-unresolved-text">{u.rawText}</span>
            <span className="slate-unresolved-stat">
              {u.rawStatLabel} {u.line}
            </span>
            <span className="slate-unresolved-reason">
              {u.reason === 'no_player_match' && 'no player match'}
              {u.reason === 'unknown_stat' && 'unsupported stat'}
              {u.reason === 'no_recent_games' && 'no recent games cached'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Drop zone (drag-and-drop + tap-to-pick) ---

function DropZone({ onFile, disabled }: { onFile: (f: File) => void; disabled: boolean }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className={over ? 'slate-drop over' : 'slate-drop'}
      onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && f.type.startsWith('image/')) onFile(f);
      }}
      onClick={() => !disabled && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          // Reset so the same file can be re-selected.
          e.target.value = '';
        }}
        disabled={disabled}
      />
      <span className="slate-drop-icon">📋</span>
      <span className="slate-drop-text">
        <strong>Drop a screenshot</strong> or click to upload
      </span>
      <span className="muted small">
        PNG / JPG / WebP — image is OCR'd in memory and immediately discarded.
      </span>
    </div>
  );
}

// Compact relative-time formatter for the slate-freshness chip. Drops
// to "just now" under a minute, "Nm" / "Nh" / "Nd" beyond. Tooltip
// on the consuming element shows the absolute timestamp for users
// who want the exact moment.
function nbaSlateTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
