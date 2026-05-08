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

import { useState } from 'react';
import {
  buildMlbSlateRequest,
  type MlbSlateResponse,
  type RawMlbSlateLine,
} from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

type ModeKey = 'safe' | 'balanced' | 'aggressive' | 'insane' | 'auto';

const SAMPLE_LINES = `[
  { "playerId": 592450, "statKey": "home_runs", "line": 0.5,  "direction": "over" },
  { "playerId": 660271, "statKey": "hits",       "line": 1.5,  "direction": "both" },
  { "playerId": 545361, "statKey": "total_bases","line": 2.5,  "direction": "both" }
]`;

export function MlbSlate() {
  useTitle(['MLB Slate']);

  const [linesText, setLinesText] = useState(SAMPLE_LINES);
  const [mode, setMode] = useState<ModeKey>('balanced');
  const [result, setResult] = useState<MlbSlateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleBuild() {
    setError(null);
    setResult(null);
    let parsed: RawMlbSlateLine[];
    try {
      parsed = JSON.parse(linesText);
      if (!Array.isArray(parsed)) throw new Error('JSON must be an array.');
      if (parsed.length === 0) throw new Error('No lines provided.');
    } catch (err) {
      setError(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    setLoading(true);
    try {
      const r = await buildMlbSlateRequest(parsed, mode);
      setResult(r);
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
            Tonight's lines (JSON array)
          </label>
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
              {loading ? 'Building…' : 'Build slate'}
            </button>
            <button
              type="button"
              className="mlb-clear-player"
              onClick={() => { setLinesText(SAMPLE_LINES); setResult(null); setError(null); }}
            >
              Reset to sample
            </button>
          </div>
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
      </div>

      <p className="mlb-disclaimer">{data.disclaimer}</p>
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
        <Stat label="Combined hit" value={`${c.rawCombinedHit.toFixed(1)}%`} />
        <Stat label="Avg edge" value={`${c.averageEdge >= 0 ? '+' : ''}${c.averageEdge.toFixed(1)}%`} />
        <Stat label="Avg trap" value={`${c.averageTrap.toFixed(0)}/100`} />
      </div>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="mlb-stat">
      <span className="mlb-stat-label">{label}</span>
      <span className="mlb-stat-value">{value}</span>
    </div>
  );
}
