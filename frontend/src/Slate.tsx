import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  analyzeSlateLegs,
  getDataFreshness,
  getSlateAuto,
  postSlateImage,
  type DataFreshness,
  type SlateResolvedLine,
  type SlateResponse,
  type SlateUnresolvedLine,
} from './api';
import { PlayerAvatar, TeamLogo } from './Avatar';
import { edgeScore } from './edgeScore';
import { NavBar } from './NavBar';
import { usePlan } from './plan';
import { Skeleton } from './Skeleton';
import { useSavedParlays, type SavedParlay } from './savedParlays';
import { useTitle } from './useTitle';

export function Slate() {
  useTitle(['Slate']);

  const { plan } = usePlan();
  const isPro = plan === 'pro';
  const { items: savedParlays, save: saveParlay, remove: removeParlay } = useSavedParlays();
  const [data, setData] = useState<SlateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoTried, setAutoTried] = useState(false);
  const [freshness, setFreshness] = useState<DataFreshness | null>(null);
  const [filter, setFilter] = useState<'all' | 'over' | 'under' | 'strong'>('all');
  const [hideOut, setHideOut] = useState(true);
  const [teamFilter, setTeamFilter] = useState<string>('');
  const [statFilter, setStatFilter] = useState<string>('');
  const [sort, setSort] = useState<'confidence' | 'edge' | 'tipoff'>('confidence');

  // Parlay builder: selected card identifiers ("playerId-statKey-line").
  // Combined probability assumes leg independence — it's a model, not a
  // promise; the receipts ('hit X/10' per leg) keep users honest.
  // Pre-populated from ?legs= URL param so shared links work.
  const [searchParams, setSearchParams] = useSearchParams();
  const [parlay, setParlay] = useState<string[]>(() => {
    const raw = searchParams.get('legs');
    if (!raw) return [];
    return raw.split(',').filter(Boolean);
  });
  function cardKey(l: SlateResolvedLine): string {
    return `${l.playerId}-${l.statKey}-${l.line}`;
  }
  function toggleParlay(l: SlateResolvedLine) {
    const k = cardKey(l);
    setParlay((prev) =>
      prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k],
    );
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

  // First mount: kick off the auto-fetch from PrizePicks. If it fails
  // (Cloudflare blocks our IP, schema changes, etc.) we fall back to
  // showing only the upload prompt.
  useEffect(() => {
    setLoading(true);
    setError(null);
    getSlateAuto()
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => { setLoading(false); setAutoTried(true); });

    getDataFreshness().then(setFreshness).catch(() => {});
  }, []);

  // Background refresh: PP lines move during the day, so we re-pull
  // every 5 minutes while the tab is visible and immediately after the
  // tab returns to focus. We DON'T set loading=true on these refreshes
  // — silent updates keep the parlay tray and filters from flickering.
  useEffect(() => {
    let alive = true;
    const silentRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      // Only refresh the auto path — uploaded slates are static by design.
      if (data && data.source === 'image_upload') return;
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
    getSlateAuto()
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }

  async function handleFile(file: File) {
    setLoading(true);
    setError(null);
    try {
      const result = await postSlateImage(file);
      setData(result);
    } catch (e) {
      setError((e as Error).message);
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

  return (
    <div className="app">
      <NavBar />

      {isStale && (
        <div className="freshness stale" style={{ marginBottom: 16 }}>
          Heads up: NBA data is {freshness?.daysStale} days old — these
          percentages may not reflect tonight's form.
        </div>
      )}

      <h1 style={{ marginTop: 8 }}>Slate</h1>
      <p className="tag">
        Tonight's prop board — auto-pulled from PrizePicks when their API lets
        us, with hit-probability badges from your last 10 games.
      </p>

      {/* Source banner / actions */}
      <div className="slate-actions">
        <DropZone disabled={loading} onFile={handleFile} />
        <button className="cta" onClick={retryAuto} disabled={loading}>
          {loading ? 'Working…' : data?.source === 'prizepicks_auto' ? 'Refresh' : 'Try auto-pull again'}
        </button>
      </div>

      {error && (
        <div className="slate-error">
          <strong>Auto-pull failed:</strong> {error}
          <p className="muted small">
            PrizePicks's API rate-limits non-browser traffic. Take a screenshot
            of any prop board and drop it above — we'll OCR it the same way.
          </p>
        </div>
      )}

      {data && data.source === 'prizepicks_auto' && (
        <p className="muted small slate-source">
          Source: PrizePicks · {lines.length} resolved lines
          {data.unresolved.length > 0 && ` · ${data.unresolved.length} unmatched`}
          {' · '}as of {new Date(data.fetchedAt).toLocaleTimeString()}
        </p>
      )}
      {data && data.source === 'image_upload' && (
        <p className="muted small slate-source">
          Source: your screenshot · {lines.length} resolved lines
          {data.unresolved.length > 0 && ` · ${data.unresolved.length} unmatched`}
        </p>
      )}

      {lines.length > 0 && (
        <>
          <div className="slate-filters">
            <FilterTab v="all"    cur={filter} onSet={setFilter}>All</FilterTab>
            <FilterTab v="strong" cur={filter} onSet={setFilter}>Strong (≥75%)</FilterTab>
            <FilterTab v="over"   cur={filter} onSet={setFilter}>Over leans</FilterTab>
            <FilterTab v="under"  cur={filter} onSet={setFilter}>Under leans</FilterTab>
            {outCount > 0 && (
              <button
                className={hideOut ? 'pick-btn active' : 'pick-btn'}
                onClick={() => setHideOut(!hideOut)}
                title={hideOut ? 'Show OUT players' : 'Hide OUT players'}
              >
                {hideOut ? `Hiding ${outCount} OUT` : `Showing ${outCount} OUT`}
              </button>
            )}
          </div>
          <div className="slate-filters">
            <select
              className="slate-select"
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
            >
              <option value="">All teams ({teams.length})</option>
              {teams.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select
              className="slate-select"
              value={statFilter}
              onChange={(e) => setStatFilter(e.target.value)}
            >
              <option value="">All stats ({stats.length})</option>
              {stats.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {(teamFilter || statFilter) && (
              <button
                className="pick-btn"
                onClick={() => { setTeamFilter(''); setStatFilter(''); }}
              >
                Clear filters
              </button>
            )}
            <select
              className="slate-select"
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              title="Sort"
            >
              <option value="confidence">Sort: Confidence</option>
              <option value="edge">Sort: Best edge</option>
              <option value="tipoff">Sort: Tipoff time</option>
            </select>
            <span className="slate-result-count muted small">
              {sorted.length} of {lines.length}
            </span>
          </div>
        </>
      )}

      {isPro && savedParlays.length > 0 && (
        <SavedParlaysSection
          parlays={savedParlays}
          onOpen={(p) => setParlay(p.legs)}
          onRemove={removeParlay}
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
        <div className="slate-grid">
          {sorted.map((l) => {
            const k = cardKey(l);
            return (
              <LineCard
                key={k}
                line={l}
                inParlay={parlay.includes(k)}
                onToggleParlay={() => toggleParlay(l)}
                showEdge={sort === 'edge'}
              />
            );
          })}
        </div>
      )}

      {data && data.unresolved.length > 0 && (
        <UnresolvedSection unresolved={data.unresolved} />
      )}

      {parlay.length > 0 && lines.length > 0 && (
        <ParlayTray
          legs={lines.filter((l) => parlay.includes(cardKey(l)))}
          onRemove={(l) => removeFromParlay(cardKey(l))}
          onClear={clearParlay}
          onSave={(name) => saveParlay(name, parlay)}
          canSave={isPro}
          canAnalyze={isPro}
        />
      )}
    </div>
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
}: {
  line: SlateResolvedLine;
  inParlay: boolean;
  onToggleParlay: () => void;
  showEdge?: boolean;
}) {
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
      </Link>
    </div>
  );
}

function SavedParlaysSection({
  parlays,
  onOpen,
  onRemove,
}: {
  parlays: SavedParlay[];
  onOpen: (p: SavedParlay) => void;
  onRemove: (id: string) => void;
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
              <button
                key={`${l.playerId}-${l.statKey}-${l.line}`}
                className="parlay-leg"
                onClick={() => onRemove(l)}
                title="Remove from parlay"
              >
                <span className="parlay-leg-name">{l.playerName}</span>
                <span className="parlay-leg-stat">
                  {l.statLabel} {l.line} {lean === 'OVER' ? '↑' : '↓'}
                </span>
                <span className="parlay-leg-pct">{pct}%</span>
                <span className="parlay-leg-x" aria-hidden>✕</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Reference PrizePicks payout multipliers (Power Plays). Used for a
// rough "if this hits, you'd win Nx your entry" hint — informational,
// no betting advice in any direction.
const PRIZEPICKS_PAYOUTS: Record<number, number | undefined> = {
  2: 3,
  3: 5,
  4: 10,
  5: 20,
  6: 35,
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
