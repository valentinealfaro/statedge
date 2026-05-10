// EliteHeatmap — Phase 148e.
//
// Bloomberg-style visual track record: 90-day grid of every Elite
// ticket published, colored by verdict. Each cell is one day. Hover
// reveals tier + grade + verdict + payout. Self-hides when fewer than
// 3 graded days exist (early-life signal-vs-noise honesty).
//
// The point: institutional users want to scan the track record in 2
// seconds, not parse a list. A heatmap makes "we hit X of last Y"
// pattern-visible at a glance, and the gold/red/green palette reads
// the right way without legend lookups.

import { useEffect, useMemo, useState } from 'react';
import { getEliteHistory, type StoredEliteTicket } from './api';

const DAYS = 90;

type DayCell = {
  date: string;   // YYYY-MM-DD ET
  ticket: StoredEliteTicket | null;
};

export function EliteHeatmap() {
  const [tickets, setTickets] = useState<StoredEliteTicket[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getEliteHistory({ limit: 100 })
      .then((r) => { if (!cancelled) setTickets(r.tickets); })
      .catch(() => { if (!cancelled) setTickets([]); });
    return () => { cancelled = true; };
  }, []);

  const cells = useMemo<DayCell[]>(() => {
    if (!tickets) return [];
    const byDate = new Map<string, StoredEliteTicket>();
    for (const t of tickets) byDate.set(t.ticketDate, t);
    const out: DayCell[] = [];
    // Build trailing-90-day window in ET. Today's date in ET:
    const todayEt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const [y, m, d] = todayEt.split('-').map((n) => Number(n));
    const cursor = new Date(Date.UTC(y!, m! - 1, d!));
    for (let i = DAYS - 1; i >= 0; i--) {
      const dt = new Date(cursor);
      dt.setUTCDate(dt.getUTCDate() - i);
      const iso = dt.toISOString().slice(0, 10);
      out.push({ date: iso, ticket: byDate.get(iso) ?? null });
    }
    return out;
  }, [tickets]);

  // Don't render until we have a meaningful sample. Fewer than 3 graded
  // days means signal/noise is too low for a heatmap to read honestly.
  const gradedDays = cells.filter((c) => c.ticket?.hitOrMiss !== null && c.ticket?.hitOrMiss !== undefined).length;
  if (!tickets || gradedDays < 3) return null;

  // Aggregate stats for the title row.
  const hits = cells.filter((c) => c.ticket?.hitOrMiss === true).length;
  const misses = cells.filter((c) => c.ticket?.hitOrMiss === false).length;
  const ungraded = cells.filter((c) => c.ticket && c.ticket.hitOrMiss === null).length;
  const empty = cells.filter((c) => !c.ticket).length;
  const hitRate = hits + misses > 0 ? (hits / (hits + misses)) * 100 : null;

  // Group cells into weeks (columns). Each week is 7 days, anchored
  // on Sunday. We pad the first week with empty placeholders so the
  // grid aligns to weekday rows (Sun = top, Sat = bottom).
  const weeks: Array<Array<DayCell | null>> = [];
  let week: Array<DayCell | null> = [];
  // Find day-of-week of first cell. Date string YYYY-MM-DD parsed in
  // UTC gives us deterministic weekday (matches cell ordering).
  const firstDow = new Date(`${cells[0]!.date}T12:00:00Z`).getUTCDay();
  for (let i = 0; i < firstDow; i++) week.push(null);
  for (const c of cells) {
    week.push(c);
    const dow = new Date(`${c.date}T12:00:00Z`).getUTCDay();
    if (dow === 6) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }

  return (
    <section
      className="fade-up"
      style={{
        position: 'relative',
        marginTop: 18, padding: '16px 18px',
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
        background: 'linear-gradient(90deg, transparent, rgba(255,213,79,0.50), transparent)',
      }} />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.10em',
          textTransform: 'uppercase', color: '#ffd54f',
        }}>
          ★ Elite track record · 90 days
        </span>
        <span className="muted small" style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
          ·
        </span>
        {hitRate !== null && (
          <span style={{
            fontSize: 11, fontWeight: 800, letterSpacing: '0.04em',
            color: hitRate >= 60 ? '#66bb6a' : hitRate >= 40 ? '#ffd54f' : '#ef5350',
          }}>
            {hitRate.toFixed(1)}% hit · {hits}/{hits + misses}
          </span>
        )}
        <span className="muted small" style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
          {ungraded > 0 && `${ungraded} ungraded · `}
          {empty} no ticket
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', overflowX: 'auto' }}>
        {/* Day-of-week labels */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 3,
          fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
          color: 'rgba(255,255,255,0.40)',
          paddingTop: 0,
        }}>
          {['Sun', '', 'Tue', '', 'Thu', '', 'Sat'].map((d, i) => (
            <span key={i} style={{ height: 14, lineHeight: '14px' }}>{d}</span>
          ))}
        </div>

        {/* Heatmap grid */}
        <div style={{ display: 'flex', gap: 3 }}>
          {weeks.map((wk, wi) => (
            <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {wk.map((cell, di) => <Cell key={di} cell={cell} />)}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div style={{
        marginTop: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', color: 'rgba(255,255,255,0.55)',
      }}>
        <Swatch color="#66bb6a" /> Hit
        <Swatch color="#ef5350" /> Miss
        <Swatch color="#ffd54f" /> Ungraded
        <Swatch color="rgba(255,255,255,0.08)" /> No ticket
      </div>
    </section>
  );
}

function Cell({ cell }: { cell: DayCell | null }) {
  if (!cell) {
    return <div style={{ width: 14, height: 14 }} />;
  }
  const t = cell.ticket;
  let bg = 'rgba(255,255,255,0.06)';
  let label = `No ticket on ${cell.date}`;
  if (t) {
    if (t.hitOrMiss === true) {
      bg = '#66bb6a';
      label = `${cell.date} · ✓ HIT · ${t.grade} · ${t.combinedFairPayout.toFixed(1)}× · ${t.tierName}`;
    } else if (t.hitOrMiss === false) {
      bg = '#ef5350';
      const partial = t.legsHit !== null && t.legsHit > 0
        ? ` (${t.legsHit}/${t.legsTotal})` : '';
      label = `${cell.date} · ✗ MISS${partial} · ${t.grade} · ${t.tierName}`;
    } else {
      bg = '#ffd54f';
      label = `${cell.date} · pending grade · ${t.grade} · ${t.combinedFairPayout.toFixed(1)}× · ${t.tierName}`;
    }
  }
  return (
    <div
      title={label}
      style={{
        width: 14, height: 14,
        background: bg,
        borderRadius: 2,
        cursor: 'help',
        transition: 'transform var(--motion-fast)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.4)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
    />
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>
      <span style={{
        display: 'inline-block', width: 10, height: 10, background: color, borderRadius: 2,
      }} />
    </span>
  );
}
