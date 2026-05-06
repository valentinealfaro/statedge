import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getDataFreshness,
  getSlateAuto,
  postSlateImage,
  type DataFreshness,
  type SlateResolvedLine,
  type SlateResponse,
  type SlateUnresolvedLine,
} from './api';
import { PlayerAvatar, TeamLogo } from './Avatar';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

export function Slate() {
  useTitle(['Slate']);

  const [data, setData] = useState<SlateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoTried, setAutoTried] = useState(false);
  const [freshness, setFreshness] = useState<DataFreshness | null>(null);
  const [filter, setFilter] = useState<'all' | 'over' | 'under' | 'strong'>('all');

  // Parlay builder: selected card identifiers ("playerId-statKey-line").
  // Combined probability assumes leg independence — it's a model, not a
  // promise; the receipts ('hit X/10' per leg) keep users honest.
  const [parlay, setParlay] = useState<string[]>([]);
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
  const filtered = lines.filter((l) => {
    if (filter === 'all') return true;
    const lean = l.hitProbability?.lean;
    if (filter === 'over') return lean === 'OVER';
    if (filter === 'under') return lean === 'UNDER';
    if (filter === 'strong') return (l.hitProbability?.mightHitPct ?? 0) >= 75;
    return true;
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
        <div className="slate-filters">
          <FilterTab v="all"    cur={filter} onSet={setFilter}>All</FilterTab>
          <FilterTab v="strong" cur={filter} onSet={setFilter}>Strong (≥75%)</FilterTab>
          <FilterTab v="over"   cur={filter} onSet={setFilter}>Over leans</FilterTab>
          <FilterTab v="under"  cur={filter} onSet={setFilter}>Under leans</FilterTab>
        </div>
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

      {filtered.length > 0 && (
        <div className="slate-grid">
          {filtered.map((l) => {
            const k = cardKey(l);
            return (
              <LineCard
                key={k}
                line={l}
                inParlay={parlay.includes(k)}
                onToggleParlay={() => toggleParlay(l)}
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
}: {
  line: SlateResolvedLine;
  inParlay: boolean;
  onToggleParlay: () => void;
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

  return (
    <div className={inParlay ? 'slate-card in-parlay' : 'slate-card'}>
      <button
        className={inParlay ? 'slate-pin pinned' : 'slate-pin'}
        onClick={onToggleParlay}
        title={inParlay ? 'Remove from parlay' : 'Add to parlay'}
        aria-label={inParlay ? 'Remove from parlay' : 'Add to parlay'}
      >
        {inParlay ? '✓' : '+'}
      </button>

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
      </Link>
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
}: {
  legs: SlateResolvedLine[];
  onRemove: (line: SlateResolvedLine) => void;
  onClear: () => void;
}) {
  const probs = legs.map((l) => (l.hitProbability?.mightHitPct ?? 50) / 100);
  const combined = probs.reduce((p, q) => p * q, 1);
  const combinedPct = Math.round(combined * 100);
  const tooFew = legs.length < 2;
  const ppPayout = PRIZEPICKS_PAYOUTS[legs.length];

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
          <button className="link" onClick={onClear}>Clear</button>
        </div>
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
