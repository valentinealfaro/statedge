// MLB slate page — Phase 4. Admin pastes tonight's lines as JSON,
// system projects each leg via mlbProjectionEngine, then constructs
// Safe/Balanced/Aggressive/Insane combos respecting the per-spec
// "card size must be earned" eligibility gates.
//
// Mission alignment:
//   - When a card slot can't earn its eligibility bar, we surface
//     the reason ("No clean 6-leg edge detected tonight") rather
//     than forcing a fake card.
//   - Insane mode keeps lottery framing per saved memory.
//   - Disclaimer always rendered.
//   - No "lock / guaranteed" copy anywhere.
//
// v1 ingestion is a JSON paste box. PrizePicks/scrape integration
// for MLB is a future slice.

import { useEffect, useMemo, useState } from 'react';
import {
  buildMlbSlateRequest,
  clearMlbDailySlate,
  getMlbDailySlate,
  getMlbLiveToday,
  rebuildMlbDailySlate,
  setMlbDailySlate,
  type MlbDailySlateResponse,
  type MlbLiveTodayPlayer,
  type MlbLiveTodayResponse,
  type MlbSlateResponse,
  type MlbWildCardCombo,
  type RawMlbSlateLine,
} from './api';
import { MlbTodaysGames } from './MlbTodaysGames';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

// Admin secret stored in localStorage so the publish flow doesn't
// re-prompt every page load. Only writers need it; readers (the
// public view) don't.
const ADMIN_KEY = 'statedge:mlbSlate:adminSecret';

// MLB team abbreviations (30 teams). Used to filter pasted slates
// down to MLB-only — PrizePicks lists every sport's lines on one
// page and a "copy all" paste typically includes NBA/NFL/NHL. The
// admin's 3130-line paste was almost entirely non-MLB; filtering
// drops the burden on the projection pipeline by ~5x.
const MLB_TEAM_ABBRS = new Set([
  // AL East
  'NYY', 'BOS', 'TB', 'TOR', 'BAL',
  // AL Central
  'CLE', 'MIN', 'KC', 'CWS', 'CHW', 'DET',
  // AL West
  'HOU', 'TEX', 'SEA', 'LAA', 'OAK', 'ATH',
  // NL East
  'ATL', 'PHI', 'NYM', 'WSH', 'WAS', 'MIA',
  // NL Central
  'CHC', 'STL', 'MIL', 'PIT', 'CIN',
  // NL West
  'LAD', 'SD', 'SF', 'ARI', 'AZ', 'COL',
]);

// Pre-filter pipe-format text to MLB-only. Returns { kept, droppedNonMlb }
// counts so the UI can surface the filter. Lines starting with #
// (comments) and blank lines pass through unchanged.
function filterToMlbOnly(text: string): { filtered: string; droppedNonMlb: number } {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let dropped = 0;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(raw);   // preserve comments + blanks
      continue;
    }
    // Pipe format: Player|TEAM|stat|line|side. Pull TEAM (2nd field).
    const parts = trimmed.split('|');
    if (parts.length < 5) {
      // Unparsable — let the backend's text parser surface the error.
      out.push(raw);
      continue;
    }
    const team = (parts[1] ?? '').trim().toUpperCase();
    if (MLB_TEAM_ABBRS.has(team)) {
      out.push(raw);
    } else {
      dropped += 1;
    }
  }
  return { filtered: out.join('\n'), droppedNonMlb: dropped };
}

type ModeKey = 'safe' | 'balanced' | 'aggressive' | 'insane' | 'auto';

// ---------- Slate-input dedup ----------
//
// Track lines that were successfully built within a recent window so
// re-pasting a 500-line slate doesn't re-burn server time on lines we
// already projected. Memory is keyed by a normalized form of each
// raw line (whitespace + case folded) so trivial typos still match.
//
// Auto-expiry is 60 minutes — after that, projections may have
// shifted (lineup confirmed, weather updated, ML odds moved) so we
// re-run them anyway. The "Force build all" button bypasses memory
// for one-off re-runs.
const SEEN_KEY = 'statedge:mlbSlate:seenLines:v1';
const SEEN_TTL_MS = 60 * 60 * 1000;

// Textarea content is also persisted so the user's paste survives a
// page reload. Without this, returning to /mlb/slate showed the
// sample again while the dedup memory still held 3130 entries —
// confusing because the user couldn't see what they already pasted.
const TEXT_KEY = 'statedge:mlbSlate:input:v1';

type SeenMap = Record<string, number>;     // normalizedLine → epoch ms

function loadSeen(): SeenMap {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SeenMap;
    const now = Date.now();
    const out: SeenMap = {};
    for (const [line, ts] of Object.entries(parsed)) {
      if (now - ts < SEEN_TTL_MS) out[line] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function saveSeen(seen: SeenMap): void {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* full quota */ }
}

function loadText(): string | null {
  try { return localStorage.getItem(TEXT_KEY); } catch { return null; }
}

function saveText(text: string): void {
  try { localStorage.setItem(TEXT_KEY, text); } catch { /* full quota */ }
}

// Normalize a raw line for dedup. Same form used to remember built
// lines and to filter the next paste. Pipe-format is space/case-folded;
// JSON-encoded lines are JSON.stringify'd with sorted keys.
function normalizeLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Split a paste into individual line strings (pipe format) or a
// single normalized JSON-element-per-leg list. Strips comments + blanks.
function splitInputIntoLines(text: string, format: 'json' | 'pipe'): string[] {
  if (format === 'json') {
    try {
      const arr = JSON.parse(text) as RawMlbSlateLine[];
      if (!Array.isArray(arr)) return [];
      // Stringify each leg with sorted keys for stable normalization.
      return arr.map((leg) => stableStringify(leg));
    } catch {
      return [];
    }
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((obj as Record<string, unknown>)[k])).join(',') + '}';
}

// Sample inputs the user can clone. Two supported formats — the
// textarea autodetects which is which based on whether the text
// parses as JSON.
const SAMPLE_PIPE = `# Pipe format: Player Name|TEAM|stat_key|line|sides
# sides ∈ over / under / both. Lines starting with # are skipped.
Aaron Judge|NYY|home_runs|0.5|over
Mookie Betts|LAD|total_bases|1.5|both
Chris Sale|ATL|ks|6.5|over`;

const SAMPLE_JSON = `[
  { "playerId": 592450, "statKey": "home_runs", "line": 0.5,  "direction": "over" },
  { "playerId": 660271, "statKey": "hits",       "line": 1.5,  "direction": "both" },
  { "playerId": 545361, "statKey": "total_bases","line": 2.5,  "direction": "both" }
]`;

const SAMPLE_LINES = SAMPLE_PIPE;

// Detect input format: starts with `[` or `{` → JSON. Otherwise
// treat as pipe text (the parser ignores comments + blanks anyway).
function detectFormat(text: string): 'json' | 'pipe' {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json';
  return 'pipe';
}

export function MlbSlate() {
  useTitle(['MLB Slate']);

  // Restore last-saved paste so the user's slate survives reloads —
  // the dedup memory remembering 3130 lines but the textarea showing
  // only the sample was the source of much confusion.
  const [linesText, setLinesText] = useState(() => loadText() ?? SAMPLE_LINES);
  const [mode, setMode] = useState<ModeKey>('balanced');
  const [result, setResult] = useState<MlbSlateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Dedup memory + UI state. memoryCount drives the "X memorized"
  // chip; skippedCount is the per-build count of lines that were
  // filtered out as already-seen.
  const [seen, setSeen] = useState<SeenMap>(() => loadSeen());
  const [skipDedup, setSkipDedup] = useState(false);
  const [skippedCount, setSkippedCount] = useState(0);

  // Today's admin-published slate. Loaded on mount; what every public
  // visitor sees by default. The paste-and-build form below is only
  // shown to admins (those with the secret).
  const [today, setToday] = useState<MlbDailySlateResponse | null>(null);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [adminSecret, setAdminSecret] = useState<string>(() => {
    try { return localStorage.getItem(ADMIN_KEY) ?? ''; } catch { return ''; }
  });
  const [adminMode, setAdminMode] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  const isAdmin = adminSecret.trim().length > 0;

  // Fetch today's published slate on mount + after every publish.
  useEffect(() => {
    let cancelled = false;
    setTodayError(null);
    getMlbDailySlate('balanced')
      .then((r) => { if (!cancelled) setToday(r); })
      .catch((err: Error) => { if (!cancelled) setTodayError(err.message); });
    return () => { cancelled = true; };
  }, [publishMessage]);    // re-fetch after a successful publish

  // Persist admin secret across reloads.
  useEffect(() => {
    try {
      if (adminSecret.trim().length > 0) localStorage.setItem(ADMIN_KEY, adminSecret);
      else localStorage.removeItem(ADMIN_KEY);
    } catch { /* full quota */ }
  }, [adminSecret]);

  async function handlePublish() {
    setPublishing(true);
    setPublishMessage(null);
    setError(null);
    const format = detectFormat(linesText);
    try {
      let lines: RawMlbSlateLine[] | undefined;
      if (format === 'json') {
        try {
          lines = JSON.parse(linesText) as RawMlbSlateLine[];
        } catch {
          throw new Error('Invalid JSON.');
        }
        if (!Array.isArray(lines) || lines.length === 0) {
          throw new Error('JSON must be a non-empty array.');
        }
      }
      const r = await setMlbDailySlate({
        text: format === 'pipe' ? linesText : undefined,
        lines: format === 'json' ? lines : undefined,
        mode,
        adminSecret,
      });
      setPublishMessage(`Published ${r.count} line${r.count === 1 ? '' : 's'} for ${r.date}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  async function handleClearToday() {
    if (!confirm('Wipe today\'s published slate? Public visitors will see an empty page until you publish again.')) return;
    setPublishing(true);
    setPublishMessage(null);
    try {
      await clearMlbDailySlate(adminSecret);
      setPublishMessage('Cleared today\'s slate.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  async function handleRebuildToday() {
    setPublishing(true);
    setPublishMessage(null);
    setError(null);
    try {
      const r = await rebuildMlbDailySlate(adminSecret);
      setPublishMessage(`${r.message} ${r.count} lines re-projected for ${r.date}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  // Live count for the chip — derived so it updates after every save.
  const memoryCount = useMemo(() => Object.keys(seen).length, [seen]);

  // Persist memory anytime it changes.
  useEffect(() => { saveSeen(seen); }, [seen]);

  // Persist the paste so reloads don't wipe it. Skip persisting the
  // unchanged sample (no value, just clutter).
  useEffect(() => {
    if (linesText === SAMPLE_LINES) return;
    saveText(linesText);
  }, [linesText]);

  function clearSeen(): void {
    setSeen({});
    setSkippedCount(0);
  }

  async function handleBuild() {
    setError(null);
    setResult(null);
    setSkippedCount(0);
    const format = detectFormat(linesText);
    setLoading(true);
    try {
      let r: MlbSlateResponse;
      // Filter the input text against memory unless the user clicked
      // "Force build all". Filtering happens BEFORE we hit the
      // backend so we don't spend serverless time re-projecting
      // lines we already projected within the dedup window.
      const allLines = splitInputIntoLines(linesText, format);
      const fresh: string[] = [];
      let skipped = 0;
      if (!skipDedup) {
        for (const line of allLines) {
          if (seen[normalizeLine(line)] !== undefined) skipped += 1;
          else fresh.push(line);
        }
      } else {
        fresh.push(...allLines);
      }
      setSkippedCount(skipped);
      if (fresh.length === 0) {
        if (skipped > 0) {
          // Special-cased: every line is already memorized. This is
          // the most common confusion case (user re-pastes a slate
          // they already built). Give them a one-click recovery
          // path instead of just an error string.
          setError(
            `All ${skipped} of your lines were already built within the last hour. ` +
            `The model already has fresh projections for them. ` +
            `Tick "Force build all" above to re-project anyway, or click "Forget memory" to start over.`,
          );
        } else {
          setError('No lines provided.');
        }
        setLoading(false);
        return;
      }

      if (format === 'json') {
        let parsed: RawMlbSlateLine[];
        try {
          // Parse only the fresh subset back into JSON objects.
          parsed = fresh.map((s) => JSON.parse(s) as RawMlbSlateLine);
          if (parsed.length === 0) throw new Error('No lines provided.');
        } catch (err) {
          setError(`Invalid JSON: ${(err as Error).message}`);
          setLoading(false);
          return;
        }
        r = await buildMlbSlateRequest({ lines: parsed }, mode);
      } else {
        // Pipe text — re-stitch the fresh lines so the backend parses
        // them with full pipe-format semantics (preserves comments
        // would be ideal, but they were already stripped).
        r = await buildMlbSlateRequest({ text: fresh.join('\n') }, mode);
      }
      setResult(r);

      // Memorize lines we just successfully built. We commit the
      // whole `fresh` set even though some may have been unresolved
      // server-side — re-running them won't help until the user fixes
      // the underlying issue (typo / not-in-DB), and re-projecting
      // them on every paste is exactly what we're trying to avoid.
      const now = Date.now();
      const next: SeenMap = { ...seen };
      for (const line of fresh) next[normalizeLine(line)] = now;
      setSeen(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h1 style={{ margin: 0 }}>MLB · Slate</h1>
          <button
            type="button"
            className="mlb-clear-player"
            style={{ fontSize: 12 }}
            onClick={() => setAdminMode((v) => !v)}
            title={isAdmin ? 'Open the admin publish form to update today\'s slate.' : 'Authenticate as admin to publish a daily slate.'}
          >
            {adminMode ? '← Public view' : (isAdmin ? 'Admin →' : 'Admin login →')}
          </button>
        </div>

        {/* PUBLIC VIEW — today's published slate. Default for every visitor. */}
        {!adminMode && (
          <PublicTodaySlate today={today} error={todayError} />
        )}

        {/* ADMIN VIEW — paste lines + Publish button. */}
        {adminMode && !isAdmin && (
          <section className="mlb-stat-section" style={{ marginTop: 12 }}>
            <label className="mlb-label" htmlFor="mlb-admin-secret">Admin secret</label>
            <input
              id="mlb-admin-secret"
              type="password"
              className="mlb-stat-select"
              autoComplete="off"
              placeholder="Paste SLATE_ADMIN_SECRET"
              value={adminSecret}
              onChange={(e) => setAdminSecret(e.target.value)}
            />
            <p className="muted small" style={{ marginTop: 6 }}>
              Stored in your browser's localStorage. Server-side env
              var <code>SLATE_ADMIN_SECRET</code> must match.
            </p>
          </section>
        )}

        {adminMode && isAdmin && (
          <p className="muted small" style={{ marginTop: 8 }}>
            <strong>Admin mode.</strong> Paste tonight's lines below and
            click <em>Publish today's slate</em>. The pasted lines stay
            visible to all visitors at /mlb/slate until you publish again
            or click <em>Clear today's slate</em>.
            {' · '}
            <button
              type="button"
              className="mlb-clear-player"
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() => { setAdminSecret(''); setAdminMode(false); }}
            >
              Sign out
            </button>
          </p>
        )}

        {/* The build / publish form (only when adminMode + secret present). */}
        {adminMode && isAdmin && (
        <section className="mlb-stat-section">
          <label className="mlb-label" htmlFor="mlb-mode-select">Mode</label>
          <select
            id="mlb-mode-select"
            className="mlb-stat-select"
            value={mode}
            onChange={(e) => setMode(e.target.value as ModeKey)}
          >
            <option value="auto">Auto (resolves to slate quality)</option>
            <option value="safe">Safe (2-4 leg, high probability)</option>
            <option value="balanced">Balanced (2-6 leg, EV-led)</option>
            <option value="aggressive">Aggressive (3-6 leg, edge-led)</option>
            <option value="insane">Insane (5-6 leg, lottery-ticket)</option>
          </select>

          <label className="mlb-label" htmlFor="mlb-lines-textarea" style={{ marginTop: 12 }}>
            Tonight's lines · paste pipe format OR JSON
          </label>
          <p className="muted small" style={{ margin: '0 0 6px' }}>
            Pipe format: <code>Player|TEAM|stat_key|line|sides</code> per
            line. Sides = over / under / both. Lines starting with #
            are skipped. JSON arrays also accepted.
          </p>
          <textarea
            id="mlb-lines-textarea"
            className="mlb-lines-textarea"
            spellCheck={false}
            value={linesText}
            onChange={(e) => setLinesText(e.target.value)}
            rows={10}
          />
          <div className="mlb-line-row" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="mlb-build-btn"
              onClick={handleBuild}
              disabled={loading}
            >
              {loading ? 'Building…' : skipDedup ? 'Force build all' : 'Build slate'}
            </button>
            <button
              type="button"
              className="mlb-clear-player"
              onClick={() => {
                setLinesText(SAMPLE_LINES);
                setResult(null);
                setError(null);
                try { localStorage.removeItem(TEXT_KEY); } catch { /* ignore */ }
              }}
            >
              Reset to sample
            </button>
          </div>

          <div className="mlb-dedup-row" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
            <span title="Lines already projected within the last hour are skipped on subsequent builds so re-pasting a 500-line slate doesn't re-burn server time. After 60 min, projections may have shifted (lineups, weather, ML odds), so memory auto-expires.">
              <strong>Skip-already-built memory:</strong>{' '}
              <span style={{ opacity: memoryCount > 0 ? 1 : 0.6 }}>
                {memoryCount} line{memoryCount === 1 ? '' : 's'} memorized (60-min window)
              </span>
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={skipDedup}
                onChange={(e) => setSkipDedup(e.target.checked)}
              />
              Force build all (ignore memory)
            </label>
            {memoryCount > 0 && (
              <button
                type="button"
                className="mlb-clear-player"
                onClick={clearSeen}
                style={{ fontSize: 11, padding: '2px 8px' }}
                title="Wipe the dedup memory so the next Build re-projects every line."
              >
                Forget memory
              </button>
            )}
          </div>

          {skippedCount > 0 && !error && (
            <div className="mlb-info-banner" style={{ marginTop: 8 }}>
              Skipped <strong>{skippedCount}</strong> line{skippedCount === 1 ? '' : 's'} already built within the last hour.
              Tick "Force build all" to re-project them.
            </div>
          )}

          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              className="mlb-build-btn"
              style={{ background: 'var(--accent, #4fc3f7)' }}
              onClick={handlePublish}
              disabled={publishing}
              title="Saves these lines as today's public slate. Visitors at /mlb/slate will see whatever you publish here."
            >
              {publishing ? 'Publishing…' : 'Publish today\'s slate'}
            </button>
            {today?.slate && (
              <>
                <button
                  type="button"
                  className="mlb-clear-player"
                  onClick={handleRebuildToday}
                  disabled={publishing}
                  title="Re-run the builder on today's stored lines using the latest engine code. Useful after new logic deploys (Phase 28-34 etc.) — applies new card-construction rules without re-pasting."
                >
                  Rebuild with current engine
                </button>
                <button
                  type="button"
                  className="mlb-clear-player"
                  onClick={handleClearToday}
                  disabled={publishing}
                  title="Wipe today's published slate."
                >
                  Clear today's slate
                </button>
              </>
            )}
            {publishing && (
              <span className="muted small">
                Resolving {linesText.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).length} lines… large
                slates take 30-60s.
              </span>
            )}
            {publishMessage && (
              <span className="mlb-info-banner" style={{ padding: '4px 10px', margin: 0, fontSize: 12 }}>
                ✓ {publishMessage}
              </span>
            )}
          </div>

          {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        </section>
        )}

        {loading && <Skeleton width="100%" height={240} style={{ marginTop: 20 }} />}

        {result && <SlateResultView data={result} />}

        {/* All MLB games — sits at the bottom of the slate page for
            both public and admin views. Auto-refreshes every 60s
            during live games so the rail becomes a live-tracker as
            games progress. */}
        <div style={{ marginTop: 24 }}>
          <MlbTodaysGames />
        </div>
      </div>
    </div>
  );
}

// Public view of today's admin-published slate. Default for every
// visitor (and the only thing they see — the paste-and-build form
// is gated behind admin login).
function PublicTodaySlate({
  today,
  error,
}: {
  today: MlbDailySlateResponse | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="mlb-info-banner mlb-info-error" style={{ marginTop: 12 }}>
        Couldn't load today's slate: {error}
      </div>
    );
  }
  if (!today) {
    return <Skeleton width="100%" height={300} style={{ marginTop: 20 }} />;
  }
  if (!today.slate || !today.resolved) {
    return (
      <div className="mlb-info-banner" style={{ marginTop: 12 }}>
        <strong>No slate published yet today.</strong> Check back later
        — admin posts the day's lines once tonight's PrizePicks board
        is live. The builder runs Safe / Balanced / Aggressive / Insane
        cards plus a Wild Card per the institutional engine.
      </div>
    );
  }
  return (
    <>
      <p className="muted small" style={{ marginTop: 8 }}>
        Today's slate · <strong>{today.slate.date}</strong> ·{' '}
        {today.slate.count} line{today.slate.count === 1 ? '' : 's'} ·{' '}
        last updated {new Date(today.slate.updatedAt).toLocaleTimeString()}
        {' · '}
        <a href="/mlb/slate/history" style={{ color: 'var(--accent, #4fc3f7)' }}>
          history →
        </a>
      </p>
      <SlateResultView data={today.resolved} />
    </>
  );
}

// Polls /api/mlb/live/today every 30s while there's at least one
// in-progress game; otherwise re-fetches on a slower 60s cadence so
// the UI catches the moment the first game starts. Server-side cache
// debounces upstream traffic — clients can poll freely.
function useLiveToday(): MlbLiveTodayResponse | null {
  const [feed, setFeed] = useState<MlbLiveTodayResponse | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getMlbLiveToday()
      .then((d) => { if (!cancelled) setFeed(d); })
      .catch(() => { /* silent — no live data is fine */ });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    const anyLive = feed
      ? Object.values(feed.byGame).some((g) => g.state === 'live')
      : false;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, anyLive ? 30_000 : 60_000);
    return () => window.clearInterval(interval);
  }, [feed]);

  return feed;
}

// Mirrors the same statKey → live-stats lookup used on the
// game-detail page. Keep these two implementations in sync.
function liveValueForStat(stats: MlbLiveTodayPlayer, statKey: string): number | null {
  switch (statKey) {
    case 'hits':                return stats.hits;
    case 'total_bases':         return stats.totalBases;
    case 'runs':                return stats.runs;
    case 'rbis':                return stats.rbis;
    case 'walks':               return stats.walks;
    case 'strikeouts':          return stats.strikeouts;
    case 'home_runs':           return stats.homeRuns;
    case 'doubles':             return stats.doubles;
    case 'triples':             return stats.triples;
    case 'stolen_bases':        return stats.stolenBases;
    case 'hit_by_pitch':        return stats.hitByPitch;
    case 'hits_runs_rbis': {
      const h = stats.hits;
      const r = stats.runs;
      const ri = stats.rbis;
      if (h === null && r === null && ri === null) return null;
      return (h ?? 0) + (r ?? 0) + (ri ?? 0);
    }
    case 'pitcher_strikeouts':  return stats.pitcherStrikeouts;
    case 'hits_allowed':        return stats.hitsAllowed;
    case 'earned_runs_allowed': return stats.earnedRunsAllowed;
    case 'walks_allowed':       return stats.walksAllowed;
    case 'outs_recorded':       return stats.outsRecorded;
    case 'home_runs_allowed':   return stats.homeRunsAllowed;
    case 'pitching_outs':       return stats.outsRecorded;
    default:                    return null;
  }
}

type LiveGrade = 'HIT' | 'MISS' | 'PROGRESS' | 'PUSH' | 'PENDING';

function gradeLeg(
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

// Resolve the live grade for a leg from the bulk live feed. Returns
// PENDING when the leg's player isn't in the live data (e.g. game
// hasn't started, or player wasn't in lineup).
function resolveLegLive(
  liveToday: MlbLiveTodayResponse | null,
  leg: { playerId: number; statKey: string; line: number; direction: 'OVER' | 'UNDER' },
): { grade: LiveGrade; current: number | null } {
  if (!liveToday) return { grade: 'PENDING', current: null };
  const ps = liveToday.byPlayer[String(leg.playerId)];
  if (!ps) return { grade: 'PENDING', current: null };
  const game = liveToday.byGame[String(ps.gamePk)];
  const current = liveValueForStat(ps, leg.statKey);
  return { grade: gradeLeg(leg.direction, leg.line, current, game?.state), current };
}

function SlateResultView({ data }: { data: MlbSlateResponse }) {
  // Engine activity summary — what did the engine actually do? Counts
  // are derived from the response so the user sees the work.
  const totalCombos = data.combos.length;
  const builtCombos = data.combos.filter((c) => c.combo !== null).length;
  const blockedReasons = data.combos
    .filter((c) => c.combo === null)
    .map((c) => ({ size: c.size, reason: c.reason }));
  const calibrationAdjusted = data.combos
    .flatMap((c) => c.combo?.legs ?? [])
    .reduce((n, l) => {
      const hits = (l.reasonCodes ?? []).filter((r) => /calibration/i.test(r)).length;
      return n + (hits > 0 ? 1 : 0);
    }, 0);

  // Live grading — fetched once at the rail level, drilled into both
  // card types. When no games are live, all grades are PENDING and
  // cards render exactly as before.
  const liveToday = useLiveToday();

  return (
    <div className="mlb-slate-result">
      <div className="mlb-info-banner">
        Mode: <strong>{data.requestedMode}</strong>
        {data.requestedMode === 'auto' && (
          <> · auto-resolved to <strong>{data.resolvedMode}</strong></>
        )}
        {' · '}{data.lineCount} eligible leg{data.lineCount === 1 ? '' : 's'} from your input
      </div>

      <EngineActivityPanel
        eligible={data.lineCount}
        unresolved={data.unresolved.length}
        builtCombos={builtCombos}
        totalCombos={totalCombos}
        wildCardKind={data.wildCard.kind}
        blockedReasons={blockedReasons}
        calibrationAdjusted={calibrationAdjusted}
      />

      {data.unresolved.length > 0 && (
        <div className="mlb-info-banner mlb-info-error">
          <strong>{data.unresolved.length} line(s) couldn't be resolved:</strong>
          <ul>
            {data.unresolved.map((u, i) => (
              <li key={i}>
                Player {u.raw.playerId} · {u.raw.statKey} {u.raw.line} — {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="best-picks-rail">
        {data.combos.map((slot) => (
          <ComboCard key={slot.size} slot={slot} liveToday={liveToday} />
        ))}
        <WildCardCard wildCard={data.wildCard} liveToday={liveToday} />
      </div>

      <p className="mlb-disclaimer">{data.disclaimer}</p>
    </div>
  );
}

// Engine activity panel — surfaces what the engine actually did when
// processing the slate. Mission-aligned transparency: users see the
// work, not just the output. Per spec L8 / L9: when a card slot
// fails, we name the reason; when calibration adjusts probabilities,
// the count is visible.
function EngineActivityPanel({
  eligible,
  unresolved,
  builtCombos,
  totalCombos,
  wildCardKind,
  blockedReasons,
  calibrationAdjusted,
}: {
  eligible: number;
  unresolved: number;
  builtCombos: number;
  totalCombos: number;
  wildCardKind: string;
  blockedReasons: Array<{ size: number; reason: string }>;
  calibrationAdjusted: number;
}) {
  return (
    <div className="mlb-context" style={{ marginTop: 12 }} title="What the engine did with your slate.">
      <div className="mlb-context-heading">Engine activity</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text-2)' }}>
        <li>
          <strong>{eligible}</strong> leg{eligible === 1 ? '' : 's'} projected
          {unresolved > 0 && <> · {unresolved} couldn't be resolved (see below)</>}
        </li>
        <li>
          Built <strong>{builtCombos}/{totalCombos}</strong> card slots
          {blockedReasons.length > 0 && <> · {blockedReasons.length} blocked</>}
        </li>
        {blockedReasons.length > 0 && (
          <ul style={{ paddingLeft: 18, marginTop: 2, color: 'var(--text-3)' }}>
            {blockedReasons.map((b, i) => (
              <li key={i}>
                <strong>Best {b.size}</strong>: {b.reason}
              </li>
            ))}
          </ul>
        )}
        <li>
          Wild Card tier: <strong>{wildCardKind.replace('_', ' ')}</strong>
        </li>
        {calibrationAdjusted > 0 && (
          <li>
            <strong>{calibrationAdjusted}</strong> leg{calibrationAdjusted === 1 ? '' : 's'} probability tuned by historical calibration (L9 → L6 feedback).
          </li>
        )}
      </ul>
    </div>
  );
}

// Wild Card — uses the same `best-pick-card wild` styling as NBA so
// users see one unified visual system across both sports.
function WildCardCard({ wildCard, liveToday }: { wildCard: MlbWildCardCombo; liveToday: MlbLiveTodayResponse | null }) {
  const kindLabel =
    wildCard.kind === 'standard' ? 'Standard'
    : wildCard.kind === 'near_miss' ? 'Near Miss'
    : wildCard.kind === 'momentum' ? 'Momentum'
    : wildCard.kind === 'matchup_spike' ? 'Matchup Spike'
    : wildCard.kind === 'high_variance' ? 'High Variance'
    : 'No Edge';

  if (wildCard.kind === 'no_edge') {
    return (
      <div className="best-pick-card wild empty">
        <div className="best-pick-head">
          <div className="best-pick-titles">
            <span className="best-pick-label">Wild Card</span>
            <span className="best-pick-subtitle">{kindLabel} · {wildCard.subtitle}</span>
          </div>
        </div>
        <p className="muted small" style={{ padding: '12px 16px' }}>
          No tier qualified — closest candidates by projection separation are below.
        </p>
        {wildCard.closestCandidates && wildCard.closestCandidates.length > 0 && (
          <div className="best-pick-legs">
            {wildCard.closestCandidates.map((leg, i) => (
              <div key={i} className="best-pick-leg-block">
                <div className="best-pick-leg">
                  <span className="best-pick-leg-name">{leg.playerName}</span>
                  <span className="best-pick-leg-stat">
                    {leg.statLabel} {leg.line}
                  </span>
                  <span className={`best-pick-leg-dir ${leg.direction === 'OVER' ? 'over' : 'under'}`}>
                    {leg.direction === 'OVER' ? '↑' : '↓'} {Math.round(leg.probability)}%
                  </span>
                </div>
                <div className="best-pick-wild-evidence">{leg.wildCardReason}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Treat Wild Card legs as a small card for EV/warning purposes.
  const size = wildCard.legs.length;
  const payout = FLEX_PAYOUTS[size] ?? 1;
  const winProb = wildCard.adjustedCombinedHit / 100;
  const ev = winProb * payout - 1;
  const evVerdict = ev >= 0.05 ? 'Positive EV' : ev <= -0.05 ? 'Negative EV' : 'Neutral EV';
  const evClass = ev >= 0.05 ? 'positive-ev' : ev <= -0.05 ? 'negative-ev' : 'neutral-ev';
  const trapExp = trapExposureLabel(wildCard.averageTrap);
  const mktDisagree = marketDisagreementLabel(wildCard.averageEdge);
  const projGap =
    wildCard.legs.reduce((sum, l) => sum + Math.abs(l.projection - l.line), 0) / wildCard.legs.length;
  const warnings = computeCardWarnings(wildCard.legs, size);

  const grades = wildCard.legs.map((l) => resolveLegLive(liveToday, l));
  const tally = {
    hit: grades.filter((g) => g.grade === 'HIT').length,
    miss: grades.filter((g) => g.grade === 'MISS').length,
    progress: grades.filter((g) => g.grade === 'PROGRESS').length,
    push: grades.filter((g) => g.grade === 'PUSH').length,
  };
  const anyLive = tally.hit + tally.miss + tally.progress + tally.push > 0;
  const cardDead = tally.miss > 0;
  const cardCleared = !cardDead && tally.hit === wildCard.legs.length;

  return (
    <div className="best-pick-card wild">
      <div className="best-pick-head">
        <div className="best-pick-titles">
          <span className="best-pick-label">Wild Card</span>
          <span className="best-pick-subtitle">{kindLabel} · {wildCard.subtitle}</span>
        </div>
        <span className="best-pick-size">{size}-LEG</span>
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
          }}
          title="Live grading — each leg checked against current game stats. ANY miss kills the whole parlay."
        >
          {cardCleared && <span>✓ ALL {wildCard.legs.length} HIT — CARD CLEARED</span>}
          {cardDead && <span>✗ {tally.miss} LEG{tally.miss === 1 ? '' : 'S'} DEAD</span>}
          {!cardCleared && !cardDead && <span>● {tally.hit}/{wildCard.legs.length} HIT · {tally.progress} LIVE</span>}
        </div>
      )}
      <div
        className="best-pick-pct"
        title={`Adjusted combined hit %. Raw: ${wildCard.rawCombinedHit.toFixed(1)}%, ${wildCard.correlationRisk} correlation penalty.`}
      >
        {wildCard.adjustedCombinedHit.toFixed(1)}%
      </div>
      <div className="best-pick-pct-label">
        adjusted hit · {wildCard.correlationRisk} correlation
      </div>
      <div
        className={`best-pick-ev ${evClass}`}
        title={`Win prob ${wildCard.adjustedCombinedHit.toFixed(1)}% × payout ${payout}× − $1 = ${ev >= 0 ? '+' : ''}${ev.toFixed(2)}.`}
      >
        {evVerdict} · {ev >= 0 ? '+' : ''}{ev.toFixed(2)} EV
        <span className="best-pick-ev-payout"> · {payout}× payout</span>
      </div>
      <div className="best-pick-signals">
        <div className="best-pick-signal">
          <span className="muted small">Avg Edge</span>
          <strong className={wildCard.averageEdge >= 10 ? 'pos' : wildCard.averageEdge <= -5 ? 'neg' : ''}>
            {wildCard.averageEdge >= 0 ? '+' : ''}{wildCard.averageEdge.toFixed(1)}%
          </strong>
        </div>
        <div className="best-pick-signal">
          <span className="muted small">Proj Gap</span>
          <strong>+{projGap.toFixed(1)}</strong>
        </div>
        <div className="best-pick-signal">
          <span className="muted small">Trap</span>
          <strong className={`trap-${trapExp.toLowerCase()}`}>{trapExp}</strong>
        </div>
        {wildCard.averageWildCardScore !== undefined ? (
          <div className="best-pick-signal" title="Phase 29 spec composite: projGap×0.25 + momentum×0.25 + matchup×0.15 + marketLag×0.15 + upside×0.10 - trap×0.10. ≥60 = real institutional edge.">
            <span className="muted small">WC Score</span>
            <strong className={wildCard.averageWildCardScore >= 60 ? 'pos' : wildCard.averageWildCardScore <= 35 ? 'neg' : ''}>
              {wildCard.averageWildCardScore.toFixed(0)}/100
            </strong>
          </div>
        ) : (
          <div className="best-pick-signal">
            <span className="muted small">Mkt Disagree</span>
            <strong className={`disagree-${mktDisagree.toLowerCase()}`}>{mktDisagree}</strong>
          </div>
        )}
      </div>

      <div className="best-pick-legs">
        {wildCard.legs.map((l, i) => {
          const conf = legConfidenceLabel(l.probability);
          const live = grades[i];
          return (
            <div key={i} className="best-pick-leg-block">
              <div className="best-pick-leg">
                <span className="best-pick-leg-name">{l.playerName}</span>
                <span className="best-pick-leg-stat">
                  {l.statLabel} {l.line}
                </span>
                <span className={`best-pick-leg-dir ${l.direction === 'OVER' ? 'over' : 'under'}`}>
                  {l.direction === 'OVER' ? '↑' : '↓'} {Math.round(l.probability)}%
                </span>
                <span className={`best-pick-leg-conf conf-${conf.toLowerCase()}`}>
                  {conf}
                </span>
              </div>
              <div className="best-pick-leg-evbar">
                <span
                  className={`best-pick-leg-edge ${l.edgePercent >= 5 ? 'pos' : l.edgePercent <= -5 ? 'neg' : 'flat'}`}
                >
                  {l.edgePercent >= 0 ? '+' : ''}{l.edgePercent.toFixed(0)}% edge
                </span>
                {l.trapScore >= 60 && (
                  <span className="best-pick-leg-trap">
                    ⚠ {l.trapScore >= 80 ? 'EXTREME TRAP RISK' : 'HIGH TRAP RISK'}
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
              <div className="best-pick-wild-evidence">{l.wildCardReason}</div>
            </div>
          );
        })}
      </div>

      {warnings.length > 0 && (
        <div className="best-pick-warnings">
          {warnings.map((w, i) => (
            <span key={i} className="best-pick-warning">⚠ {w}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// PrizePicks Flex Play payouts (memory-validated): 2/2 = 3×, 3/3 = 5×,
// 4/4 = 10×, 5/5 = 7× partial / 20× full, 6/6 = 25×. We use the 6/6
// (full hit) numbers because Adjusted Hit % already represents that.
const FLEX_PAYOUTS: Record<number, number> = { 2: 3, 3: 5, 4: 10, 5: 7, 6: 25 };

// Card-level trap-score gates per size — flagged on the warning strip
// when too many legs exceed. Mirrors NBA conventions (see Slate.tsx).
const TRAP_GATE: Record<number, number> = { 2: 50, 3: 45, 4: 40, 5: 35, 6: 30 };

// Per-leg confidence chip from probability tier. Same banding as NBA
// so the chips read identically across sports.
function legConfidenceLabel(prob: number): string {
  if (prob >= 75) return 'ELITE';
  if (prob >= 65) return 'STRONG';
  if (prob >= 55) return 'MEDIUM';
  return 'WEAK';
}

// Per-leg category — Safe Core / Value / Ceiling / Contrarian. Mirrors
// the NBA categorization so users see the same chips regardless of sport.
function legCategory(leg: MlbSlateResponse['combos'][number]['combo'] extends infer T
  ? T extends { legs: Array<infer L> } ? L : never : never): string | null {
  const prob = leg.probability;
  const edge = leg.edgePercent;
  const trap = leg.trapScore;
  const fragility = leg.fragilityScore ?? 50;
  if (prob >= 72 && trap <= 35 && fragility <= 50) return 'SAFE CORE';
  if (edge >= 15 && prob >= 55) return 'VALUE';
  if (fragility >= 65 && edge >= 10) return 'CEILING';
  if (leg.direction === 'UNDER' && edge >= 8) return 'CONTRARIAN';
  return null;
}

function trapExposureLabel(avgTrap: number): 'Low' | 'Medium' | 'High' {
  if (avgTrap < 30) return 'Low';
  if (avgTrap < 60) return 'Medium';
  return 'High';
}

function marketDisagreementLabel(avgEdge: number): 'Low' | 'Medium' | 'High' {
  if (avgEdge < 5) return 'Low';
  if (avgEdge < 15) return 'Medium';
  return 'High';
}

// Compute card-level warnings — same shape NBA shows ("X legs flagged",
// "X legs exceed trap-score gate", "Injury uncertainty").
function computeCardWarnings(
  legs: MlbSlateResponse['combos'][number]['combo'] extends infer T
    ? T extends { legs: Array<infer L> } ? L[] : never : never,
  size: number,
): string[] {
  const warnings: string[] = [];
  const trapHits = legs.filter((l) => l.trapScore >= 60).length;
  if (trapHits > 0) {
    warnings.push(
      `${trapHits} leg${trapHits === 1 ? '' : 's'} flagged as possible public-trap line — interpret with caution.`,
    );
  }
  const gate = TRAP_GATE[size] ?? 40;
  const overGate = legs.filter((l) => l.trapScore > gate).length;
  if (overGate > 0) {
    warnings.push(
      `${overGate} leg${overGate === 1 ? '' : 's'} exceed${overGate === 1 ? 's' : ''} the trap-score gate for a ${size}-leg card (≤${gate}) — consider a smaller card.`,
    );
  }
  const fragHits = legs.filter((l) => (l.fragilityScore ?? 0) >= 70).length;
  if (fragHits >= 2) {
    warnings.push(
      `${fragHits} legs flagged as Very Fragile — failure modes compound on a ${size}-leg card.`,
    );
  }
  return warnings;
}

// Render a polished MLB combo card matching the NBA `best-pick-card`
// design system: dense 4-stat grid, per-leg confidence + category +
// trap badges, warnings strip, "Load parlay" CTA.
function ComboCard({ slot, liveToday }: { slot: MlbSlateResponse['combos'][number]; liveToday: MlbLiveTodayResponse | null }) {
  if (!slot.combo) {
    return (
      <div className="best-pick-card empty">
        <div className="best-pick-head">
          <div className="best-pick-titles">
            <span className="best-pick-label">{slot.label}</span>
            <span className="best-pick-subtitle">No card</span>
          </div>
        </div>
        <p className="muted small" style={{ padding: '12px 16px' }}>{slot.reason}</p>
      </div>
    );
  }
  const c = slot.combo;
  const payout = FLEX_PAYOUTS[c.size] ?? 1;
  const winProb = c.adjustedCombinedHit / 100;
  const ev = winProb * payout - 1;
  const evVerdict = ev >= 0.05 ? 'Positive EV' : ev <= -0.05 ? 'Negative EV' : 'Neutral EV';
  const evClass = ev >= 0.05 ? 'positive-ev' : ev <= -0.05 ? 'negative-ev' : 'neutral-ev';
  const trapExp = trapExposureLabel(c.averageTrap);
  const mktDisagree = marketDisagreementLabel(c.averageEdge);
  // Average projection gap = mean of |projection − line| / line across legs.
  const projGap =
    c.legs.reduce((sum, l) => sum + Math.abs(l.projection - l.line), 0) / c.legs.length;
  const warnings = computeCardWarnings(c.legs, c.size);

  // Live grading: evaluate each leg against current boxscore stats.
  // When no game is live yet, every leg is PENDING and we render
  // nothing live-related (clean fallback to the static design).
  const grades = c.legs.map((l) => resolveLegLive(liveToday, l));
  const tally = {
    hit: grades.filter((g) => g.grade === 'HIT').length,
    miss: grades.filter((g) => g.grade === 'MISS').length,
    progress: grades.filter((g) => g.grade === 'PROGRESS').length,
    push: grades.filter((g) => g.grade === 'PUSH').length,
  };
  const anyLive = tally.hit + tally.miss + tally.progress + tally.push > 0;
  const cardDead = tally.miss > 0;     // any miss = parlay dead
  const cardCleared = !cardDead && tally.hit === c.legs.length;

  return (
    <div className="best-pick-card">
      <div className="best-pick-head">
        <div className="best-pick-titles">
          <span className="best-pick-label">{c.label}</span>
          <span className="best-pick-subtitle">{c.subtitle}</span>
        </div>
        <span className="best-pick-size">{c.size}-LEG</span>
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
          }}
          title="Live grading — each leg checked against current game stats. ANY miss kills the whole parlay."
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
      <div
        className={`best-pick-ev ${evClass}`}
        title={`Expected value per $1 staked. Win prob ${c.adjustedCombinedHit.toFixed(1)}% × payout ${payout}× − $1 = ${ev >= 0 ? '+' : ''}${ev.toFixed(2)}.`}
      >
        {evVerdict} · {ev >= 0 ? '+' : ''}{ev.toFixed(2)} EV
        <span className="best-pick-ev-payout"> · {payout}× payout</span>
      </div>
      <div className="best-pick-signals">
        <div className="best-pick-signal">
          <span className="muted small">Avg Edge</span>
          <strong className={c.averageEdge >= 10 ? 'pos' : c.averageEdge <= -5 ? 'neg' : ''}>
            {c.averageEdge >= 0 ? '+' : ''}{c.averageEdge.toFixed(1)}%
          </strong>
        </div>
        <div className="best-pick-signal">
          <span className="muted small">Proj Gap</span>
          <strong>+{projGap.toFixed(1)}</strong>
        </div>
        <div className="best-pick-signal">
          <span className="muted small">Trap</span>
          <strong className={`trap-${trapExp.toLowerCase()}`}>{trapExp}</strong>
        </div>
        <div className="best-pick-signal">
          <span className="muted small">Mkt Disagree</span>
          <strong className={`disagree-${mktDisagree.toLowerCase()}`}>{mktDisagree}</strong>
        </div>
      </div>

      <div className="best-pick-legs">
        {c.legs.map((l, i) => {
          const conf = legConfidenceLabel(l.probability);
          const cat = legCategory(l);
          const live = grades[i];
          return (
            <div key={i} className="best-pick-leg-block">
              <div className="best-pick-leg">
                <span className="best-pick-leg-name">{l.playerName}</span>
                <span className="best-pick-leg-stat">
                  {l.statLabel} {l.line}
                </span>
                <span className={`best-pick-leg-dir ${l.direction === 'OVER' ? 'over' : 'under'}`}>
                  {l.direction === 'OVER' ? '↑' : '↓'} {Math.round(l.probability)}%
                </span>
                <span className={`best-pick-leg-conf conf-${conf.toLowerCase()}`}>
                  {conf}
                </span>
              </div>
              <div className="best-pick-leg-evbar">
                <span
                  className={`best-pick-leg-edge ${l.edgePercent >= 5 ? 'pos' : l.edgePercent <= -5 ? 'neg' : 'flat'}`}
                  title="Edge % vs implied break-even. Positive = market underpricing."
                >
                  {l.edgePercent >= 0 ? '+' : ''}{l.edgePercent.toFixed(0)}% edge
                </span>
                {cat && (
                  <span className={`best-pick-leg-cat cat-${cat.toLowerCase().replace(' ', '-')}`}>
                    {cat}
                  </span>
                )}
                {l.trapScore >= 60 && (
                  <span
                    className="best-pick-leg-trap"
                    title={`Trap score ${l.trapScore}. Possible public-trap line.`}
                  >
                    ⚠ {l.trapScore >= 80 ? 'EXTREME TRAP RISK' : 'HIGH TRAP RISK'}
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
            </div>
          );
        })}
      </div>

      {warnings.length > 0 && (
        <div className="best-pick-warnings">
          {warnings.map((w, i) => (
            <span key={i} className="best-pick-warning">⚠ {w}</span>
          ))}
        </div>
      )}

      {c.constructionNotes && (
        <div
          className="muted small"
          style={{ padding: '6px 16px', fontStyle: 'italic' }}
          title="Plain-language summary of what the engine built. Same-player and same-game caps are spec-driven (Phase 28-32)."
        >
          {c.constructionNotes.summary}
        </div>
      )}
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
