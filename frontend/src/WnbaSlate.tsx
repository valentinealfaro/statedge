// WNBA Slate page — Phase 77 v1 + 77b card construction shipped.
//
// Admin pastes pipe-format lines, backend resolves athlete IDs via
// ESPN search, projects every leg via the lightweight ESPN-gamelog
// engine, returns sorted top edges. Public users see:
//   - Top Institutional Edges hero (top 5)
//   - Filter chips (unified vocab: All / High Edge / Low Risk /
//     Trap Watch / Value / Momentum)
//   - Best 2-6 institutional combo cards (Phase 77b)
//   - Full projected slate sorted by edge%
//
// Per the 2026-05-09 sport-priorities decision WNBA is on
// maintenance only — these surfaces stay live but no new WNBA
// features are scoped (MMA replaced WNBA as the third focus sport).

import { useEffect, useMemo, useState } from 'react';
import { WnbaPlayerAvatar, WnbaTeamLogo } from './Avatar';
import {
  clearWnbaSlate,
  getWnbaLiveToday,
  getWnbaSlate,
  getWnbaSlateStats,
  publishWnbaSlate,
  type WnbaCombo,
  type WnbaLiveTodayPlayer,
  type WnbaLiveTodayResponse,
  type WnbaProjectedLine,
  type WnbaSlateResponse,
  type WnbaStatMeta,
} from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { WhyPickPanel } from './WhyPickPanel';
import { WnbaPlayerDrilldown, type WnbaDrilldownPlayer } from './WnbaPlayerDrilldown';
import { WnbaTodaysGames } from './WnbaTodaysGames';
import { useTitle } from './useTitle';

const ADMIN_KEY = 'statedge:wnbaSlate:adminSecret';
const TEXTAREA_KEY = 'statedge:wnbaSlate:textarea';

type FilterTag = 'all' | 'high_edge' | 'low_risk' | 'trap_watch' | 'value' | 'momentum';

const FILTER_LABELS: Record<FilterTag, string> = {
  all:        'All',
  high_edge:  'High Edge',
  low_risk:   'Low Risk',
  trap_watch: 'Trap Watch',
  value:      'Value',
  momentum:   'Momentum',
};

const FILTER_TOOLTIPS: Record<FilterTag, string> = {
  all:        'Show every projected line on tonight\'s slate.',
  high_edge:  'Lines with +15% or better edge vs implied — strongest model conviction.',
  low_risk:   'Lines with fragility ≤30 (Solid Floor tier) — sturdy, low-variance projections.',
  trap_watch: 'Lines with trap score ≥30 — recent spike vs season; possible public trap.',
  value:      'Edge ≥10% with probability in the 55-72% sweet spot.',
  momentum:   'Player\'s L5 averaging materially above season — recent form trending up sharply.',
};

const EDGE_TOOLTIP =
  'Edge % = our model\'s projected probability − sportsbook implied probability. ' +
  'WNBA still computes edge against a 50% baseline (the projection engine doesn\'t ' +
  'pull from market_snapshots yet for live implied-prob); the truth-metric pipeline ' +
  'does use real market data for CLV. +15% means we have meaningful conviction the ' +
  'line is mispriced.';

function passesFilter(line: WnbaProjectedLine, tag: FilterTag): boolean {
  if (tag === 'all') return true;
  if (tag === 'high_edge')  return line.edgePercent >= 15;
  if (tag === 'low_risk')   return line.fragilityScore <= 30;
  if (tag === 'trap_watch') return line.trapScore >= 30;
  if (tag === 'value')      return line.edgePercent >= 10 && line.probability >= 55 && line.probability <= 72;
  if (tag === 'momentum')   return line.momentumScore >= 65;
  return true;
}

export function WnbaSlate() {
  useTitle(['WNBA Slate']);
  const [data, setData] = useState<WnbaSlateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<WnbaStatMeta[] | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterTag>('all');
  const [search, setSearch] = useState('');
  const [drilldownPlayer, setDrilldownPlayer] = useState<WnbaDrilldownPlayer | null>(null);

  // Admin state
  const [adminSecret, setAdminSecret] = useState<string>(() => {
    try { return localStorage.getItem(ADMIN_KEY) ?? ''; } catch { return ''; }
  });
  const [linesText, setLinesText] = useState<string>(() => {
    try { return localStorage.getItem(TEXTAREA_KEY) ?? ''; } catch { return ''; }
  });
  const [publishing, setPublishing] = useState(false);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  const [parseErrors, setParseErrors] = useState<Array<{ line: string; reason: string }>>([]);
  const [unresolved, setUnresolved] = useState<Array<{ rawText: string; reason: string }>>([]);

  const isAdmin = adminSecret.trim().length > 0;

  useEffect(() => {
    let cancelled = false;
    getWnbaSlate()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [publishMessage]);

  useEffect(() => {
    getWnbaSlateStats().then(setStats).catch(() => setStats(null));
  }, []);

  useEffect(() => {
    try {
      if (adminSecret.trim().length > 0) localStorage.setItem(ADMIN_KEY, adminSecret);
      else localStorage.removeItem(ADMIN_KEY);
    } catch { /* full quota */ }
  }, [adminSecret]);

  useEffect(() => {
    try {
      if (linesText.trim().length > 0) localStorage.setItem(TEXTAREA_KEY, linesText);
      else localStorage.removeItem(TEXTAREA_KEY);
    } catch { /* full quota */ }
  }, [linesText]);

  async function handlePublish() {
    setPublishing(true);
    setPublishMessage(null);
    setParseErrors([]);
    setUnresolved([]);
    try {
      const result = await publishWnbaSlate({ rawText: linesText, adminSecret });
      setPublishMessage(`Published ${result.count} lines for ${result.date}.`);
      setParseErrors(result.parseErrors);
      setUnresolved(result.unresolved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  async function handleClear() {
    if (!confirm('Clear today\'s WNBA slate? This deletes the published lines.')) return;
    try {
      await clearWnbaSlate({ adminSecret });
      setPublishMessage('Cleared.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const filteredLines = useMemo(() => {
    if (!data?.resolved) return [];
    const trimmedSearch = search.trim().toLowerCase();
    return data.resolved.lines
      .filter((l) => passesFilter(l, activeFilter))
      .filter((l) => !trimmedSearch || l.playerName.toLowerCase().includes(trimmedSearch));
  }, [data, activeFilter, search]);

  const topEdges = useMemo(() => {
    if (!data?.resolved) return [];
    return data.resolved.lines.slice(0, 5);
  }, [data]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <WnbaTodaysGames />
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <h1>WNBA · Slate</h1>
          {!isAdmin && (
            <button
              type="button"
              onClick={() => {
                const s = prompt('Admin secret:');
                if (s) setAdminSecret(s);
              }}
              style={{
                padding: '6px 12px', fontSize: 12, fontWeight: 700,
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4, color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
              }}
            >
              Admin →
            </button>
          )}
        </div>
        <p className="muted small">
          Tonight's projected WNBA props sorted by model edge. Uses
          ESPN gamelog data + L5/L10/season blended projections, with
          institutional Best 2-6 combo cards rendered below the
          per-line table.
        </p>

        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}

        {isAdmin && (
          <AdminPanel
            adminSecret={adminSecret}
            onLogout={() => setAdminSecret('')}
            linesText={linesText}
            onChange={setLinesText}
            onPublish={handlePublish}
            onClear={handleClear}
            publishing={publishing}
            publishMessage={publishMessage}
            parseErrors={parseErrors}
            unresolved={unresolved}
            stats={stats}
          />
        )}

        {!data && !error && <Skeleton width="100%" height={400} style={{ marginTop: 16 }} />}

        {data && !data.slate && (
          <div className="mlb-info-banner" style={{ marginTop: 16 }}>
            <strong>No slate published yet today.</strong> Check back later
            — admin posts the day's lines once tonight's PrizePicks board
            is live.
          </div>
        )}

        {data?.resolved && data.resolved.lines.length > 0 && (
          <>
            {topEdges.length > 0 && <TopEdges entries={topEdges} />}

            {/* Best 2-6 institutional cards. Phase 77b — full Phase-58
                exposure-control engine ported to WNBA. Renders only
                when there's at least one built combo; failed slots
                render with their explanatory reason so users see
                what blocked card construction. */}
            {data.resolved.combos.length > 0 && (
              <ComboRail
                combos={data.resolved.combos}
                resolvedMode={data.resolved.resolvedMode}
                onPlayerClick={setDrilldownPlayer}
              />
            )}

            <div className="mlb-context-heading" style={{ marginTop: 24, marginBottom: 8, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <span>All projected lines</span>
              <span className="muted small">
                {data.resolved.lines.length} lines · sorted by edge %
              </span>
            </div>

            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search player name…"
              style={{
                width: '100%',
                padding: '10px 14px',
                fontSize: 14,
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 6,
                background: 'rgba(255,255,255,0.04)',
                color: 'inherit',
                marginBottom: 8,
              }}
            />

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {(Object.keys(FILTER_LABELS) as FilterTag[]).map((tag) => {
                const active = activeFilter === tag;
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setActiveFilter(tag)}
                    title={FILTER_TOOLTIPS[tag]}
                    style={{
                      padding: '5px 10px',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      borderRadius: 4,
                      cursor: 'pointer',
                      background: active ? 'rgba(122, 162, 255, 0.18)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${active ? 'rgba(122, 162, 255, 0.5)' : 'rgba(255,255,255,0.1)'}`,
                      color: active ? '#7aa2ff' : 'rgba(255,255,255,0.7)',
                    }}
                  >
                    {FILTER_LABELS[tag]}
                  </button>
                );
              })}
            </div>

            {filteredLines.length === 0 ? (
              <p className="muted small">No lines match the current filter.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {filteredLines.map((l, i) => <LineCard key={`${l.athleteId}-${l.statKey}-${i}`} line={l} />)}
              </div>
            )}
          </>
        )}

        {data?.resolved?.disclaimer && (
          <p className="mlb-disclaimer">{data.resolved.disclaimer}</p>
        )}
      </div>

      {drilldownPlayer && data?.resolved && (
        <WnbaPlayerDrilldown
          player={drilldownPlayer}
          combos={data.resolved.combos
            .map((c) => c.combo)
            .filter((c): c is WnbaCombo => c !== null)}
          lines={data.resolved.lines}
          onClose={() => setDrilldownPlayer(null)}
        />
      )}
    </div>
  );
}

// ---------- Admin paste form ----------

function AdminPanel({
  adminSecret, onLogout, linesText, onChange,
  onPublish, onClear, publishing, publishMessage,
  parseErrors, unresolved, stats,
}: {
  adminSecret: string;
  onLogout: () => void;
  linesText: string;
  onChange: (s: string) => void;
  onPublish: () => void;
  onClear: () => void;
  publishing: boolean;
  publishMessage: string | null;
  parseErrors: Array<{ line: string; reason: string }>;
  unresolved: Array<{ rawText: string; reason: string }>;
  stats: WnbaStatMeta[] | null;
}) {
  return (
    <div className="mlb-context" style={{ marginTop: 16 }}>
      <div className="mlb-context-heading" style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
        <span>Admin · publish today's slate</span>
        <button
          type="button"
          onClick={onLogout}
          style={{
            fontSize: 11, fontWeight: 700, padding: '4px 10px',
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 4, color: 'rgba(255,255,255,0.5)', cursor: 'pointer',
          }}
        >
          Log out
        </button>
      </div>
      <p className="muted small" style={{ marginTop: 4 }}>
        Pipe-format, one line per row: <code>Player Name|TEAM|stat_key|line|direction</code>.
        Direction is <code>over</code> / <code>under</code> / <code>both</code>. Lines starting with <code>#</code> are comments.
      </p>
      {stats && stats.length > 0 && (
        <p className="muted small">
          Stat keys: {stats.map((s) => s.key).join(', ')}
        </p>
      )}
      <textarea
        value={linesText}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        placeholder={`# Example:\nA'ja Wilson|LV|points|22.5|over\nCaitlin Clark|IND|assists|7.5|over\nBreanna Stewart|NYL|rebounds|8.5|over`}
        style={{
          width: '100%', marginTop: 8, fontFamily: 'monospace',
          padding: 12, fontSize: 12,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 6, color: 'inherit',
        }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          onClick={onPublish}
          disabled={publishing || !linesText.trim() || !adminSecret}
          style={{
            padding: '8px 16px', fontSize: 12, fontWeight: 700,
            letterSpacing: '0.04em', textTransform: 'uppercase',
            background: '#7aa2ff', border: 'none', borderRadius: 4,
            color: '#0a0e14', cursor: publishing ? 'wait' : 'pointer',
            opacity: publishing || !linesText.trim() ? 0.5 : 1,
          }}
        >
          {publishing ? 'Publishing…' : 'Publish slate'}
        </button>
        <button
          type="button"
          onClick={onClear}
          style={{
            padding: '8px 16px', fontSize: 12, fontWeight: 700,
            letterSpacing: '0.04em', textTransform: 'uppercase',
            background: 'transparent',
            border: '1px solid rgba(239, 83, 80, 0.4)',
            borderRadius: 4, color: '#ef5350', cursor: 'pointer',
          }}
        >
          Clear today's slate
        </button>
      </div>
      {publishMessage && (
        <p className="muted small" style={{ marginTop: 8, color: '#66bb6a' }}>{publishMessage}</p>
      )}
      {parseErrors.length > 0 && (
        <div className="mlb-info-banner mlb-info-error" style={{ marginTop: 8 }}>
          <strong>{parseErrors.length} parse error{parseErrors.length === 1 ? '' : 's'}:</strong>
          <ul>
            {parseErrors.map((e, i) => (
              <li key={i}><code>{e.line}</code> — {e.reason}</li>
            ))}
          </ul>
        </div>
      )}
      {unresolved.length > 0 && (
        <div className="mlb-info-banner" style={{ marginTop: 8 }}>
          <strong>{unresolved.length} player{unresolved.length === 1 ? '' : 's'} couldn't be resolved:</strong>
          <ul>
            {unresolved.map((u, i) => (
              <li key={i}><code>{u.rawText}</code> — {u.reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------- Top Institutional Edges hero ----------

function TopEdges({ entries }: { entries: WnbaProjectedLine[] }) {
  return (
    <div
      style={{
        marginTop: 20,
        padding: '14px 16px',
        background: 'linear-gradient(135deg, rgba(179, 136, 255, 0.10), rgba(122, 162, 255, 0.04))',
        border: '1px solid rgba(179, 136, 255, 0.30)',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 800 }}>🔥 Top Institutional Edges</span>
        <span className="muted small">highest-conviction picks tonight · sorted by edge %</span>
        <span
          title={EDGE_TOOLTIP}
          style={{
            marginLeft: 'auto', fontSize: 10, color: 'rgba(255,255,255,0.5)', cursor: 'help',
            border: '1px solid rgba(255,255,255,0.15)', borderRadius: '50%',
            width: 16, height: 16,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          ?
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {entries.map((line, i) => (
          <div
            key={`${line.athleteId}-${i}`}
            style={{
              background: 'rgba(0,0,0,0.18)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 6,
              padding: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <WnbaPlayerAvatar playerId={line.athleteId} name={line.playerName} size="md" />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {line.playerName}
                </div>
                <div className="muted small" style={{ fontSize: 10 }}>{line.team ?? '—'}</div>
              </div>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              {line.statLabel} {line.line}
              <span style={{ marginLeft: 6, color: line.probability >= 70 ? '#66bb6a' : '#7aa2ff' }}>
                {line.direction === 'OVER' ? '↑' : '↓'} {Math.round(line.probability)}%
              </span>
            </div>
            <div
              title={EDGE_TOOLTIP}
              style={{
                fontSize: 18, fontWeight: 800,
                color: line.edgePercent >= 0 ? '#66bb6a' : '#ef5350',
                cursor: 'help',
              }}
            >
              {line.edgePercent >= 0 ? '+' : ''}{line.edgePercent.toFixed(0)}% EDGE
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Per-line card ----------

function LineCard({ line }: { line: WnbaProjectedLine }) {
  const [expanded, setExpanded] = useState(false);
  const probColor = line.probability >= 70 ? '#66bb6a'
    : line.probability >= 55 ? '#7aa2ff'
    : '#ef5350';
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 6,
        padding: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <a
          href={`/wnba/compare?aid=${encodeURIComponent(line.athleteId)}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit', minWidth: 0, flex: 1 }}
          title="Open WNBA Compare for this player"
        >
          <WnbaPlayerAvatar playerId={line.athleteId} name={line.playerName} size="md" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{line.playerName}</div>
            <div className="muted small">{line.team ?? '—'}</div>
          </div>
        </a>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>
            {line.statLabel} {line.line}
          </span>
          <span style={{ fontWeight: 700, color: probColor }}>
            {line.direction === 'OVER' ? '↑' : '↓'} {Math.round(line.probability)}%
          </span>
          <span
            title={EDGE_TOOLTIP}
            style={{
              fontWeight: 700,
              color: line.edgePercent >= 5 ? '#66bb6a' : line.edgePercent <= -5 ? '#ef5350' : 'rgba(255,255,255,0.5)',
              minWidth: 60, textAlign: 'right',
              cursor: 'help',
            }}
          >
            {line.edgePercent >= 0 ? '+' : ''}{line.edgePercent.toFixed(0)}% edge
          </span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              fontSize: 11, color: '#7aa2ff', fontWeight: 700,
              background: 'transparent',
              border: '1px solid rgba(122, 162, 255, 0.3)',
              borderRadius: 4, padding: '4px 8px', cursor: 'pointer',
            }}
          >
            {expanded ? '−' : '+'}
          </button>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10, fontSize: 11 }}>
          <Stat label="Projection" value={line.projection.toFixed(1)} />
          <Stat label="L5 Avg"     value={line.l5Avg.toFixed(1)} />
          <Stat label="L10 Avg"    value={line.l10Avg.toFixed(1)} />
          <Stat label="Season Avg" value={line.seasonAvg.toFixed(1)} />
          <Stat label="L10 Hits"   value={`${line.l10HitCount}/10`} hint={`${line.l10HitRate.toFixed(0)}%`} />
          <Stat label="Trap"       value={line.trapScore.toFixed(0)} color={line.trapScore >= 60 ? '#ef5350' : line.trapScore >= 30 ? '#ffb74d' : undefined} />
          <Stat label="Fragility"  value={line.fragilityScore.toFixed(0)} color={line.fragilityScore >= 60 ? '#ef5350' : line.fragilityScore <= 30 ? '#66bb6a' : undefined} />
          <Stat label="Momentum"   value={line.momentumScore.toFixed(0)} color={line.momentumScore >= 65 ? '#66bb6a' : line.momentumScore <= 35 ? '#ef5350' : undefined} />
          {line.reasonCodes.length > 0 && (
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="muted small" style={{ marginBottom: 2 }}>Notes</div>
              {line.reasonCodes.map((r, i) => (
                <div key={i} style={{ fontSize: 11, lineHeight: 1.5 }}>· {r}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <div>
      <div className="muted small" style={{ marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
      {hint && <div className="muted small" style={{ fontSize: 10 }}>{hint}</div>}
    </div>
  );
}

// ---------- Best 2-6 institutional combo cards (Phase 77b + 78b live) ----------

const FLEX_PAYOUTS: Record<number, number> = { 2: 3, 3: 5, 4: 10, 5: 7, 6: 25 };

// Map slate stat keys to live boxscore fields. Keep in sync with the
// WNBA stat catalog in backend/wnba/projection.ts.
function liveValueForStat(stats: WnbaLiveTodayPlayer, statKey: string): number | null {
  switch (statKey) {
    case 'points':              return stats.points;
    case 'rebounds':            return stats.rebounds;
    case 'assists':             return stats.assists;
    case 'three_pt_made':       return stats.threePtMade;
    case 'fg_made':             return stats.fgMade;
    case 'fg_attempted':        return stats.fgAttempted;
    case 'ft_made':             return stats.ftMade;
    case 'ft_attempted':        return stats.ftAttempted;
    case 'personal_fouls':      return stats.personalFouls;
    case 'steals':              return stats.steals;
    case 'blocks':              return stats.blocks;
    case 'turnovers':           return stats.turnovers;
    case 'pra':                 return stats.pra;
    case 'pr':                  return stats.pr;
    case 'pa':                  return stats.pa;
    case 'ra':                  return stats.ra;
    case 'stocks':              return stats.stocks;
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

function resolveLegLive(
  liveToday: WnbaLiveTodayResponse | null,
  leg: { athleteId: string; statKey: string; line: number; direction: 'OVER' | 'UNDER' },
): { grade: LiveGrade; current: number | null } {
  if (!liveToday) return { grade: 'PENDING', current: null };
  const ps = liveToday.byPlayer[leg.athleteId];
  if (!ps) return { grade: 'PENDING', current: null };
  const game = liveToday.byGame[ps.eventId];
  const current = liveValueForStat(ps, leg.statKey);
  return { grade: gradeLeg(leg.direction, leg.line, current, game?.state), current };
}

// Polls /api/wnba/live/today every 30s while at least one game is
// in progress, 60s otherwise. Same pattern MLB + NBA use. Backend
// 25s server-side cache absorbs concurrent users.
function useWnbaLiveToday(): WnbaLiveTodayResponse | null {
  const [feed, setFeed] = useState<WnbaLiveTodayResponse | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getWnbaLiveToday()
      .then((d) => { if (!cancelled) setFeed(d); })
      .catch(() => { /* silent — pregame or out-of-season is fine */ });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    const anyLive = feed
      ? Object.values(feed.byGame).some((g) => g.state === 'live')
      : false;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, anyLive ? 45_000 : 90_000);
    return () => window.clearInterval(interval);
  }, [feed]);

  return feed;
}

// Phase 92: WNBA Flex payouts — same PrizePicks schedule MLB/NBA use.
const WNBA_FLEX_PAYOUTS: Record<string, number> = {
  'Best 2': 3, 'Best 3': 5, 'Best 4': 10, 'Best 5': 7, 'Best 6': 25,
};

// Slate-level live tracker — aggregates every card on tonight's
// WNBA slate into a single status banner: cleared / dead / live /
// pending counts, per-leg totals, simulated $1 P/L. Same pattern
// MLB + NBA use.
function WnbaSlateLiveSummary({
  combos,
  liveToday,
}: {
  combos: Array<{ size: number; label: WnbaCombo['label']; combo: WnbaCombo | null; reason: string }>;
  liveToday: WnbaLiveTodayResponse | null;
}) {
  if (!liveToday) return null;
  const anyLive = Object.values(liveToday.byGame).some((g) => g.state === 'live');
  const anyFinal = Object.values(liveToday.byGame).some((g) => g.state === 'final');
  if (!anyLive && !anyFinal) return null;

  type CardStatus = 'cleared' | 'dead' | 'live' | 'pending';
  function statusForLegs(legs: WnbaCombo['legs']): CardStatus {
    const grades = legs.map((l) => resolveLegLive(liveToday, l));
    if (grades.some((g) => g.grade === 'MISS')) return 'dead';
    const allHit = grades.length > 0 && grades.every((g) => g.grade === 'HIT' || g.grade === 'PUSH');
    if (allHit) return 'cleared';
    if (grades.some((g) => g.grade === 'PROGRESS' || g.grade === 'HIT')) return 'live';
    return 'pending';
  }

  const cards: Array<{ name: string; status: CardStatus }> = [];
  const allLegs: WnbaCombo['legs'] = [];
  for (const slot of combos) {
    if (!slot.combo) continue;
    cards.push({ name: slot.combo.label, status: statusForLegs(slot.combo.legs) });
    for (const l of slot.combo.legs) allLegs.push(l);
  }

  const cleared = cards.filter((c) => c.status === 'cleared').length;
  const dead    = cards.filter((c) => c.status === 'dead').length;
  const live    = cards.filter((c) => c.status === 'live').length;
  const pending = cards.filter((c) => c.status === 'pending').length;

  const seenLeg = new Set<string>();
  let legHit = 0, legMiss = 0, legProgress = 0, legPending = 0;
  for (const l of allLegs) {
    const key = `${l.athleteId}::${l.statKey}::${l.line}::${l.direction}`;
    if (seenLeg.has(key)) continue;
    seenLeg.add(key);
    const g = resolveLegLive(liveToday, l);
    if (g.grade === 'HIT')           legHit += 1;
    else if (g.grade === 'MISS')     legMiss += 1;
    else if (g.grade === 'PROGRESS') legProgress += 1;
    else                              legPending += 1;
  }
  const totalLegs = legHit + legMiss + legProgress + legPending;

  if (cleared + dead + live === 0) return null;

  let profit = 0;
  for (const c of cards) {
    if (c.status === 'cleared') profit += (WNBA_FLEX_PAYOUTS[c.name] ?? 1) - 1;
    else if (c.status === 'dead') profit -= 1;
  }

  return (
    <div
      style={{
        margin: '12px 0',
        padding: '10px 14px',
        borderRadius: 6,
        background: dead > 0 && cleared === 0
          ? 'rgba(239, 83, 80, 0.10)'
          : cleared > 0
          ? 'rgba(102, 187, 106, 0.10)'
          : 'rgba(179, 136, 255, 0.10)',
        border: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        alignItems: 'baseline',
        fontSize: 13,
      }}
      title="Live aggregate across every card on tonight's WNBA slate. Cleared = all legs hit; Dead = at least one leg missed; Live = still in progress; Pending = game hasn't started."
    >
      <strong style={{ fontSize: 14, letterSpacing: '0.02em' }}>Slate live status</strong>
      <span title="Cards where every leg has hit (parlay paid)" style={{ color: '#66bb6a', fontWeight: 700 }}>● {cleared} CLEARED</span>
      <span title="Cards where at least one leg has missed (parlay dead)" style={{ color: '#ef5350', fontWeight: 700 }}>● {dead} DEAD</span>
      <span title="Cards with at least one game in progress" style={{ color: '#b388ff', fontWeight: 700 }}>● {live} LIVE</span>
      {pending > 0 && (<span className="muted small">{pending} pending tipoff</span>)}
      <span
        title="Per-leg totals across every card. De-duped so a leg on multiple cards counts once."
        style={{
          paddingLeft: 12,
          marginLeft: 4,
          borderLeft: '1px solid rgba(255,255,255,0.12)',
          display: 'flex',
          gap: 10,
          alignItems: 'baseline',
        }}
      >
        <span className="muted small">Legs ({totalLegs})</span>
        <span style={{ color: '#66bb6a', fontWeight: 700 }}>{legHit} hit</span>
        <span style={{ color: '#ef5350', fontWeight: 700 }}>{legMiss} miss</span>
        <span style={{ color: '#b388ff', fontWeight: 700 }}>{legProgress} live</span>
        {legPending > 0 && (<span className="muted small">{legPending} pending</span>)}
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span className="muted small">Simulated $1 P/L</span>
        <strong
          style={{
            fontSize: 14,
            color: profit > 0 ? '#66bb6a' : profit < 0 ? '#ef5350' : undefined,
          }}
        >
          {profit >= 0 ? '+' : ''}${profit.toFixed(2)}
        </strong>
      </span>
    </div>
  );
}

function ComboRail({
  combos,
  resolvedMode,
  onPlayerClick,
}: {
  combos: Array<{ size: number; label: WnbaCombo['label']; combo: WnbaCombo | null; reason: string }>;
  resolvedMode: string;
  onPlayerClick: (p: WnbaDrilldownPlayer) => void;
}) {
  // One shared fetch across all card children — same data, cheaper polling.
  const liveToday = useWnbaLiveToday();
  return (
    <div style={{ marginTop: 24 }}>
      <div className="mlb-context-heading" style={{ marginBottom: 12, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span>Pre-built parlays</span>
        <span className="muted small">
          mode: <strong>{resolvedMode}</strong> · diversified portfolio across cards (no player on more than 4 of 6)
        </span>
      </div>
      <WnbaSlateLiveSummary combos={combos} liveToday={liveToday} />
      <div className="best-picks-rail">
        {combos.map((slot) => (
          <ComboCard key={slot.size} slot={slot} liveToday={liveToday} onPlayerClick={onPlayerClick} />
        ))}
      </div>
    </div>
  );
}

function ComboCard({
  slot,
  liveToday,
  onPlayerClick,
}: {
  slot: { size: number; label: WnbaCombo['label']; combo: WnbaCombo | null; reason: string };
  liveToday: WnbaLiveTodayResponse | null;
  onPlayerClick: (p: WnbaDrilldownPlayer) => void;
}) {
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

  // Live grading: compute each leg's status against the live feed.
  // When no game is live, every leg is PENDING and the live banner
  // doesn't render (card looks identical to pre-game state).
  const grades = c.legs.map((l) => resolveLegLive(liveToday, l));
  const tally = {
    hit: grades.filter((g) => g.grade === 'HIT').length,
    miss: grades.filter((g) => g.grade === 'MISS').length,
    progress: grades.filter((g) => g.grade === 'PROGRESS').length,
    push: grades.filter((g) => g.grade === 'PUSH').length,
  };
  const anyLive = tally.hit + tally.miss + tally.progress + tally.push > 0;
  const cardDead = tally.miss > 0;
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
            textAlign: 'left',
          }}
          title="Live grading — each leg checked against current ESPN box score. ANY miss kills the whole parlay."
        >
          {cardCleared && <span>✓ ALL {c.legs.length} HIT — CARD CLEARED</span>}
          {cardDead && <span>✗ {tally.miss} LEG{tally.miss === 1 ? '' : 'S'} DEAD</span>}
          {!cardCleared && !cardDead && <span>● {tally.hit}/{c.legs.length} HIT · {tally.progress} LIVE</span>}
        </div>
      )}
      <div
        className="best-pick-pct"
        title={`Adjusted combined hit %. Multiplies each leg's probability and applies a correlation penalty (${c.correlationRisk} risk).`}
      >
        {c.adjustedCombinedHit.toFixed(1)}%
      </div>
      <div className="best-pick-pct-label">
        adjusted hit · {c.correlationRisk} correlation
      </div>
      <div
        className={`best-pick-ev ${evClass}`}
        title={`Win prob ${c.adjustedCombinedHit.toFixed(1)}% × payout ${payout}× − $1 = ${ev >= 0 ? '+' : ''}${ev.toFixed(2)}.`}
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
          <span className="muted small">Trap</span>
          <strong className={c.averageTrap >= 50 ? 'neg' : c.averageTrap >= 25 ? '' : 'pos'}>
            {c.averageTrap.toFixed(0)}
          </strong>
        </div>
        <div className="best-pick-signal">
          <span className="muted small">Fragility</span>
          <strong className={c.averageFragility >= 60 ? 'neg' : c.averageFragility <= 30 ? 'pos' : ''}>
            {c.averageFragility.toFixed(0)}
          </strong>
        </div>
        <div className="best-pick-signal">
          <span className="muted small">Players</span>
          <strong>{c.constructionNotes.uniquePlayers}</strong>
        </div>
      </div>
      <div className="best-pick-legs">
        {c.legs.map((l, i) => {
          const isOver = l.direction === 'OVER';
          const probColor = l.probability >= 70 ? '#66bb6a'
            : l.probability >= 55 ? '#7aa2ff'
            : '#ef5350';
          const live = grades[i];
          return (
            <div key={i} className="best-pick-leg-block">
              <div className="best-pick-leg">
                <button
                  type="button"
                  onClick={() => onPlayerClick({ athleteId: l.athleteId, playerName: l.playerName, team: l.team })}
                  className="best-pick-leg-name slate-leg-button"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  title="Click for player drilldown"
                >
                  <WnbaPlayerAvatar playerId={l.athleteId} name={l.playerName} size="md" />
                  {l.playerName}
                  {l.team && (
                    <span className="slate-leg-team">
                      <WnbaTeamLogo abbr={l.team} name={l.team} size="md" />
                      <span>{l.team}</span>
                    </span>
                  )}
                </button>
                <span className="best-pick-leg-stat">
                  {l.statLabel} {l.line}
                </span>
                <span className={`best-pick-leg-dir ${isOver ? 'over' : 'under'}`} style={{ color: probColor }}>
                  {isOver ? '↑' : '↓'} {Math.round(l.probability)}%
                </span>
              </div>
              <div className="best-pick-leg-evbar">
                <span
                  className={`best-pick-leg-edge ${l.edgePercent >= 5 ? 'pos' : l.edgePercent <= -5 ? 'neg' : 'flat'}`}
                  title={EDGE_TOOLTIP}
                >
                  {l.edgePercent >= 0 ? '+' : ''}{l.edgePercent.toFixed(0)}% edge
                </span>
                {l.trapScore >= 60 && (
                  <span className="best-pick-leg-trap">⚠ TRAP RISK</span>
                )}
                {live && live.grade !== 'PENDING' && (
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
              <WhyPickPanel
                sportColor="#b388ff"
                leg={{
                  playerName: l.playerName,
                  statLabel: l.statLabel,
                  line: l.line,
                  direction: l.direction,
                  probability: l.probability,
                  edgePercent: l.edgePercent,
                  projection: l.projection,
                  reasonCodes: l.reasonCodes,
                  trapScore: l.trapScore,
                  fragilityScore: l.fragilityScore,
                  momentumScore: l.momentumScore,
                  l5Avg: l.l5Avg,
                  l10Avg: l.l10Avg,
                  seasonAvg: l.seasonAvg,
                  l10HitRate: l.l10HitRate,
                  l10HitCount: l.l10HitCount,
                }}
              />
            </div>
          );
        })}
      </div>
      <div
        className="best-pick-warnings"
        title="Construction notes — what the engine actually built."
        style={{ borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 8, padding: '8px 16px', fontSize: 11, color: 'rgba(255,255,255,0.6)' }}
      >
        {c.constructionNotes.summary}
        {c.weakestLegName && (
          <span style={{ marginLeft: 8 }}>
            · weakest: <strong>{c.weakestLegName}</strong>
          </span>
        )}
      </div>
    </div>
  );
}
