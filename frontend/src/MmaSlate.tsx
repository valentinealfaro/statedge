// /mma/slate — UFC slate paste-and-publish page, Phase 110a.
//
// Two-mode page mirroring MlbSlate. Public visitors see today's
// published UFC props grouped by fighter + stat category, with The
// Odds API moneyline next to each fighter when available. Admins
// click "Admin →", paste their PrizePicks pipe-format slate, preview
// the parse, and publish.
//
// No projection engine yet — that needs a UFC fighter-stat database
// which is its own multi-phase build. This phase ships the foundation:
// parse → store → render with market context. Edge analysis layers
// on later.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getUfcMoneylines,
  getUfcScoreboard,
  getUfcSlateToday,
  parseUfcSlateText,
  publishUfcSlate,
  type UfcDailySlate,
  type UfcMoneylineEvent,
  type UfcSlateParseResult,
  type UfcStoredLine,
} from './api';
import { UfcFighterAvatar } from './Avatar';
import { ClvTrustBanner } from './ClvTrustBanner';
import { LatestNewsRail } from './LatestNewsRail';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

const ADMIN_KEY = 'statedge:mmaSlate:adminSecret';
const MMA_ACCENT = '#ef5350';

export function MmaSlate() {
  useTitle(['UFC Slate']);

  const [today, setToday] = useState<UfcDailySlate | null | undefined>(undefined);
  const [todayDate, setTodayDate] = useState<string | null>(null);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [adminMode, setAdminMode] = useState(false);
  const [moneylines, setMoneylines] = useState<UfcMoneylineEvent[]>([]);
  // Fighter-name → ESPN athlete id, sourced from the scoreboard so we
  // can render UFC headshots on the slate where lines store names but
  // not ids. Misses fall through to initials via the avatar's onError.
  const [fighterIdByName, setFighterIdByName] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    setTodayError(null);
    getUfcSlateToday()
      .then((r) => {
        setToday(r.slate);
        setTodayDate(r.today);
      })
      .catch((err: Error) => setTodayError(err.message));
    getUfcMoneylines()
      .then((r) => setMoneylines(r.events))
      .catch(() => setMoneylines([]));
    // Pull the scoreboard so we can resolve slate fighter names to
    // ESPN athlete ids for avatar rendering. Best-effort: if it fails,
    // FighterCard falls through to the initials avatar.
    getUfcScoreboard()
      .then((r) => {
        const map = new Map<string, string>();
        for (const ev of r.events) {
          for (const f of ev.fights) {
            for (const corner of [f.fighters.red, f.fighters.blue]) {
              if (corner?.id && corner?.displayName) {
                map.set(normalizeName(corner.displayName), corner.id);
              }
            }
          }
        }
        setFighterIdByName(map);
      })
      .catch(() => setFighterIdByName(new Map()));
  }, []);

  // Map fighter name (lowercased + dot-stripped) → moneyline so we
  // can show implied probability next to each fighter group.
  const moneylineByFighter = useMemo(() => {
    const out = new Map<string, { american: number; implied: number }>();
    for (const ev of moneylines) {
      out.set(normalizeName(ev.fighterA.fighterName), {
        american: ev.fighterA.americanOdds, implied: ev.fighterA.impliedProbability,
      });
      out.set(normalizeName(ev.fighterB.fighterName), {
        american: ev.fighterB.americanOdds, implied: ev.fighterB.impliedProbability,
      });
    }
    return out;
  }, [moneylines]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h1 style={{ margin: 0 }}>UFC · Slate</h1>
          <button
            type="button"
            className="mlb-clear-player"
            style={{ fontSize: 12 }}
            onClick={() => setAdminMode((v) => !v)}
          >
            {adminMode ? '← Public view' : 'Admin →'}
          </button>
        </div>

        <p className="muted small" style={{ marginTop: 4, marginBottom: 16 }}>
          Tonight's UFC PrizePicks props with consensus moneylines. Projection engine ships in a later phase — this is the foundation: parse, store, render with market context.
        </p>

        {/* UFC-scoped truth metric. Self-hides until UFC projection
            volume accumulates from the engine that ships in a later
            phase. Once it does, this slate page surfaces UFC-specific
            beat rate without code changes. */}
        <ClvTrustBanner sport="mma" />

        {!adminMode && (
          <PublicTodaySlate
            slate={today === undefined ? null : today}
            todayDate={todayDate}
            error={todayError}
            moneylineByFighter={moneylineByFighter}
            fighterIdByName={fighterIdByName}
            loading={today === undefined}
          />
        )}

        {adminMode && (
          <AdminPublishForm onPublished={(d) => { setToday(d); setTodayDate(d.publishedDate); }} />
        )}

        <LatestNewsRail sport="mma" limit={4} heading="UFC News & Recaps" />
      </div>
    </div>
  );
}

// ---------- Public view ----------

function PublicTodaySlate({
  slate,
  todayDate,
  error,
  moneylineByFighter,
  fighterIdByName,
  loading,
}: {
  slate: UfcDailySlate | null;
  todayDate: string | null;
  error: string | null;
  moneylineByFighter: Map<string, { american: number; implied: number }>;
  fighterIdByName: Map<string, string>;
  loading: boolean;
}) {
  if (error) {
    return <div className="mlb-info-banner mlb-info-error">{error}</div>;
  }
  if (loading) {
    return <Skeleton width="100%" height={320} />;
  }
  if (!slate || slate.lines.length === 0) {
    return (
      <div className="muted small" style={{ padding: '24px 12px', fontStyle: 'italic' }}>
        No UFC slate published yet. Click <strong>Admin →</strong> to paste tonight's lines.
      </div>
    );
  }

  const isStale = todayDate && slate.publishedDate !== todayDate;
  const byFighter = groupLinesByFighter(slate.lines);
  const fighters = [...byFighter.keys()].sort();

  return (
    <div>
      {isStale && (
        <div className="mlb-info-banner" style={{ marginBottom: 12, fontSize: 12 }}>
          Showing the most recent published UFC slate ({slate.publishedDate}). No new card has been published for {todayDate}.
        </div>
      )}
      <div className="muted small" style={{ marginBottom: 12 }}>
        {fighters.length} fighters · {slate.lines.length} props · published {new Date(slate.publishedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {fighters.map((name) => {
          const lines = byFighter.get(name)!;
          const ml = moneylineByFighter.get(normalizeName(name));
          const athleteId = fighterIdByName.get(normalizeName(name)) ?? '';
          return <FighterCard key={name} name={name} athleteId={athleteId} lines={lines} moneyline={ml} />;
        })}
      </div>
    </div>
  );
}

function FighterCard({ name, athleteId, lines, moneyline }: {
  name: string;
  athleteId: string;
  lines: UfcStoredLine[];
  moneyline?: { american: number; implied: number };
}) {
  const grouped = groupLinesByCategory(lines);
  const profileLink = athleteId ? `/mma/fighter/${athleteId}` : null;

  return (
    <div style={{
      padding: 14,
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(239,83,80,0.2)',
      borderLeft: `3px solid ${MMA_ACCENT}`,
      borderRadius: 6,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {profileLink ? (
            <Link to={profileLink} style={{ flexShrink: 0, lineHeight: 0 }}>
              <UfcFighterAvatar athleteId={athleteId} name={name} size="sm" />
            </Link>
          ) : (
            <UfcFighterAvatar athleteId={athleteId} name={name} size="sm" />
          )}
          {profileLink ? (
            <Link to={profileLink} style={{ color: 'inherit', textDecoration: 'none' }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{name}</h3>
            </Link>
          ) : (
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{name}</h3>
          )}
        </div>
        {moneyline && (
          <span style={{
            padding: '3px 8px',
            background: 'rgba(255,255,255,0.06)',
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 700,
            color: moneyline.american < 0 ? '#7aa2ff' : '#ffd54f',
          }}>
            ML {moneyline.american > 0 ? `+${moneyline.american}` : moneyline.american} · {Math.round(moneyline.implied * 100)}%
          </span>
        )}
      </div>

      {(['volume', 'duration', 'fantasy'] as const).map((group) => {
        const groupLines = grouped[group];
        if (groupLines.length === 0) return null;
        return (
          <div key={group} style={{ marginTop: 6 }}>
            <div className="muted small" style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
              {GROUP_LABEL[group]}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6 }}>
              {groupLines.map((l, i) => <PropChip key={i} line={l} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PropChip({ line }: { line: UfcStoredLine }) {
  const dirColor =
    line.direction === 'over'  ? '#66bb6a'
    : line.direction === 'under' ? '#ef5350'
    : 'rgba(255,255,255,0.5)';
  const dirSymbol =
    line.direction === 'over'  ? '↑'
    : line.direction === 'under' ? '↓'
    : '↕';
  return (
    <div style={{
      padding: '6px 10px',
      background: 'rgba(0,0,0,0.2)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 4,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 8,
    }}>
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>
        {STAT_LABEL[line.statKey] ?? line.statKey}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: dirColor, whiteSpace: 'nowrap' }}>
        {dirSymbol} {line.line}
      </span>
    </div>
  );
}

// ---------- Admin form ----------

function AdminPublishForm({ onPublished }: { onPublished: (slate: UfcDailySlate) => void }) {
  const [adminSecret, setAdminSecret] = useState<string>(() => {
    try { return localStorage.getItem(ADMIN_KEY) ?? ''; } catch { return ''; }
  });
  const [text, setText] = useState<string>('');
  const [preview, setPreview] = useState<UfcSlateParseResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (adminSecret.trim().length > 0) {
      try { localStorage.setItem(ADMIN_KEY, adminSecret); } catch { /* ignore quota errors */ }
    }
  }, [adminSecret]);

  async function handlePreview() {
    if (!text.trim()) return;
    setPreviewing(true);
    setError(null);
    try {
      const result = await parseUfcSlateText(text);
      setPreview(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  async function handlePublish() {
    if (!text.trim()) return;
    if (!adminSecret.trim()) {
      setError('Admin secret required.');
      return;
    }
    setPublishing(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await publishUfcSlate({ text, adminSecret });
      setSuccess(`Published ${result.published} props for ${result.date}.`);
      // Re-fetch the just-published slate so the public view above shows it.
      const next = await getUfcSlateToday();
      if (next.slate) onPublished(next.slate);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <label className="mlb-label" htmlFor="mma-admin-secret">Admin secret</label>
        <input
          id="mma-admin-secret"
          type="password"
          className="mlb-stat-select"
          value={adminSecret}
          onChange={(e) => setAdminSecret(e.target.value)}
          placeholder="x-admin-secret header value"
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label className="mlb-label" htmlFor="mma-slate-text">UFC pipe-format slate</label>
        <textarea
          id="mma-slate-text"
          className="mlb-stat-select"
          rows={14}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Khamzat Chimaev|UFC|sig_strikes|46.5|both"
          style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
        />
        <div className="muted small" style={{ fontSize: 11, marginTop: 4 }}>
          Format: <code>FighterName|UFC|stat_key|line|sides</code>. Sides = over / under / both.
          Supported stat keys: sig_strikes, rd1_sig_strikes, takedowns (td), rd1_takedowns,
          knockdowns (kd), rounds, fight_time, fantasy_score (fs), control_time. Lines
          starting with # are ignored.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" className="cta" onClick={handlePreview} disabled={previewing || !text.trim()}>
          {previewing ? 'Parsing…' : 'Preview parse'}
        </button>
        <button
          type="button"
          className="cta primary"
          onClick={handlePublish}
          disabled={publishing || !text.trim() || !adminSecret.trim()}
          style={{ background: MMA_ACCENT }}
        >
          {publishing ? 'Publishing…' : 'Publish UFC slate'}
        </button>
      </div>

      {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
      {success && <div className="mlb-info-banner" style={{ borderColor: '#66bb6a', color: '#66bb6a' }}>{success}</div>}

      {preview && (
        <div style={{ marginTop: 12 }}>
          <div className="muted small" style={{ marginBottom: 6 }}>
            <strong>{preview.lines.length}</strong> props parsed · <strong>{preview.unresolved.length}</strong> errors · {preview.skippedComments} comments · {preview.skippedBlanks} blanks
          </div>
          {preview.unresolved.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: '#ef5350', fontWeight: 700 }}>
                {preview.unresolved.length} unresolved row{preview.unresolved.length === 1 ? '' : 's'}
              </summary>
              <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 11 }}>
                {preview.unresolved.map((u, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    <code style={{ color: 'rgba(255,255,255,0.6)' }}>{u.rawLine}</code> — <span style={{ color: '#ef5350' }}>{u.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- helpers ----------

const STAT_LABEL: Record<string, string> = {
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

const GROUP_LABEL: Record<'volume' | 'duration' | 'fantasy', string> = {
  volume:   'Volume',
  duration: 'Fight Length',
  fantasy:  'Fantasy',
};

const STAT_GROUP: Record<string, 'volume' | 'duration' | 'fantasy'> = {
  sig_strikes:     'volume',
  rd1_sig_strikes: 'volume',
  takedowns:       'volume',
  rd1_takedowns:   'volume',
  knockdowns:      'volume',
  control_time:    'volume',
  rounds:          'duration',
  fight_time:      'duration',
  fantasy_score:   'fantasy',
};

function groupLinesByFighter(lines: UfcStoredLine[]): Map<string, UfcStoredLine[]> {
  const out = new Map<string, UfcStoredLine[]>();
  for (const l of lines) {
    const arr = out.get(l.fighterName) ?? [];
    arr.push(l);
    out.set(l.fighterName, arr);
  }
  return out;
}

function groupLinesByCategory(lines: UfcStoredLine[]): {
  volume: UfcStoredLine[]; duration: UfcStoredLine[]; fantasy: UfcStoredLine[];
} {
  const out: { volume: UfcStoredLine[]; duration: UfcStoredLine[]; fantasy: UfcStoredLine[] } = {
    volume: [], duration: [], fantasy: [],
  };
  for (const l of lines) {
    const g = STAT_GROUP[l.statKey] ?? 'volume';
    out[g].push(l);
  }
  return out;
}

function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

// Suppress unused-import lint when Link isn't actively rendered; it's
// kept so a "Back to /mma" link can be added later without re-importing.
void Link;
