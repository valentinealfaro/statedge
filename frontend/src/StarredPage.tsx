// /starred — user's personal watchlist of starred props with live state.
// Phase 148.
//
// Local-storage-backed. Polls /api/slate/live-grade every 60s with the
// list of starred props so the verdict pill ticks for the user's own
// follow-list — separate from the slate-page top-40 poll, so even
// off-slate / older starred picks get tracked as long as their game
// can be graded by the engine.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  liveGradeLegs,
  type EliteLegLiveState,
} from './api';
import { NavBar } from './NavBar';
import { LiveVerdictPill } from './slateLiveState';
import { useStarredProps, type StarredProp, type Sport } from './starredProps';
import {
  notificationPermission,
  requestNotificationPermission,
} from './useStarredNotifications';
import { TodayAtAGlance } from './TodayAtAGlance';
import { useTitle } from './useTitle';

const SPORT_LABEL: Record<Sport, string> = { nba: 'NBA', mlb: 'MLB', mma: 'UFC' };
const SPORT_COLOR: Record<Sport, string> = { nba: '#7aa2ff', mlb: '#66bb6a', mma: '#ef5350' };

type StarredSortKey = 'date' | 'sport' | 'verdict' | 'edge';

export function StarredPage() {
  useTitle(['Starred props', 'Watchlist']);
  const { items, unstar, clear } = useStarredProps();
  const [liveByKey, setLiveByKey] = useState<Map<string, EliteLegLiveState>>(new Map());
  const [sortKey, setSortKey] = useState<StarredSortKey>('date');
  const [notifPerm, setNotifPerm] = useState(notificationPermission);
  // Notifications are mounted globally at the App level (see
  // GlobalNotifications) so they fire from any page. This page
  // surfaces only the opt-in button + permission state for UX.

  // Poll live grading for every starred prop. Capped at 50 because
  // the backend caps the request at 50 legs per call. All sports now
  // grade — UFC stat keys outside the supported set (sig_strikes,
  // takedowns, knockdowns, control_time) honestly return UNGRADED.
  const gradable = useMemo(() => items.slice(0, 50), [items]);
  const visibleSig = gradable.map((p) => p.id).join('|');

  useEffect(() => {
    if (gradable.length === 0) { setLiveByKey(new Map()); return; }
    let cancelled = false;
    const tick = () => {
      const payload = gradable.map((p) => ({
        playerId: p.playerId,
        espnAthleteId: p.espnAthleteId,
        playerName: p.playerName,
        statKey: p.statKey,
        direction: p.direction,
        line: p.line,
      }));
      liveGradeLegs(payload)
        .then((states) => {
          if (cancelled) return;
          const m = new Map<string, EliteLegLiveState>();
          for (let i = 0; i < states.length; i++) {
            m.set(gradable[i]!.id, states[i]!);
          }
          setLiveByKey(m);
        })
        .catch(() => { /* silent — pills self-hide on null */ });
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [visibleSig]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Roll up: how many of my starred props have hit / are live / missed
  const tally = { hit: 0, live: 0, miss: 0, pending: 0 };
  for (const p of items) {
    const s = liveByKey.get(p.id);
    if (!s) { tally.pending++; continue; }
    const v = s.verdict;
    if (v === 'HIT' || v === 'ON_PACE_HIT') tally.hit++;
    else if (v === 'MISS' || v === 'ON_PACE_MISS' || v === 'PUSH') tally.miss++;
    else if (v === 'IN_FLIGHT') tally.live++;
    else tally.pending++;
  }

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ marginBottom: 8 }}>
          <Link to="/" className="muted small">← Home</Link>
        </div>

        <div style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.10em',
          textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
        }}>
          STATEDGE WATCHLIST · YOUR STARRED PROPS
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ margin: '4px 0 8px' }}>Starred props</h1>
          {/* Desktop-notification opt-in. Renders only when items
              exist (no use opting in with an empty list) and the
              permission isn't already granted. Suppressed on
              unsupported browsers. */}
          {items.length > 0 && (notifPerm === 'default' || notifPerm === 'denied') && (
            <button
              type="button"
              onClick={async () => {
                const result = await requestNotificationPermission();
                setNotifPerm(result);
              }}
              disabled={notifPerm === 'denied'}
              title={notifPerm === 'denied'
                ? 'Browser blocked notifications — enable in your browser site settings to re-prompt'
                : 'Get a desktop ping when a starred prop hits or misses'}
              style={{
                padding: '4px 10px', borderRadius: 4,
                fontSize: 11, fontWeight: 800, letterSpacing: '0.04em',
                textTransform: 'uppercase',
                background: notifPerm === 'denied' ? 'transparent' : 'rgba(122,162,255,0.14)',
                color: notifPerm === 'denied' ? 'rgba(255,255,255,0.40)' : '#7aa2ff',
                border: `1px solid ${notifPerm === 'denied' ? 'rgba(255,255,255,0.10)' : 'rgba(122,162,255,0.40)'}`,
                cursor: notifPerm === 'denied' ? 'not-allowed' : 'pointer',
              }}
            >
              {notifPerm === 'denied' ? '🔕 Notifications blocked' : '🔔 Enable notifications'}
            </button>
          )}
          {items.length > 0 && notifPerm === 'granted' && (
            <span style={{
              padding: '4px 10px', borderRadius: 4,
              fontSize: 11, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase',
              color: '#66bb6a',
              background: 'rgba(102,187,106,0.10)',
              border: '1px solid rgba(102,187,106,0.30)',
            }}>
              🔔 Notifications on
            </span>
          )}
        </div>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 16, fontSize: 13, lineHeight: 1.6, maxWidth: 760 }}>
          Props you've starred from anywhere on the site. Live-graded against
          tonight's games. Stored locally on this device — sign in / out doesn't
          sync across machines yet. Up to 50 props.
        </p>

        {/* Same Bloomberg ticker that leads Home / Dashboard / Best
            Bets / Elite. Watchlist users see today's headline numbers
            before scanning their personal list below. */}
        <TodayAtAGlance />

        {items.length === 0 ? (
          <div className="mlb-info-banner">
            <strong>No starred props yet.</strong> Tap the ☆ on any prop card or
            row in <Link to="/best-bets" style={{ color: '#7aa2ff' }}>Best Bets</Link>,
            on the <Link to="/nba/slate" style={{ color: '#7aa2ff' }}>NBA slate</Link>,
            an <Link to="/mlb/slate" style={{ color: '#7aa2ff' }}>MLB combo card</Link>,
            or a <Link to="/mma/slate" style={{ color: '#ef5350' }}>UFC fighter card</Link> to
            track it here. Live verdicts tick once a minute when a starred prop's game
            (or fight) is in progress.
          </div>
        ) : (
          <>
            {/* Rollup chip — only when at least one prop has resolved */}
            {(tally.hit + tally.live + tally.miss) > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                marginBottom: 14, padding: '10px 14px',
                background: 'rgba(0,0,0,0.20)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
              }}>
                <span className="live-pulse" style={{
                  display: 'inline-block', width: 7, height: 7, borderRadius: 3.5,
                  background: tally.miss > 0 ? '#ef5350' : tally.live > 0 ? '#ffd54f' : '#66bb6a',
                }} />
                <span style={{ color: 'rgba(255,255,255,0.65)' }}>Live tally</span>
                {tally.hit > 0 && <span style={{ color: '#66bb6a' }}>{tally.hit} hit</span>}
                {tally.live > 0 && <span style={{ color: '#ffd54f' }}>{tally.live} in flight</span>}
                {tally.miss > 0 && <span style={{ color: '#ef5350' }}>{tally.miss} miss</span>}
                {tally.pending > 0 && <span style={{ color: 'rgba(255,255,255,0.55)' }}>{tally.pending} pending</span>}
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => downloadStarredCsv(items, liveByKey)}
                  title="Export your starred props (with live verdicts) to CSV"
                  style={{
                    fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
                    padding: '4px 10px', borderRadius: 4,
                    background: 'transparent',
                    color: '#7aa2ff',
                    border: '1px solid rgba(122,162,255,0.30)',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                  }}
                >
                  ⬇ CSV
                </button>
                <button
                  type="button"
                  onClick={() => { if (confirm('Clear all starred props?')) clear(); }}
                  style={{
                    fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
                    padding: '4px 10px', borderRadius: 4,
                    background: 'transparent',
                    color: 'rgba(255,255,255,0.55)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                  }}
                >
                  Clear all
                </button>
              </div>
            )}
            {/* Even when nothing has resolved yet, expose the export
                so users can pull a snapshot of their watchlist. */}
            {items.length > 0 && (tally.hit + tally.live + tally.miss) === 0 && (
              <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => downloadStarredCsv(items, liveByKey)}
                  title="Export your starred props to CSV"
                  style={{
                    fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
                    padding: '4px 10px', borderRadius: 4,
                    background: 'transparent',
                    color: '#7aa2ff',
                    border: '1px solid rgba(122,162,255,0.30)',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                  }}
                >
                  ⬇ CSV
                </button>
              </div>
            )}

            {/* Sort bar — Bloomberg-watchlist convention. Default
                is date-desc (newest stars first). Other options sort
                by sport tag, current verdict (HIT first / MISS last),
                or by snapshot edge%. */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              marginBottom: 12, padding: '8px 12px',
              background: 'rgba(0,0,0,0.20)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              fontSize: 11,
            }}>
              <span style={{ color: 'rgba(255,255,255,0.55)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', fontSize: 10 }}>
                Sort
              </span>
              {(['date', 'sport', 'verdict', 'edge'] as const).map((k) => {
                const active = sortKey === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSortKey(k)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 'var(--radius-pill)',
                      border: '1px solid',
                      borderColor: active ? 'rgba(122,162,255,0.55)' : 'rgba(255,255,255,0.10)',
                      background: active ? 'rgba(122,162,255,0.14)' : 'transparent',
                      color: active ? '#7aa2ff' : 'rgba(255,255,255,0.65)',
                      fontWeight: 800, letterSpacing: '0.04em',
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                    }}
                  >
                    {k === 'date' ? 'Newest' : k === 'sport' ? 'Sport' : k === 'verdict' ? 'Verdict' : 'Edge'}
                  </button>
                );
              })}
            </div>

            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sortStarred(items, sortKey, liveByKey).map((p) => (
                <StarredRow
                  key={p.id}
                  prop={p}
                  live={liveByKey.get(p.id) ?? null}
                  onUnstar={() => unstar(p.id)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function StarredRow({ prop, live, onUnstar }: { prop: StarredProp; live: EliteLegLiveState | null; onUnstar: () => void }) {
  const sportColor = SPORT_COLOR[prop.sport];
  const dateLabel = new Date(prop.starredAt).toLocaleDateString([], {
    month: 'short', day: 'numeric',
  });
  // Drill-link per sport: NBA → /nba/player, MLB → /mlb/player, MMA → /mma/fighter
  const profileHref =
    prop.sport === 'nba' ? `/nba/player/${prop.playerId}`
    : prop.sport === 'mlb' ? `/mlb/player/${prop.playerId}`
    : `/mma/fighter/${prop.playerId}`;

  return (
    <li style={{
      position: 'relative',
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px',
      background: `
        linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 30%),
        var(--surface-1)
      `,
      border: '1px solid var(--border-subtle)',
      borderLeft: `3px solid ${sportColor}`,
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-card)',
      flexWrap: 'wrap',
    }}>
      <span style={{
        fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
        color: sportColor,
        padding: '2px 6px',
        background: `${sportColor}14`,
        border: `1px solid ${sportColor}40`,
        borderRadius: 3,
      }}>
        {SPORT_LABEL[prop.sport]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Link to={profileHref} style={{ color: 'inherit', textDecoration: 'none' }}>
          <div style={{ fontSize: 14, fontWeight: 800 }}>
            {prop.playerName}
            {prop.team && <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.45)', fontSize: 11, fontWeight: 600 }}>{prop.team}</span>}
          </div>
        </Link>
        <div className="muted small" style={{ fontSize: 12, marginTop: 2 }}>
          <span style={{ color: 'rgba(255,255,255,0.85)' }}>{prop.statLabel}</span>{' '}
          <strong>{prop.line}</strong>{' '}
          <span style={{ color: prop.direction === 'OVER' ? '#66bb6a' : '#ef5350', fontWeight: 800 }}>
            {prop.direction === 'OVER' ? '↑' : '↓'}
          </span>
          <span style={{ marginLeft: 10, color: 'rgba(255,255,255,0.45)' }}>
            {prop.snapshot.probability.toFixed(1)}% · {prop.snapshot.edgePercent >= 0 ? '+' : ''}{prop.snapshot.edgePercent.toFixed(1)}pp
          </span>
        </div>
      </div>
      <LiveVerdictPill state={live} />
      <span className="muted small" style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', whiteSpace: 'nowrap' }}>
        starred {dateLabel}
      </span>
      <button
        type="button"
        onClick={onUnstar}
        title="Unstar"
        aria-label="Unstar"
        style={{
          fontSize: 14, fontWeight: 800,
          padding: '4px 10px',
          background: 'transparent',
          color: '#ffd54f',
          border: '1px solid rgba(255,213,79,0.30)',
          borderRadius: 4,
          cursor: 'pointer',
          lineHeight: 1,
        }}
      >
        ★
      </button>
    </li>
  );
}

// Stable sort the watchlist by the user-selected key. Verdict order:
// HIT first, ON_PACE_HIT, IN_FLIGHT, PENDING, PUSH, MISS, ON_PACE_MISS,
// UNGRADED last — matches the Bloomberg "best news at top" convention.
function sortStarred(
  items: StarredProp[],
  sortKey: StarredSortKey,
  liveByKey: Map<string, EliteLegLiveState>,
): StarredProp[] {
  const arr = [...items];
  if (sortKey === 'date') {
    arr.sort((a, b) => b.starredAt - a.starredAt);
  } else if (sortKey === 'sport') {
    const order: Record<Sport, number> = { nba: 0, mlb: 1, mma: 2 };
    arr.sort((a, b) => order[a.sport] - order[b.sport] || b.starredAt - a.starredAt);
  } else if (sortKey === 'verdict') {
    const verdictRank = (id: string) => {
      const s = liveByKey.get(id);
      if (!s) return 7;
      switch (s.verdict) {
        case 'HIT':           return 0;
        case 'ON_PACE_HIT':   return 1;
        case 'IN_FLIGHT':     return 2;
        case 'PENDING':       return 3;
        case 'PUSH':          return 4;
        case 'MISS':          return 5;
        case 'ON_PACE_MISS':  return 6;
        case 'UNGRADED':      return 8;
        default:              return 7;
      }
    };
    arr.sort((a, b) => verdictRank(a.id) - verdictRank(b.id) || b.starredAt - a.starredAt);
  } else if (sortKey === 'edge') {
    arr.sort((a, b) => b.snapshot.edgePercent - a.snapshot.edgePercent);
  }
  return arr;
}

// Export the user's watchlist to CSV. Includes the snapshot taken at
// star-time (so users have the original probability/edge/projection
// even after the slate rolls off) plus the current live verdict and
// value when known. RFC 4180 escaping. Filename auto-stamps today's
// date.
function downloadStarredCsv(
  items: StarredProp[],
  liveByKey: Map<string, EliteLegLiveState>,
): void {
  if (items.length === 0) return;
  const cols = [
    'starred_at', 'sport', 'player', 'team',
    'stat', 'line', 'direction',
    'snapshot_probability_pct', 'snapshot_edge_pp', 'snapshot_projection',
    'live_verdict', 'live_current_value', 'live_game_status',
  ];
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const rows = [cols.join(',')];
  for (const p of items) {
    const live = liveByKey.get(p.id);
    rows.push([
      new Date(p.starredAt).toISOString(),
      // Use the user-facing label (UFC, not MMA) so the downloaded CSV
      // matches what the in-app pill shows. Internal `mma` sport code
      // doesn't appear anywhere in the UI.
      SPORT_LABEL[p.sport],
      esc(p.playerName),
      esc(p.team ?? ''),
      esc(p.statLabel),
      p.line,
      p.direction,
      p.snapshot.probability.toFixed(2),
      p.snapshot.edgePercent.toFixed(2),
      p.snapshot.projection !== null ? p.snapshot.projection.toFixed(2) : '',
      live?.verdict ?? '',
      live?.currentValue ?? '',
      live?.gameStatus ?? '',
    ].join(','));
  }
  const csv = rows.join('\n');
  const ts = new Date().toISOString().slice(0, 10);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `statedge-starred-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
