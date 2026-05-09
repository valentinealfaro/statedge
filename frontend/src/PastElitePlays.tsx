// PastElitePlays — Phase 141 + 142.
//
// Historical track record on /elite. Reads from the structured
// elite_tickets ledger (Phase 142) so it can show ✓ HIT / ✗ MISS
// verdicts when game outcomes have settled, plus the legs-hit count
// for partial-credit visibility.
//
// Builds institutional credibility — users see a track record with
// real verdicts, not marketing claims.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getEliteHistory, type StoredEliteTicket } from './api';

export function PastElitePlays() {
  const [tickets, setTickets] = useState<StoredEliteTicket[] | null>(null);

  useEffect(() => {
    getEliteHistory({ limit: 20 })
      .then((r) => setTickets(r.tickets))
      .catch(() => setTickets([]));
  }, []);

  if (!tickets || tickets.length === 0) return null;

  // Today's ticket is rendered above this section by the main /elite
  // page; skip the most recent if it matches today (ET).
  const todayEt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const past = tickets[0]?.ticketDate === todayEt
    ? tickets.slice(1)
    : tickets;
  if (past.length === 0) return null;

  // Compute aggregate hit rate over GRADED tickets (HONEST: ungraded
  // tickets don't pollute the ratio).
  const graded = past.filter((t) => t.hitOrMiss !== null);
  const hits = graded.filter((t) => t.hitOrMiss === true).length;
  const hitRate = graded.length > 0 ? (hits / graded.length) * 100 : null;

  return (
    <section style={{
      marginTop: 32, padding: 20,
      background: 'rgba(0,0,0,0.2)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>
          Past Elite plays
        </h2>
        {hitRate !== null && graded.length >= 3 && (
          <span style={{
            fontSize: 11, fontWeight: 800, letterSpacing: '0.04em',
            padding: '3px 9px',
            color: hitRate >= 60 ? '#66bb6a' : hitRate >= 40 ? '#ffd54f' : '#ef5350',
            background: hitRate >= 60 ? 'rgba(102,187,106,0.12)' : hitRate >= 40 ? 'rgba(255,213,79,0.12)' : 'rgba(239,83,80,0.12)',
            border: `1px solid ${hitRate >= 60 ? 'rgba(102,187,106,0.4)' : hitRate >= 40 ? 'rgba(255,213,79,0.4)' : 'rgba(239,83,80,0.4)'}`,
            borderRadius: 3,
            textTransform: 'uppercase',
          }}>
            {hitRate.toFixed(1)}% hit · {hits}/{graded.length}
          </span>
        )}
      </div>

      <p className="muted small" style={{ margin: '0 0 14px', fontSize: 12, lineHeight: 1.5 }}>
        Every Elite ticket the engine has produced. Verdict (✓ HIT / ✗ MISS) populates
        as game outcomes settle. Partial-grade rows show "{'{'}n of m legs hit{'}'}" so
        you can see how close near-miss tickets came.
      </p>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {past.map((t) => <PastTicketItem key={t.id} ticket={t} />)}
      </ul>
    </section>
  );
}

function PastTicketItem({ ticket }: { ticket: StoredEliteTicket }) {
  const gradeColor = ticket.grade === 'A+' ? '#66bb6a'
    : ticket.grade === 'A' ? '#7aa2ff'
    : '#ffd54f';

  const date = new Date(ticket.ticketDate + 'T12:00:00').toLocaleDateString([], {
    month: 'short', day: 'numeric',
  });

  const sportsLabel = ticket.sportsCovered.length === 1
    ? ticket.sportsCovered[0]!.toUpperCase()
    : ticket.sportsCovered.map((s) => s.toUpperCase()).join('+');

  // Verdict badge — only shown when graded
  let verdictBadge: React.ReactNode = null;
  if (ticket.hitOrMiss === true) {
    verdictBadge = <span style={{ fontSize: 11, fontWeight: 800, color: '#66bb6a' }}>✓ HIT</span>;
  } else if (ticket.hitOrMiss === false) {
    const partial = ticket.legsHit !== null && ticket.legsHit > 0;
    verdictBadge = (
      <span style={{ fontSize: 11, fontWeight: 800, color: '#ef5350' }}>
        ✗ MISS{partial ? ` (${ticket.legsHit}/${ticket.legsTotal})` : ''}
      </span>
    );
  } else {
    verdictBadge = <span className="muted small" style={{ fontSize: 10, fontStyle: 'italic' }}>pending grade</span>;
  }

  return (
    <li style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '10px 12px',
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderLeft: `3px solid ${gradeColor}`,
      borderRadius: 5,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
        color: 'rgba(255,255,255,0.55)',
        minWidth: 56, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}>
        {date}
      </div>
      <div style={{
        fontSize: 18, fontWeight: 900, color: gradeColor,
        minWidth: 36,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}>
        {ticket.grade}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {ticket.combinedFairPayout.toFixed(1)}× · {ticket.tier} · {sportsLabel}
        </div>
        <div className="muted small" style={{ fontSize: 11, marginTop: 2 }}>
          {ticket.tierName}
          {' · '}
          {ticket.combinedProbability.toFixed(1)}% combined hit
          {' · '}
          {ticket.combinedEdgePercent.toFixed(1)}pp edge
        </div>
      </div>
      <div style={{ whiteSpace: 'nowrap' }}>
        {verdictBadge}
      </div>
    </li>
  );
}
