// PlayerStatCalibration — Phase 117.
//
// "Of our last N projections on Aaron Judge home_runs, we beat the
// close in M of them." The truth metric surfaced INSIDE the player
// workflow, where the user is actually looking at the line they're
// considering. Bloomberg-Terminal pattern: every cell drills into
// its provenance.
//
// Drops onto the player log page below the stat picker. Silently
// hides when no graded sample exists — better than showing "—%"
// which broadcasts nothing.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getClv, type ClvRow } from './api';

const STAT_LABEL: Record<string, string> = {
  hits: 'Hits',
  total_bases: 'Total Bases',
  hits_runs_rbis: 'Hits + Runs + RBIs',
  rbis: 'RBIs',
  runs: 'Runs',
  home_runs: 'Home Runs',
  strikeouts: 'Strikeouts',
  stolen_bases: 'Stolen Bases',
  walks: 'Walks',
  ks: 'Pitcher Ks',
  earned_runs_allowed: 'Earned Runs',
  hits_allowed: 'Hits Allowed',
  walks_allowed: 'Walks Allowed',
  innings_pitched: 'Innings Pitched',
  pitcher_outs: 'Pitcher Outs',
  points: 'Points',
  rebounds: 'Rebounds',
  assists: 'Assists',
  three_pt_made: 'Three-Pointers Made',
  steals: 'Steals',
  blocks: 'Blocks',
  pra: 'Points + Reb + Ast',
};

type Props = {
  sport: 'mlb' | 'wnba';
  playerId: number | string;
  statKey: string;
  windowDays?: number;
};

export function PlayerStatCalibration({ sport, playerId, statKey, windowDays = 90 }: Props) {
  const [rows, setRows] = useState<ClvRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    getClv({ sport, windowDays })
      .then((r) => setRows(r.rows))
      .catch(() => setRows([]));
  }, [sport, windowDays]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const idStr = String(playerId);
    return rows.filter(
      (r) =>
        r.statKey === statKey &&
        (String(r.playerId) === idStr || r.playerId === Number(playerId)),
    );
  }, [rows, playerId, statKey]);

  // Loading or no data → render nothing. The card should never
  // broadcast "—%" with low denominator; that's louder than silence.
  if (!filtered) return null;
  if (filtered.length < 2) return null;

  const graded = filtered.filter((r) => r.beatMarket !== null);
  if (graded.length < 2) return null;

  const beats = graded.filter((r) => r.beatMarket === true).length;
  const misses = graded.length - beats;
  const beatRate = (beats / graded.length) * 100;
  const overCount = filtered.filter((r) => r.direction === 'OVER').length;
  const underCount = filtered.length - overCount;

  // Mean signed line delta: tells you which way the market typically
  // moves AFTER we publish. Positive = market drifts up = our overs
  // get less attractive after we publish (or our unders did beat).
  const lineDeltas = graded.map((r) => r.lineDelta).filter((d): d is number => d !== null);
  const avgDelta = lineDeltas.length === 0
    ? null
    : lineDeltas.reduce((s, d) => s + d, 0) / lineDeltas.length;

  const color = beatRate >= 55 ? '#66bb6a'
    : beatRate >= 50 ? '#ffd54f'
    : '#ef5350';
  const bar = beatRate >= 55 ? '✓ above 55% bar' : beatRate >= 50 ? 'tracking' : 'below 50%';

  const label = STAT_LABEL[statKey] ?? statKey;

  return (
    <section style={{
      marginTop: 14,
      padding: 14,
      background: 'linear-gradient(135deg, rgba(102,187,106,0.04) 0%, rgba(122,162,255,0.04) 100%)',
      border: `1px solid ${color}33`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 6,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
      }}>
        StatEdge track record · this player · {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 24, fontWeight: 800, color, lineHeight: 1 }}>
          {beatRate.toFixed(1)}%
        </span>
        <span className="muted small" style={{ fontSize: 12 }}>
          {beats} of {graded.length} projections beat the market close
        </span>
        <span style={{
          fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
          color, padding: '2px 6px',
          background: `${color}1a`, borderRadius: 3,
          textTransform: 'uppercase',
        }}>
          {bar}
        </span>
      </div>
      <div className="muted small" style={{ fontSize: 11, marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>Last {windowDays} days · {filtered.length} total projections</span>
        <span>{overCount} over · {underCount} under · {misses} missed</span>
        {avgDelta !== null && (
          <span title="Mean signed line drift after publish (closing − publish)">
            avg market drift {avgDelta >= 0 ? '+' : ''}{avgDelta.toFixed(2)}
          </span>
        )}
        <Link to="/clv" style={{ color: '#7aa2ff', textDecoration: 'none', fontWeight: 700 }}>
          Full report →
        </Link>
      </div>
    </section>
  );
}
