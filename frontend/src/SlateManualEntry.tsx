import { useEffect, useState } from 'react';
import {
  getTeams,
  getTodayGames,
  getTodaySlate,
  postManualSlate,
  postTodaySlate,
  type EspnScoreboardGame,
  type ManualSlateLine,
  type Player,
  type SlateResponse,
  type Team,
} from './api';
import { isAdminEmail } from './admin';
import { useAuth } from './auth';
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
    const [name, team, statKey, lineStr, dirRaw] = fields;
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
    // 5th field is direction restriction: 'over' (Demon = over-only)
    // / 'under' (Goblin = under-only) / 'both' (standard). Defaults
    // to 'both' if omitted.
    const dirNorm = (dirRaw ?? '').toLowerCase().trim();
    const direction: 'over' | 'under' | 'both' =
      dirNorm === 'over' ? 'over' :
      dirNorm === 'under' ? 'under' : 'both';
    ready.push({
      playerName: name,
      statLabel,
      line: lineNum,
      team: teamCanonical,
      opponentAbbr: null, // filled in below once we know the matchup
      direction,
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
  const auth = useAuth();
  const isAdmin = !!auth.user?.email && isAdminEmail(auth.user.email);

  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [todayGames, setTodayGames] = useState<EspnScoreboardGame[]>([]);
  const [stored, setStored] = useState<StoredSlate | null>(() => loadStoredSlate());
  const [showPaste, setShowPaste] = useState(false);
  const [report, setReport] = useState<ParseReport | null>(null);
  const [autoBuildAttempted, setAutoBuildAttempted] = useState(false);

  // Admin-only — publish today's lines to the backend so every visitor
  // sees them automatically. The secret is held in localStorage so the
  // admin enters it once per browser. Hidden for everyone else.
  const ADMIN_SECRET_KEY = 'slate:admin:secret';
  const [adminSecret, setAdminSecret] = useState<string>(() => {
    try { return localStorage.getItem(ADMIN_SECRET_KEY) ?? ''; } catch { return ''; }
  });
  const [adminText, setAdminText] = useState('');
  const [adminPublishing, setAdminPublishing] = useState(false);
  const [adminMsg, setAdminMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);

  function saveAdminSecret(v: string) {
    setAdminSecret(v);
    try { localStorage.setItem(ADMIN_SECRET_KEY, v); } catch { /* ignore */ }
  }

  async function publishToday() {
    if (!adminSecret.trim()) {
      setAdminMsg({ ok: false, text: 'Admin secret required.' });
      return;
    }
    if (!adminText.trim()) {
      setAdminMsg({ ok: false, text: 'Paste tonight\'s lines first.' });
      return;
    }
    const parsed = parsePasteText(adminText);
    if (parsed.lines.length === 0) {
      setAdminMsg({ ok: false, text: 'No valid lines parsed.' });
      return;
    }
    setAdminPublishing(true);
    setAdminMsg(null);
    try {
      const r = await postTodaySlate(parsed.lines, adminSecret);
      setAdminMsg({
        ok: true,
        text: `Published ${r.count} lines for ${r.date}. Visitors now see this slate.`,
      });
      setAdminText('');
      // Re-fetch the slate so this admin's view also refreshes.
      const today = await getTodaySlate();
      if (today.resolved) {
        const teamSet = new Set<string>();
        for (const l of today.resolved.lines) if (l.team) teamSet.add(l.team);
        setStored({
          lines: today.resolved.lines.map((l) => ({
            playerName: l.playerName,
            statLabel: l.statLabel,
            line: l.line,
            team: l.team ?? undefined,
            opponentAbbr: null,
          })),
          teams: [...teamSet],
        });
        onResult(today.resolved);
      }
    } catch (e) {
      setAdminMsg({ ok: false, text: (e as Error).message });
    } finally {
      setAdminPublishing(false);
    }
  }

  // Today's games rail is now informational only — no click handlers.
  // Helps users orient without becoming a "research" surface.
  useEffect(() => {
    getTodayGames().then((d) => setTodayGames(d.games)).catch(() => setTodayGames([]));
    // Pre-warm the team list so any future hydration uses canonical abbrs.
    getTeams().catch(() => {});
  }, []);

  // Hydration order:
  //   1. Try the global daily slate (admin-published; everyone sees the
  //      same lines). The GET endpoint returns fully-resolved cards in
  //      one round-trip — no second build call needed.
  //   2. Fall back to user's localStorage paste from earlier today.
  //   3. Otherwise show the paste box.
  useEffect(() => {
    if (autoBuildAttempted) return;
    setAutoBuildAttempted(true);
    (async () => {
      try {
        const today = await getTodaySlate();
        if (today.slate && today.resolved && today.resolved.lines.length > 0) {
          // Reflect the published slate in the local-store cache so a
          // refresh-without-network still works.
          const teamSet = new Set<string>();
          for (const l of today.resolved.lines) if (l.team) teamSet.add(l.team);
          setStored({
            lines: today.resolved.lines.map((l) => ({
              playerName: l.playerName,
              statLabel: l.statLabel,
              line: l.line,
              team: l.team ?? undefined,
              opponentAbbr: null,
            })),
            teams: [...teamSet],
          });
          onResult(today.resolved);
          return;
        }
      } catch { /* fall through to local storage */ }
      // Fallback: locally-saved paste from earlier
      if (stored && stored.lines.length > 0) {
        await build(stored.lines);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBuildAttempted]);

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

      {isAdmin && (
        <div className="admin-publish">
          <button
            type="button"
            className="admin-publish-toggle"
            onClick={() => setShowAdmin((s) => !s)}
          >
            <span className="admin-tag">ADMIN</span>
            {showAdmin ? '▾ Hide publish slate' : '▸ Publish tonight\'s slate'}
          </button>
          {showAdmin && (
            <div className="admin-publish-body">
              <p className="muted small" style={{ margin: 0 }}>
                Paste tonight's prop sheet (pipe-delimited, one row per prop).
                Replaces today's published board for every visitor — they
                land on these cards automatically without pasting anything.
              </p>
              <input
                type="password"
                className="admin-secret-input"
                placeholder="Admin secret (saved to your browser)"
                value={adminSecret}
                onChange={(e) => saveAdminSecret(e.target.value)}
              />
              <textarea
                className="bulk-paste-input"
                placeholder={'Jalen Brunson|NYK|points|26.5|both\nJoel Embiid|PHI|points|26.5|both\n…'}
                rows={10}
                value={adminText}
                onChange={(e) => setAdminText(e.target.value)}
                disabled={adminPublishing}
              />
              <div className="bulk-paste-actions">
                <button
                  type="button"
                  className="cta primary"
                  onClick={publishToday}
                  disabled={adminPublishing || !adminText.trim() || !adminSecret.trim()}
                >
                  {adminPublishing ? 'Publishing…' : 'Publish to all visitors →'}
                </button>
                <button
                  type="button"
                  className="cta ghost"
                  onClick={() => { setAdminText(''); setAdminMsg(null); }}
                  disabled={adminPublishing}
                >
                  Clear
                </button>
              </div>
              {adminMsg && (
                <div className={`admin-publish-msg ${adminMsg.ok ? 'ok' : 'err'}`}>
                  {adminMsg.text}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* When no slate is loaded, show a clean message instead of a
          paste box. Pasting now lives exclusively in the ADMIN panel
          above (visible only to admin emails). Regular users wait for
          the admin to publish; once that happens, the page hydrates
          automatically and this empty state goes away. */}
      {!hasSlate && !importing && (
        <div className="slate-empty-state">
          <div className="slate-empty-state-title">
            Tonight's slate hasn't been published yet
          </div>
          <p className="muted">
            Check back soon — once the lines are live you'll see every prop with
            the model's probability on it, plus pre-built parlays at the top.
          </p>
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
