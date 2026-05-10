// ActivityFeed — Phase 148m, mounted across the institutional pages
// in iter 36-39.
//
// Bloomberg-style "what just happened to my picks" ticker mounted on
// Home, Dashboard, Best Bets, and Elite — same component, same
// signal, every institutional surface. One unified chronological
// list spanning:
//   - Elite ticket legs that have resolved today (NBA / MLB / UFC)
//   - Starred props the user is following that have resolved today
//     (NBA / MLB / UFC; UFC entered when iter 46 removed the stale
//     'sport !== mma' filter after the live grader was wired)
//
// Sorted by event freshness (most recent first). Self-hides when
// nothing has resolved yet. Each row is click-through to the source
// surface (/elite for elite-leg events, /starred for starred-prop
// events) so users can drill into context without losing the feed.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getEliteLiveState,
  liveGradeLegs,
  type EliteLegLiveState,
} from './api';
import { useStarredProps, type StarredProp, type Sport } from './starredProps';

type FeedRow = {
  key: string;
  sport: Sport | 'cross';
  source: 'elite' | 'starred';
  playerName: string;
  team: string | null;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  verdict: EliteLegLiveState['verdict'];
  currentValue: number | null;
  href: string;
};

const SPORT_COLOR: Record<Sport | 'cross', string> = {
  nba: '#7aa2ff',
  mlb: '#66bb6a',
  mma: '#ef5350',
  cross: '#ffd54f',
};
const SPORT_LABEL: Record<Sport | 'cross', string> = {
  nba: 'NBA',
  mlb: 'MLB',
  mma: 'UFC',
  cross: 'CROSS',
};

function inferSport(statKey: string): Sport {
  const MMA = ['sig_strikes', 'rd1_sig_strikes', 'takedowns', 'rd1_takedowns', 'knockdowns', 'rounds', 'fight_time', 'fantasy_score', 'control_time'];
  const MLB = ['home_runs', 'total_bases', 'rbis', 'runs', 'hits', 'hits_runs_rbis', 'walks', 'stolen_bases', 'strikeouts', 'doubles', 'triples', 'ks', 'pitcher_outs', 'innings_pitched', 'earned_runs_allowed', 'hits_allowed', 'walks_allowed', 'home_runs_allowed'];
  if (MMA.includes(statKey)) return 'mma';
  if (MLB.includes(statKey)) return 'mlb';
  return 'nba';
}

export function ActivityFeed() {
  const { items: starred } = useStarredProps();
  const [rows, setRows] = useState<FeedRow[]>([]);

  // Single combined poll. Fires both /api/slate/elite/live-state and
  // /api/slate/live-grade for the user's starred props, then merges.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const out: FeedRow[] = [];

      // Elite legs
      try {
        const elite = await getEliteLiveState();
        if (!cancelled && elite.legs) {
          for (const leg of elite.legs) {
            // Only emit final / locked-in verdicts.
            if (leg.verdict !== 'HIT' && leg.verdict !== 'ON_PACE_HIT'
              && leg.verdict !== 'MISS' && leg.verdict !== 'ON_PACE_MISS'
              && leg.verdict !== 'PUSH') continue;
            out.push({
              key: `elite-${leg.playerId}-${leg.statKey}`,
              sport: inferSport(leg.statKey),
              source: 'elite',
              playerName: leg.playerName,
              team: null,
              statLabel: leg.statKey,
              line: leg.line,
              direction: leg.direction,
              verdict: leg.verdict,
              currentValue: leg.currentValue,
              href: '/elite',
            });
          }
        }
      } catch { /* silent — no elite data */ }

      // Starred props
      try {
        // All sports grade now (NBA + MLB + UFC). UFC stat keys outside
        // the supported set return UNGRADED, which the rollup filters
        // out below — only HIT/MISS/ON_PACE_* show up as activity tiles.
        const gradable: StarredProp[] = starred.slice(0, 50);
        if (gradable.length > 0) {
          const states = await liveGradeLegs(gradable.map((p) => ({
            playerId: p.playerId,
            espnAthleteId: p.espnAthleteId,
            playerName: p.playerName,
            statKey: p.statKey,
            direction: p.direction,
            line: p.line,
          })));
          if (!cancelled) {
            for (let i = 0; i < states.length; i++) {
              const p = gradable[i]!;
              const s = states[i]!;
              if (s.verdict !== 'HIT' && s.verdict !== 'ON_PACE_HIT'
                && s.verdict !== 'MISS' && s.verdict !== 'ON_PACE_MISS'
                && s.verdict !== 'PUSH') continue;
              out.push({
                key: `starred-${p.id}`,
                sport: p.sport,
                source: 'starred',
                playerName: p.playerName,
                team: p.team,
                statLabel: p.statLabel,
                line: p.line,
                direction: p.direction,
                verdict: s.verdict,
                currentValue: s.currentValue,
                href: '/starred',
              });
            }
          }
        }
      } catch { /* silent */ }

      if (cancelled) return;
      // Most-recent visual order: HIT/MISS first, then PUSH last.
      out.sort((a, b) => {
        const rank = (v: FeedRow['verdict']) =>
          v === 'HIT' || v === 'ON_PACE_HIT' ? 0
          : v === 'MISS' || v === 'ON_PACE_MISS' ? 1
          : 2;
        return rank(a.verdict) - rank(b.verdict);
      });
      setRows(out.slice(0, 12));
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [starred]);

  if (rows.length === 0) return null;

  return (
    <section
      style={{
        position: 'relative',
        margin: '12px auto 16px',
        maxWidth: 1100,
        padding: '14px 18px',
        background: `
          linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
          var(--surface-1)
        `,
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        overflow: 'hidden',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(255,213,79,0.55), transparent)',
      }} />
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 10,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.10em',
          textTransform: 'uppercase', color: '#ffd54f',
        }}>
          Activity feed
        </span>
        <span className="muted small" style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
          · {rows.length} {rows.length === 1 ? 'pick' : 'picks'} settled / locked today
        </span>
      </div>
      <ul style={{
        listStyle: 'none', margin: 0, padding: 0,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 8,
      }}>
        {rows.map((r) => <FeedTile key={r.key} row={r} />)}
      </ul>
    </section>
  );
}

function FeedTile({ row: r }: { row: FeedRow }) {
  const sportColor = SPORT_COLOR[r.sport];
  const isHit = r.verdict === 'HIT' || r.verdict === 'ON_PACE_HIT';
  const isMiss = r.verdict === 'MISS' || r.verdict === 'ON_PACE_MISS';
  const verdictColor = isHit ? '#66bb6a' : isMiss ? '#ef5350' : '#ffd54f';
  const verdictLabel =
    r.verdict === 'HIT' ? '✓ HIT'
    : r.verdict === 'ON_PACE_HIT' ? '✓ ON PACE'
    : r.verdict === 'MISS' ? '✗ MISS'
    : r.verdict === 'ON_PACE_MISS' ? '✗ LOCKED OUT'
    : '— PUSH';
  return (
    <li>
      <Link
        to={r.href}
        style={{
          display: 'block',
          padding: '10px 12px',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 30%), rgba(0,0,0,0.22)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderLeft: `3px solid ${verdictColor}`,
          borderRadius: 'var(--radius-md)',
          textDecoration: 'none',
          color: 'inherit',
          transition: 'transform 200ms cubic-bezier(0.4,0,0.2,1), background 200ms',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
          <span style={{
            fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
            color: sportColor, padding: '1px 5px',
            background: `${sportColor}14`,
            border: `1px solid ${sportColor}40`,
            borderRadius: 3,
          }}>
            {SPORT_LABEL[r.sport]}
          </span>
          <span style={{
            fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
            color: 'rgba(255,255,255,0.55)',
            textTransform: 'uppercase',
          }}>
            {r.source === 'elite' ? '★ Elite leg' : '★ Starred'}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{
            fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
            color: verdictColor,
          }}>
            {verdictLabel}
            {r.currentValue !== null && (
              <span style={{ marginLeft: 4, opacity: 0.85 }}>· {r.currentValue}</span>
            )}
          </span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 800 }}>
          {r.playerName}
          {r.team && <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.45)', fontSize: 11, fontWeight: 600 }}>{r.team}</span>}
        </div>
        <div className="muted small" style={{ fontSize: 11, marginTop: 2 }}>
          <span>{r.statLabel}</span>{' '}
          <strong>{r.line}</strong>{' '}
          <span style={{ color: r.direction === 'OVER' ? '#66bb6a' : '#ef5350', fontWeight: 800 }}>
            {r.direction === 'OVER' ? '↑' : '↓'}
          </span>
        </div>
      </Link>
    </li>
  );
}
