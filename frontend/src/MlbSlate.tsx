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
  rebuildMlbDailySlate,
  setMlbDailySlate,
  type MlbDailySlateResponse,
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

        {/* Tonight's MLB games rail — auto-refreshes every 60s during
            live games so the slate page becomes a live-tracker
            surface as games progress. */}
        <MlbTodaysGames />

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

      <div className="mlb-slate-grid">
        {data.combos.map((slot) => (
          <ComboCard key={slot.size} slot={slot} />
        ))}
        <WildCardCard wildCard={data.wildCard} />
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

// Wild Card card — different visual treatment from the size-numbered
// cards because it's NOT a size slot, it's a tier-classified extra.
// Renders empty-state cleanly when the chain falls through to no_edge.
function WildCardCard({ wildCard }: { wildCard: MlbWildCardCombo }) {
  const kindLabel =
    wildCard.kind === 'standard' ? 'Standard'
    : wildCard.kind === 'near_miss' ? 'Near Miss'
    : wildCard.kind === 'momentum' ? 'Momentum'
    : wildCard.kind === 'matchup_spike' ? 'Matchup Spike'
    : wildCard.kind === 'high_variance' ? 'High Variance'
    : 'No Edge';
  const kindClass = `wild-kind-${wildCard.kind.replace('_', '-')}`;

  if (wildCard.kind === 'no_edge') {
    return (
      <div className="mlb-slate-card mlb-wild-card empty">
        <div className="mlb-slate-card-head">
          <span className="mlb-slate-card-label">Wild Card</span>
          <span className={`mlb-wild-kind ${kindClass}`}>{kindLabel}</span>
        </div>
        <p className="mlb-slate-card-empty-reason">
          {wildCard.subtitle}. No tier qualified — closest candidates by
          projection separation are below.
        </p>
        {wildCard.closestCandidates && wildCard.closestCandidates.length > 0 && (
          <ul className="mlb-slate-legs">
            {wildCard.closestCandidates.map((leg, i) => (
              <li key={i} className="mlb-slate-leg">
                <div className="mlb-slate-leg-row">
                  <span className="mlb-slate-leg-name">{leg.playerName}</span>
                  <span className="mlb-slate-leg-stat">
                    {leg.statLabel} {leg.direction === 'OVER' ? '↑' : '↓'} {leg.line}
                  </span>
                  <span className="mlb-slate-leg-prob">{leg.probability.toFixed(0)}%</span>
                </div>
                <div className="mlb-slate-leg-edge">{leg.wildCardReason}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="mlb-slate-card mlb-wild-card">
      <div className="mlb-slate-card-head">
        <span className="mlb-slate-card-label">Wild Card</span>
        <span className={`mlb-wild-kind ${kindClass}`}>{kindLabel}</span>
        <span className="mlb-slate-card-subtitle">{wildCard.subtitle}</span>
      </div>
      <div className="mlb-slate-card-summary">
        <Stat
          label="Adjusted hit"
          value={`${wildCard.adjustedCombinedHit.toFixed(1)}%`}
          hint={wildCard.correlationPairs > 0
            ? `Raw ${wildCard.rawCombinedHit.toFixed(1)}% × correlation penalty (${wildCard.correlationRisk})`
            : `No correlated stacks.`}
        />
        <Stat label="Avg edge" value={`${wildCard.averageEdge >= 0 ? '+' : ''}${wildCard.averageEdge.toFixed(1)}%`} />
        <Stat label="Avg trap" value={`${wildCard.averageTrap.toFixed(0)}/100`} />
        {wildCard.averageWildCardScore !== undefined && (
          <Stat
            label="WC score"
            value={`${wildCard.averageWildCardScore.toFixed(0)}/100`}
            hint="Phase 29 spec composite: projGap×0.25 + momentum×0.25 + matchup×0.15 + marketLag×0.15 + upside×0.10 - trap×0.10. ≥60 = real institutional edge tonight."
          />
        )}
      </div>
      {wildCard.correlationRisk !== 'None' && (
        <div className={`mlb-correlation-chip corr-${wildCard.correlationRisk.toLowerCase().replace(' ', '-')}`}
             title="Same-game / same-team leg pairs share game-script risk.">
          ⚠ {wildCard.correlationRisk} correlation · {wildCard.correlationPairs} pair{wildCard.correlationPairs === 1 ? '' : 's'}
        </div>
      )}
      <ul className="mlb-slate-legs">
        {wildCard.legs.map((leg, i) => (
          <li key={i} className="mlb-slate-leg">
            <div className="mlb-slate-leg-row">
              <span className="mlb-slate-leg-name">{leg.playerName}</span>
              <span className="mlb-slate-leg-stat">
                {leg.statLabel} {leg.direction === 'OVER' ? '↑' : '↓'} {leg.line}
              </span>
              <span className="mlb-slate-leg-prob">{leg.probability.toFixed(0)}%</span>
            </div>
            <div className="mlb-slate-leg-edge">
              {leg.wildCardReason}
              {' · '}
              <span title={`L5 Fragility — ${leg.fragilityTier}.`}>
                fragility {leg.fragilityScore.toFixed(0)}
              </span>
              {' · '}
              <span title="L2 momentumExpansionScore: ≥65 = real momentum.">
                momentum {leg.momentumExpansionScore.toFixed(0)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ComboCard({ slot }: { slot: MlbSlateResponse['combos'][number] }) {
  if (!slot.combo) {
    return (
      <div className="mlb-slate-card empty">
        <div className="mlb-slate-card-head">
          <span className="mlb-slate-card-label">{slot.label}</span>
          <span className="mlb-slate-card-empty-tag">No card</span>
        </div>
        <p className="mlb-slate-card-empty-reason">{slot.reason}</p>
      </div>
    );
  }
  const c = slot.combo;
  return (
    <div className="mlb-slate-card">
      <div className="mlb-slate-card-head">
        <span className="mlb-slate-card-label">{c.label}</span>
        <span className="mlb-slate-card-subtitle">{c.subtitle}</span>
      </div>
      <div className="mlb-slate-card-summary">
        <Stat
          label="Adjusted hit"
          value={`${c.adjustedCombinedHit.toFixed(1)}%`}
          hint={c.correlationPairs > 0
            ? `Raw ${c.rawCombinedHit.toFixed(1)}% × correlation penalty (${c.correlationRisk}, ${c.correlationPairs} same-game pair${c.correlationPairs === 1 ? '' : 's'})`
            : `No correlated stacks — independent legs.`}
        />
        <Stat label="Avg edge" value={`${c.averageEdge >= 0 ? '+' : ''}${c.averageEdge.toFixed(1)}%`} />
        <Stat label="Avg trap" value={`${c.averageTrap.toFixed(0)}/100`} />
      </div>
      {c.correlationRisk !== 'None' && (
        <div className={`mlb-correlation-chip corr-${c.correlationRisk.toLowerCase().replace(' ', '-')}`}
             title="Same-game / same-team leg pairs share game-script risk. Adjusted hit % already accounts for this.">
          ⚠ {c.correlationRisk} correlation · {c.correlationPairs} pair{c.correlationPairs === 1 ? '' : 's'}
        </div>
      )}
      <ul className="mlb-slate-legs">
        {c.legs.map((leg, i) => (
          <li key={i} className="mlb-slate-leg">
            <div className="mlb-slate-leg-row">
              <span className="mlb-slate-leg-name">{leg.playerName}</span>
              <span className="mlb-slate-leg-stat">
                {leg.statLabel} {leg.direction === 'OVER' ? '↑' : '↓'} {leg.line}
              </span>
              <span className="mlb-slate-leg-prob">{leg.probability.toFixed(0)}%</span>
            </div>
            <div className="mlb-slate-leg-edge">
              edge {leg.edgePercent >= 0 ? '+' : ''}{leg.edgePercent.toFixed(1)}%
              {' · '}trap {leg.trapScore}
              {' · '}
              <span title={`L5 Fragility — ${leg.fragilityTier}. How little must go wrong for this leg to fail. SEPARATE from probability + trap.`}>
                fragility {leg.fragilityScore.toFixed(0)}
              </span>
              {' · '}
              <span title="L2 momentumExpansionScore: ≥65 = real momentum, ≤35 = anti-momentum.">
                momentum {leg.momentumExpansionScore.toFixed(0)}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {c.constructionNotes && (
        <div
          className="muted small"
          style={{ marginTop: 8, fontStyle: 'italic' }}
          title="Plain-language summary of what the engine built. Same-player and same-game caps are spec-driven (Phase 28-32) — diversification is a feature, not noise."
        >
          {c.constructionNotes.summary}
        </div>
      )}
      <div className="mlb-slate-card-weakest">
        ⚠ Weakest leg: <strong>{c.weakestLegName}</strong> — {c.weakestLegReason}
      </div>
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
