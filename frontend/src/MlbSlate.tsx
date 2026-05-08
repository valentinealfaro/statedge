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
  type MlbSlateResponse,
  type MlbWildCardCombo,
  type RawMlbSlateLine,
} from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

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

  const [linesText, setLinesText] = useState(SAMPLE_LINES);
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

  // Live count for the chip — derived so it updates after every save.
  const memoryCount = useMemo(() => Object.keys(seen).length, [seen]);

  // Persist memory anytime it changes.
  useEffect(() => { saveSeen(seen); }, [seen]);

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
        setError(
          skipped > 0
            ? `All ${skipped} lines were built within the last hour. Use "Force build all" to re-run anyway.`
            : 'No lines provided.',
        );
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
        <h1>MLB · Slate Builder</h1>
        <p className="muted small">
          Paste tonight's lines as JSON. The model projects each leg, then
          builds Safe / Balanced / Aggressive / Insane cards respecting
          per-size eligibility. If a card size can't earn its bar, the
          slot honestly says so — no forced cards.
        </p>

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
              onClick={() => { setLinesText(SAMPLE_LINES); setResult(null); setError(null); }}
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
          {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        </section>

        {loading && <Skeleton width="100%" height={240} style={{ marginTop: 20 }} />}

        {result && <SlateResultView data={result} />}
      </div>
    </div>
  );
}

function SlateResultView({ data }: { data: MlbSlateResponse }) {
  return (
    <div className="mlb-slate-result">
      <div className="mlb-info-banner">
        Mode: <strong>{data.requestedMode}</strong>
        {data.requestedMode === 'auto' && (
          <> · auto-resolved to <strong>{data.resolvedMode}</strong></>
        )}
        {' · '}{data.lineCount} eligible leg{data.lineCount === 1 ? '' : 's'} from your input
      </div>

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
              <span title="L2 momentumExpansionScore: ≥65 = real momentum, ≤35 = anti-momentum.">
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
              {' · '}risk {leg.riskScore}
              {' · '}trap {leg.trapScore}
              {' · '}
              <span title="L2 momentumExpansionScore: production lift + season lift + projection separation + L10 hit rate. ≥65 = real momentum, ≤35 = anti-momentum.">
                momentum {leg.momentumExpansionScore.toFixed(0)}
              </span>
            </div>
          </li>
        ))}
      </ul>
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
