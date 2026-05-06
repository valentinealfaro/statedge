import { useEffect, useState } from 'react';
import {
  getTeams,
  getTodayGames,
  postManualSlate,
  type EspnScoreboardGame,
  type ManualSlateLine,
  type Player,
  type SlateResponse,
  type Team,
} from './api';
import { TeamLogo } from './Avatar';
import { userKey } from './userKey';

// New /slate experience: a prop-board entry. The user pastes (or has
// previously pasted) tonight's prop sheet — we parse it, fire the
// backend in one round-trip, and the parent renders the cards. The
// slot/roster/search UX is gone — the only thing the user does on
// /slate now is supply lines and tap cards to build a 6-leg parlay.

// ESPN sometimes uses shorter franchise abbrs (NY/SA/GS/NO/WSH/UTAH);
// our DB uses NBA stats.com 3-letter forms (NYK/SAS/GSW/...).
const ESPN_TO_NBA_ABBR: Record<string, string> = {
  NY: 'NYK', SA: 'SAS', GS: 'GSW', NO: 'NOP', WSH: 'WAS', UTAH: 'UTA',
};

// Stat-key aliases for the bulk-paste parser. Same set as before.
const PASTE_STAT_TO_LABEL: Record<string, string> = {
  points: 'Points', pts: 'Points',
  rebounds: 'Rebounds', reb: 'Rebounds', rebs: 'Rebounds',
  assists: 'Assists', ast: 'Assists', asts: 'Assists',
  three_pt_made: '3-PT Made', '3pt_made': '3-PT Made', '3pm': '3-PT Made',
  fg_made: 'FG Made', fgm: 'FG Made',
  fg_attempted: 'FG Attempted', fga: 'FG Attempted',
  ft_made: 'Free Throws Made', ftm: 'Free Throws Made',
  ft_attempted: 'Free Throws Attempted', fta: 'Free Throws Attempted',
  personal_fouls: 'Personal Fouls', pf: 'Personal Fouls',
  steals: 'Steals', stl: 'Steals',
  blocks: 'Blocked Shots', blk: 'Blocked Shots',
  turnovers: 'Turnovers', tov: 'Turnovers', to: 'Turnovers',
  offensive_rebounds: 'Offensive Rebounds', oreb: 'Offensive Rebounds',
  defensive_rebounds: 'Defensive Rebounds', dreb: 'Defensive Rebounds',
  pra: 'Pts+Rebs+Asts',
  pr: 'Pts+Rebs',
  pa: 'Pts+Asts',
  ra: 'Rebs+Asts',
  stocks: 'Blks+Stls',
  double_double: 'Double-Double', dd: 'Double-Double',
};

// Persisted state. We store the raw ManualSlateLine[] (not the legacy
// "slot" shape) so today's slate hydrates straight back into the
// backend on the next visit.
type StoredSlate = {
  lines: ManualSlateLine[];
  // Cached for the matchup banner so we don't have to re-derive it.
  teams: string[];
};

function slateStorageKey(): string {
  const today = new Date().toISOString().slice(0, 10);
  return userKey(`slate:saved:${today}`);
}

function loadStoredSlate(): StoredSlate | null {
  try {
    const raw = localStorage.getItem(slateStorageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Accept both the new {lines, teams} shape AND the legacy slot
    // array shape so a previously-saved slate still hydrates.
    if (Array.isArray(parsed)) {
      // Legacy: array of stored slots → flatten to lines.
      const lines: ManualSlateLine[] = [];
      const teamSet = new Set<string>();
      for (const s of parsed) {
        if (!s.player) continue;
        const team = (s.player as Player).teamAbbreviation ?? undefined;
        if (team) teamSet.add(team);
        for (const [statLabel, raw] of Object.entries(s.lines ?? {})) {
          const lineNum = parseFloat(raw as string);
          if (!Number.isFinite(lineNum) || lineNum <= 0) continue;
          lines.push({
            playerName: (s.player as Player).fullName,
            statLabel,
            line: lineNum,
            team,
            opponentAbbr: (s.opponent as Team | null)?.abbreviation ?? null,
          });
        }
      }
      return lines.length > 0 ? { lines, teams: [...teamSet] } : null;
    }
    if (parsed?.lines && Array.isArray(parsed.lines)) {
      return parsed as StoredSlate;
    }
    return null;
  } catch {
    return null;
  }
}

function saveStoredSlate(s: StoredSlate): void {
  try {
    if (s.lines.length === 0) {
      localStorage.removeItem(slateStorageKey());
    } else {
      localStorage.setItem(slateStorageKey(), JSON.stringify(s));
    }
  } catch { /* quota / disabled — ignore */ }
}

type ParseReport = {
  lines: ManualSlateLine[];
  teams: string[];
  errors: { line: string; reason: string }[];
};

function parsePasteText(text: string): ParseReport {
  const errors: { line: string; reason: string }[] = [];
  const ready: ManualSlateLine[] = [];
  const teamSet = new Set<string>();
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  for (const raw of rows) {
    const fields = raw.split(/[|\t]/).map((f) => f.trim());
    if (fields.length < 4) {
      errors.push({ line: raw, reason: 'expected at least 4 fields (Player|Team|stat|line)' });
      continue;
    }
    const [name, team, statKey, lineStr] = fields;
    const statLabel = PASTE_STAT_TO_LABEL[statKey.toLowerCase()];
    if (!statLabel) {
      errors.push({ line: raw, reason: `unknown stat "${statKey}"` });
      continue;
    }
    const lineNum = parseFloat(lineStr);
    if (!Number.isFinite(lineNum)) {
      errors.push({ line: raw, reason: `invalid line value "${lineStr}"` });
      continue;
    }
    const teamCanonical = ESPN_TO_NBA_ABBR[team.toUpperCase()] ?? team.toUpperCase();
    teamSet.add(teamCanonical);
    ready.push({
      playerName: name,
      statLabel,
      line: lineNum,
      team: teamCanonical,
      opponentAbbr: null, // filled in below once we know the matchup
    });
  }

  const teams = [...teamSet];
  // Auto-pair opponents when exactly two teams are pasted.
  if (teams.length === 2) {
    const [a, b] = teams;
    for (const l of ready) {
      l.opponentAbbr = l.team === a ? b : a;
    }
  }

  return { lines: ready, teams, errors };
}

type Props = {
  onResult: (response: SlateResponse) => void;
};

export function SlateManualEntry({ onResult }: Props) {
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [todayGames, setTodayGames] = useState<EspnScoreboardGame[]>([]);
  const [stored, setStored] = useState<StoredSlate | null>(() => loadStoredSlate());
  const [showPaste, setShowPaste] = useState(false);
  const [report, setReport] = useState<ParseReport | null>(null);
  // Used to make sure auto-build only fires once per mount, not on every
  // re-render.
  const [autoBuildAttempted, setAutoBuildAttempted] = useState(false);

  // Today's games rail is now informational only — no click handlers.
  // Helps users orient without becoming a "research" surface.
  useEffect(() => {
    getTodayGames().then((d) => setTodayGames(d.games)).catch(() => setTodayGames([]));
    // Pre-warm the team list so any future hydration uses canonical abbrs.
    getTeams().catch(() => {});
  }, []);

  // Auto-build on hydration: if we have a saved slate, immediately
  // fire it through the backend so the user lands on the cards.
  useEffect(() => {
    if (autoBuildAttempted) return;
    if (!stored || stored.lines.length === 0) {
      setAutoBuildAttempted(true);
      return;
    }
    setAutoBuildAttempted(true);
    void build(stored.lines);
    // We deliberately exclude `build` from the deps — it's stable
    // enough for this single-shot effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, autoBuildAttempted]);

  async function build(lines: ManualSlateLine[]) {
    if (lines.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const response = await postManualSlate(lines);
      onResult(response);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  async function importPaste() {
    if (!text.trim()) return;
    const parsed = parsePasteText(text);
    setReport(parsed);
    if (parsed.lines.length === 0) {
      setError('No valid lines in the pasted text.');
      return;
    }
    const next: StoredSlate = { lines: parsed.lines, teams: parsed.teams };
    setStored(next);
    saveStoredSlate(next);
    setShowPaste(false);
    setText('');
    await build(parsed.lines);
  }

  function clearSlate() {
    if (!confirm("Clear today's saved slate and start fresh?")) return;
    try { localStorage.removeItem(slateStorageKey()); } catch { /* ignore */ }
    setStored(null);
    setReport(null);
    setText('');
    setError(null);
    setShowPaste(true);
  }

  const hasSlate = (stored?.lines.length ?? 0) > 0;

  return (
    <div className="manual-entry">
      {todayGames.length > 0 && (
        <div className="today-rail informational">
          <div className="today-rail-head">
            <span className="recents-title">Tonight's games</span>
          </div>
          <div className="today-rail-list">
            {todayGames.map((g) => (
              <div key={g.id} className="today-game">
                <div className="today-game-status">{g.status.detail}</div>
                <div className="today-side static">
                  <TeamLogo abbr={g.away.abbreviation} name={g.away.displayName} size="md" />
                  <span className="today-side-abbr">{g.away.abbreviation}</span>
                  {g.away.record && <span className="muted small">{g.away.record}</span>}
                </div>
                <span className="today-at">@</span>
                <div className="today-side static">
                  <TeamLogo abbr={g.home.abbreviation} name={g.home.displayName} size="md" />
                  <span className="today-side-abbr">{g.home.abbreviation}</span>
                  {g.home.record && <span className="muted small">{g.home.record}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="propboard-status">
        {hasSlate ? (
          <>
            <div className="propboard-status-info">
              <strong>Today's prop board loaded.</strong>{' '}
              <span className="muted small">
                {stored!.lines.length} line{stored!.lines.length === 1 ? '' : 's'}
                {stored!.teams.length > 0 && ` · ${stored!.teams.join(' vs ')}`}
              </span>
              {importing && <span className="muted small"> · re-running…</span>}
            </div>
            <div className="propboard-status-actions">
              <button
                type="button"
                className="cta"
                onClick={() => setShowPaste((s) => !s)}
              >
                {showPaste ? 'Hide paste' : 'Paste new sheet'}
              </button>
              <button
                type="button"
                className="cta ghost"
                onClick={clearSlate}
              >
                Clear
              </button>
            </div>
          </>
        ) : (
          <div className="propboard-status-info">
            <strong>No prop board loaded yet.</strong>{' '}
            <span className="muted small">
              Paste tonight's lines to see the model's verdict on every prop and start building a parlay.
            </span>
          </div>
        )}
      </div>

      {(showPaste || !hasSlate) && (
        <div className="bulk-paste expanded">
          <p className="muted small" style={{ marginTop: 0 }}>
            Format: <code>Player|Team|stat|line</code> — one row per prop.
            Stats: <code>points</code>, <code>rebounds</code>, <code>assists</code>,{' '}
            <code>pra</code>, <code>pr</code>, <code>pa</code>, <code>ra</code>,{' '}
            <code>three_pt_made</code>, <code>fg_made</code>, <code>fg_attempted</code>,{' '}
            <code>ft_made</code>, <code>ft_attempted</code>, <code>steals</code>,{' '}
            <code>blocks</code>, <code>turnovers</code>, <code>stocks</code>,{' '}
            <code>personal_fouls</code>, <code>offensive_rebounds</code>,{' '}
            <code>defensive_rebounds</code>, <code>double_double</code>.
          </p>
          <textarea
            className="bulk-paste-input"
            placeholder={'Jalen Brunson|NYK|points|26.5|both\nKarl-Anthony Towns|NYK|rebounds|11|both\n…'}
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={importing}
          />
          <div className="bulk-paste-actions">
            <button
              type="button"
              className="cta primary"
              onClick={importPaste}
              disabled={importing || !text.trim()}
            >
              {importing ? 'Building…' : 'Build prop board →'}
            </button>
            {hasSlate && (
              <button
                type="button"
                className="cta"
                onClick={() => { setText(''); setShowPaste(false); }}
                disabled={importing}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {report && report.errors.length > 0 && (
        <div className="bulk-paste-report warn">
          <strong>
            {report.lines.length} parsed, {report.errors.length} skipped.
          </strong>
          <details style={{ marginTop: 4 }}>
            <summary>Show skipped rows</summary>
            <ul className="bulk-paste-errors">
              {report.errors.slice(0, 20).map((e, i) => (
                <li key={i}>
                  {e.line && <code>{e.line}</code>} {e.reason}
                </li>
              ))}
              {report.errors.length > 20 && (
                <li className="muted">…and {report.errors.length - 20} more</li>
              )}
            </ul>
          </details>
        </div>
      )}

      {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}

      {importing && !error && (
        <div className="propboard-loading muted small">
          Computing probability for every line — typically takes 1-2 seconds…
        </div>
      )}
    </div>
  );
}
