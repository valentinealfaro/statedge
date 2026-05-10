// /mma/slate — UFC slate paste-and-publish page, Phase 110a + 148r.
//
// Two-mode page mirroring MlbSlate. Public visitors see today's
// published UFC props grouped by fighter + stat category, with The
// Odds API moneyline next to each fighter when available. Admins
// click "Admin →", paste their PrizePicks pipe-format slate, preview
// the parse, and publish.
//
// Projections: Phase 136 shipped the moneyline-anchored heuristic
// (mma/projectionEngine.projectUfcProp), Phase 148q exposed it via
// /api/mma/slate/projections, and this page now consumes that
// endpoint to render per-prop edge / probability badges. NOT a
// fundamental fighter-stat engine — those numbers are conservative
// market-anchored estimates; honest about its limits via a small
// note in the section header. The deeper fundamental engine lands
// when the fighter-stat database ships.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getUfcMoneylines,
  getUfcScoreboard,
  getUfcSlateProjections,
  getUfcSlateToday,
  parseUfcSlateText,
  publishUfcSlate,
  type UfcDailySlate,
  type UfcMoneylineEvent,
  type UfcSlateParseResult,
  type UfcSlateProjection,
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

// Per-fighter scoreboard pairing — opponent + fight metadata. Used to
// surface the matchup chip ("vs Imavov · main event") on each
// FighterCard plus a deep link into /mma/event/:event/fight/:fight.
type FighterMatchup = {
  opponentName: string;
  opponentId: string | null;
  eventId: string;
  fightId: string;
  fightState: 'pre' | 'in' | 'post';
  isMain: boolean;
  isTitle: boolean;
};

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
  // Fighter-name → tonight's matchup. Sourced from the same scoreboard
  // pull so that each FighterCard can show "vs Opponent" with a deep
  // link to the fight detail page. Carries fightState so live fights
  // get a red dot and finished fights are dimmed.
  const [matchupByFighter, setMatchupByFighter] = useState<Map<string, FighterMatchup>>(new Map());
  // Per-line projection lookup, keyed by `${fighterNameNorm}|${statKey}|${line}|${direction}`.
  // The endpoint may return fewer projections than slate.lines (lines
  // missing scoreboard pairing are honestly skipped) — we just render
  // the chip without an edge badge in those cases.
  const [projByKey, setProjByKey] = useState<Map<string, UfcSlateProjection>>(new Map());

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
    // Best-effort projections fetch. Failures (empty slate, missing
    // scoreboard, etc.) just leave the chips without edge badges —
    // the page still renders the raw slate. 5-minute cache server-
    // side absorbs any retry burst.
    getUfcSlateProjections()
      .then((r) => {
        const m = new Map<string, UfcSlateProjection>();
        for (const p of r.projections) {
          m.set(projKey(p.fighterName, p.statKey, p.line, p.direction), p);
        }
        setProjByKey(m);
      })
      .catch(() => setProjByKey(new Map()));
    // Pull the scoreboard so we can resolve slate fighter names to
    // ESPN athlete ids for avatar rendering AND pair each fighter with
    // tonight's opponent. Best-effort: if it fails, FighterCard falls
    // through to the initials avatar with no matchup chip.
    getUfcScoreboard()
      .then((r) => {
        const idMap = new Map<string, string>();
        const matchups = new Map<string, FighterMatchup>();
        for (const ev of r.events) {
          for (const f of ev.fights) {
            const red = f.fighters.red;
            const blue = f.fighters.blue;
            if (red?.id && red?.displayName) idMap.set(normalizeName(red.displayName), red.id);
            if (blue?.id && blue?.displayName) idMap.set(normalizeName(blue.displayName), blue.id);
            // Pair each corner with the opposite corner. Skip fights
            // where one side is missing (rare but happens for late
            // replacements that haven't propagated to the scoreboard).
            if (red?.displayName && blue?.displayName) {
              matchups.set(normalizeName(red.displayName), {
                opponentName: blue.displayName,
                opponentId: blue.id ?? null,
                eventId: ev.id,
                fightId: f.id,
                fightState: f.state,
                isMain: f.isMain,
                isTitle: f.isTitle,
              });
              matchups.set(normalizeName(blue.displayName), {
                opponentName: red.displayName,
                opponentId: red.id ?? null,
                eventId: ev.id,
                fightId: f.id,
                fightState: f.state,
                isMain: f.isMain,
                isTitle: f.isTitle,
              });
            }
          }
        }
        setFighterIdByName(idMap);
        setMatchupByFighter(matchups);
      })
      .catch(() => {
        setFighterIdByName(new Map());
        setMatchupByFighter(new Map());
      });
  }, []);

  // Map fighter name → moneyline. Carries both raw and fair (de-vigged)
  // probabilities so the card can show the bookmaker-honest number.
  const moneylineByFighter = useMemo(() => {
    const out = new Map<string, { american: number; implied: number; fair: number }>();
    for (const ev of moneylines) {
      out.set(normalizeName(ev.fighterA.fighterName), {
        american: ev.fighterA.americanOdds,
        implied: ev.fighterA.impliedProbability,
        fair: ev.fighterA.fairProbability,
      });
      out.set(normalizeName(ev.fighterB.fighterName), {
        american: ev.fighterB.americanOdds,
        implied: ev.fighterB.impliedProbability,
        fair: ev.fighterB.fairProbability,
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
            matchupByFighter={matchupByFighter}
            projByKey={projByKey}
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
  matchupByFighter,
  projByKey,
  loading,
}: {
  slate: UfcDailySlate | null;
  todayDate: string | null;
  error: string | null;
  moneylineByFighter: Map<string, { american: number; implied: number; fair: number }>;
  fighterIdByName: Map<string, string>;
  matchupByFighter: Map<string, FighterMatchup>;
  projByKey: Map<string, UfcSlateProjection>;
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
          const matchup = matchupByFighter.get(normalizeName(name));
          return <FighterCard key={name} name={name} athleteId={athleteId} lines={lines} moneyline={ml} matchup={matchup} projByKey={projByKey} />;
        })}
      </div>
      <p className="muted small" style={{ marginTop: 16, fontSize: 11, color: 'rgba(255,255,255,0.50)', maxWidth: 720 }}>
        Edge / probability badges come from the moneyline-anchored
        UFC projection engine (Phase 136). Honest about its limits —
        these are conservative market-anchored estimates, not deep
        fundamental projections. The fighter-stat database that
        powers a deeper engine is on the roadmap.
      </p>
    </div>
  );
}

function FighterCard({ name, athleteId, lines, moneyline, matchup, projByKey }: {
  name: string;
  athleteId: string;
  lines: UfcStoredLine[];
  moneyline?: { american: number; implied: number; fair: number };
  matchup?: FighterMatchup;
  projByKey: Map<string, UfcSlateProjection>;
}) {
  const grouped = groupLinesByCategory(lines);
  const profileLink = athleteId ? `/mma/fighter/${athleteId}` : null;
  const fightLink = matchup ? `/mma/event/${encodeURIComponent(matchup.eventId)}/fight/${encodeURIComponent(matchup.fightId)}` : null;

  return (
    <div style={{
      position: 'relative',
      padding: 16,
      background: `
        radial-gradient(ellipse 50% 80% at 0% 0%, rgba(239,83,80,0.06) 0%, transparent 60%),
        linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
        var(--surface-1)
      `,
      border: '1px solid rgba(239,83,80,0.20)',
      borderLeft: `3px solid ${MMA_ACCENT}`,
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-card)',
      overflow: 'hidden',
    }}>
      <span aria-hidden style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(239,83,80,0.45), transparent)',
      }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {profileLink ? (
            <Link to={profileLink} style={{ flexShrink: 0, lineHeight: 0 }}>
              <UfcFighterAvatar athleteId={athleteId} name={name} size="sm" />
            </Link>
          ) : (
            <UfcFighterAvatar athleteId={athleteId} name={name} size="sm" />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            {profileLink ? (
              <Link to={profileLink} style={{ color: 'inherit', textDecoration: 'none' }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{name}</h3>
              </Link>
            ) : (
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{name}</h3>
            )}
            {matchup && (
              <MatchupChip matchup={matchup} fightLink={fightLink} />
            )}
          </div>
        </div>
        {moneyline && (
          <span
            title={`Book: ${Math.round(moneyline.implied * 100)}% · Fair (de-vigged): ${Math.round(moneyline.fair * 100)}%`}
            style={{
              padding: '3px 8px',
              background: 'rgba(255,255,255,0.06)',
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 700,
              color: moneyline.american < 0 ? '#7aa2ff' : '#ffd54f',
            }}>
            ML {moneyline.american > 0 ? `+${moneyline.american}` : moneyline.american} · <strong>{Math.round(moneyline.fair * 100)}%</strong> fair
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
              {groupLines.map((l, i) => (
                <PropChip
                  key={i}
                  line={l}
                  projection={projByKey.get(projKey(name, l.statKey, l.line, l.direction))}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Matchup chip — "vs Imavov · main event" with a deep link to the
// fight detail page. Live fights get a pulsing red dot; finished
// fights are dimmed and labeled "final"; pre-fight is the default.
// Mission: never let the user look at a UFC prop without knowing who
// the fighter is fighting tonight, since the opponent dominates
// every prop's true probability.
function MatchupChip({ matchup, fightLink }: { matchup: FighterMatchup; fightLink: string | null }) {
  const isLive = matchup.fightState === 'in';
  const isFinal = matchup.fightState === 'post';
  const dotColor = isLive ? '#ef5350' : isFinal ? 'rgba(255,255,255,0.30)' : 'rgba(255,213,79,0.85)';
  const stateLabel = isLive ? 'live' : isFinal ? 'final' : null;
  const cardLabel = matchup.isTitle ? 'title' : matchup.isMain ? 'main' : null;
  const inner = (
    <>
      <span
        style={{
          width: 6, height: 6, borderRadius: '50%',
          background: dotColor,
          boxShadow: isLive ? '0 0 6px rgba(239,83,80,0.85)' : 'none',
          flexShrink: 0,
        }}
      />
      <span style={{ color: 'rgba(255,255,255,0.45)' }}>vs</span>
      <span style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 700 }}>{matchup.opponentName}</span>
      {(cardLabel || stateLabel) && (
        <span style={{ color: 'rgba(255,255,255,0.40)', marginLeft: 4 }}>
          ·{' '}
          {cardLabel && <span style={{ color: '#ffd54f', fontWeight: 700 }}>{cardLabel}</span>}
          {cardLabel && stateLabel && ' · '}
          {stateLabel && <span style={{ color: isLive ? '#ef5350' : 'rgba(255,255,255,0.50)', fontWeight: 700 }}>{stateLabel}</span>}
        </span>
      )}
    </>
  );
  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: 'inherit',
    textDecoration: 'none',
    padding: '2px 0 0',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  };
  if (fightLink) {
    return <Link to={fightLink} style={baseStyle} title="Open fight detail">{inner}</Link>;
  }
  return <span style={baseStyle}>{inner}</span>;
}

function PropChip({ line, projection }: { line: UfcStoredLine; projection?: UfcSlateProjection }) {
  const dirColor =
    line.direction === 'over'  ? '#66bb6a'
    : line.direction === 'under' ? '#ef5350'
    : 'rgba(255,255,255,0.5)';
  const dirSymbol =
    line.direction === 'over'  ? '↑'
    : line.direction === 'under' ? '↓'
    : '↕';
  // Edge badge color tracks the same green / amber / red bands the
  // NBA + MLB slate cards use, so the visual language carries across
  // sports. Only render when the engine's confidence is meaningful
  // (probability ≥ 55 with a positive edge, or ≤ 45 with a negative
  // edge — i.e. the model has a real lean).
  const edgePct = projection?.edgePercent ?? null;
  const prob = projection?.probability ?? null;
  const edgeColor = edgePct === null ? null
    : edgePct >= 10 ? '#66bb6a'
    : edgePct >= 5  ? '#ffd54f'
    : edgePct >= 0  ? 'rgba(255,255,255,0.45)'
    : '#ef5350';
  const showEdge = projection !== undefined && prob !== null && edgePct !== null;
  return (
    <div style={{
      padding: '6px 10px',
      background: 'rgba(0,0,0,0.2)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 4,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>
          {STAT_LABEL[line.statKey] ?? line.statKey}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: dirColor, whiteSpace: 'nowrap' }}>
          {dirSymbol} {line.line}
        </span>
      </div>
      {showEdge && (
        <div
          title={`Model: ${projection!.modelDirection} · prob ${prob!.toFixed(1)}% · projection ${projection!.projectionValue.toFixed(1)}`}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 10, fontWeight: 700,
            color: 'rgba(255,255,255,0.55)',
            paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.04)',
          }}
        >
          <span style={{ color: edgeColor ?? undefined }}>
            {edgePct! >= 0 ? '+' : ''}{edgePct!.toFixed(1)}pp edge
          </span>
          <span>
            <span style={{ color: prob! >= 60 ? '#66bb6a' : 'rgba(255,255,255,0.65)' }}>{prob!.toFixed(0)}%</span>
            <span style={{ marginLeft: 4, color: 'rgba(255,255,255,0.30)' }}>{projection!.modelDirection}</span>
          </span>
        </div>
      )}
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

// Composite key for the projections map: name (normalized) | statKey |
// line | direction. Mirrors the server-side identification of a slate
// row — same fighter can have OVER + UNDER variants of the same stat,
// and the projection direction is shared across both 'over'/'under'/'both'
// in the slate but the engine returns the model's own direction.
function projKey(fighterName: string, statKey: string, line: number, direction: string): string {
  return `${normalizeName(fighterName)}|${statKey}|${line}|${direction}`;
}

// Suppress unused-import lint when Link isn't actively rendered; it's
// kept so a "Back to /mma" link can be added later without re-importing.
void Link;
