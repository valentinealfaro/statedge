// History tab on /slate. Shows the snapshotted pre-built parlays
// (Best 2/3/4/5/6 + Wild Card) for each past day and whether they
// won or lost based on actual stats from player_game_logs.
//
// Lazy-grading: the backend resolves a day's actuals the first time
// someone opens this view after games are final. Subsequent visits
// hit the cached result.

import { useEffect, useState } from 'react';
import {
  getSlateHistory,
  type SlateHistoryCombo,
  type SlateHistoryDay,
  type SlateHistoryLeg,
} from './api';
import { Skeleton } from './Skeleton';

function fmtDate(iso: string): string {
  // "YYYY-MM-DD" → "Tue, May 6". Avoids timezone shift by parsing as UTC.
  const [y, m, d] = iso.split('-').map((p) => Number(p));
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function statusBadge(s: SlateHistoryCombo['status']): { label: string; cls: string } {
  if (s === 'won') return { label: '✓ Won', cls: 'won' };
  if (s === 'lost') return { label: '✗ Lost', cls: 'lost' };
  return { label: '⏳ Pending', cls: 'pending' };
}

function legBadge(o: SlateHistoryLeg['outcome']): { label: string; cls: string } {
  if (o === 'hit') return { label: '✓', cls: 'hit' };
  if (o === 'miss') return { label: '✗', cls: 'miss' };
  if (o === 'push') return { label: 'P', cls: 'push' };
  return { label: '—', cls: 'pending' };
}

export function SlateHistory() {
  const [days, setDays] = useState<SlateHistoryDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDate, setOpenDate] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSlateHistory()
      .then((d) => { if (alive) setDays(d); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, []);

  if (error) {
    return (
      <div className="slate-error" style={{ marginTop: 16 }}>
        <strong>History failed:</strong> {error}
      </div>
    );
  }

  if (days === null) {
    return (
      <div className="slate-history-loading">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} width="100%" height={70} style={{ marginBottom: 12 }} />
        ))}
      </div>
    );
  }

  if (days.length === 0) {
    return (
      <div className="slate-empty">
        <h3>No history yet</h3>
        <p className="muted small">
          Once a slate has been published for a day, the pre-built parlays
          (Best 2-6 + Wild Card) get snapshotted and graded against actual
          stats. Check back tomorrow.
        </p>
      </div>
    );
  }

  return (
    <div className="slate-history">
      <p className="muted small" style={{ marginTop: 0 }}>
        Past pre-built parlays graded against actual stats. A combo wins
        if every leg hits its line; pushes count as survival.
      </p>
      <CardTrackRecord days={days} />
      {days.map((day) => {
        const open = openDate === day.date;
        const wonCount = day.combos.filter((c) => c.status === 'won').length;
        const lostCount = day.combos.filter((c) => c.status === 'lost').length;
        const pendingCount = day.combos.filter(
          (c) => c.status !== 'won' && c.status !== 'lost',
        ).length;
        return (
          <div key={day.date} className={`slate-history-day ${open ? 'open' : ''}`}>
            <button
              className="slate-history-day-head"
              onClick={() => setOpenDate(open ? null : day.date)}
              aria-expanded={open}
            >
              <span className="slate-history-date">{fmtDate(day.date)}</span>
              <span className="slate-history-summary">
                {day.status === 'resolved' ? (
                  <>
                    <span className="hd-stat hd-won">{wonCount} W</span>
                    <span className="hd-stat hd-lost">{lostCount} L</span>
                    {pendingCount > 0 && (
                      <span className="hd-stat hd-pending">{pendingCount} pending</span>
                    )}
                  </>
                ) : (
                  <span className="hd-stat hd-pending">
                    {pendingCount > 0 ? `${pendingCount} pending` : 'awaiting games'}
                  </span>
                )}
              </span>
              <span className="slate-history-chevron">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
              <div className="slate-history-body">
                {day.combos.length === 0 && (
                  <p className="muted small">No pre-built parlays were generated for this date.</p>
                )}
                {day.combos.map((c) => (
                  <ComboRow key={c.label} combo={c} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// PrizePicks Flex Play full-clear payouts. Same payout table as MLB
// so the two slate histories speak the same language. Wild Card maps
// to a 3-leg shape on NBA too; B2-B6 cover the rest.
const FLEX_PAYOUTS: Record<string, number> = {
  'Best 2': 3,
  'Best 3': 5,
  'Best 4': 10,
  'Best 5': 7,
  'Best 6': 25,
  'Wild Card': 5,
};

const CARD_TYPE_ORDER = ['Best 2', 'Best 3', 'Best 4', 'Best 5', 'Best 6', 'Wild Card'];

// Rollup of card-type clearance + simulated $1-stake P/L across the
// visible history window. Mirrors the MLB version. NBA combos carry
// status: 'won' | 'lost' | 'pending' so we tally directly.
function CardTrackRecord({ days }: { days: SlateHistoryDay[] }) {
  type Bucket = { days: number; cleared: number; dead: number; pending: number };
  const rollup = new Map<string, Bucket>();
  for (const d of days) {
    for (const c of d.combos) {
      const r = rollup.get(c.label) ?? { days: 0, cleared: 0, dead: 0, pending: 0 };
      r.days += 1;
      if (c.status === 'won') r.cleared += 1;
      else if (c.status === 'lost') r.dead += 1;
      else r.pending += 1;
      rollup.set(c.label, r);
    }
  }
  if (rollup.size === 0) return null;
  const ordered = [
    ...CARD_TYPE_ORDER.filter((n) => rollup.has(n)),
    ...[...rollup.keys()].filter((n) => !CARD_TYPE_ORDER.includes(n)),
  ];

  let totalProfit = 0;
  let totalSettled = 0;
  let totalCleared = 0;
  let totalDead = 0;
  for (const name of ordered) {
    const r = rollup.get(name)!;
    const payout = FLEX_PAYOUTS[name] ?? 1;
    totalProfit += r.cleared * (payout - 1) - r.dead;
    totalSettled += r.cleared + r.dead;
    totalCleared += r.cleared;
    totalDead += r.dead;
  }
  const totalRoi = totalSettled > 0 ? (totalProfit / totalSettled) * 100 : null;
  const totalClearRate = totalSettled > 0 ? Math.round((totalCleared / totalSettled) * 1000) / 10 : null;

  return (
    <div className="mlb-context" style={{ marginBottom: 16 }}>
      <div className="mlb-context-heading">
        Card-type track record <span className="muted small">— whole-card clearance + simulated $1-stake ROI</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="mlb-standings-table" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>Card</th>
              <th className="num">Days</th>
              <th className="num">Cleared</th>
              <th className="num">Dead</th>
              <th className="num">Pending</th>
              <th className="num">Clear rate</th>
              <th className="num">$1 P/L</th>
              <th className="num">ROI</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((name) => {
              const r = rollup.get(name)!;
              const settled = r.cleared + r.dead;
              const clearRate = settled > 0 ? Math.round((r.cleared / settled) * 1000) / 10 : null;
              const payout = FLEX_PAYOUTS[name] ?? 1;
              const profit = r.cleared * (payout - 1) - r.dead;
              const roi = settled > 0 ? (profit / settled) * 100 : null;
              return (
                <tr key={name}>
                  <td><strong>{name}</strong></td>
                  <td className="num">{r.days}</td>
                  <td className="num" style={{ color: r.cleared > 0 ? 'var(--hot, #66bb6a)' : undefined }}>{r.cleared}</td>
                  <td className="num" style={{ color: r.dead > 0 ? '#ef5350' : undefined }}>{r.dead}</td>
                  <td className="num">{r.pending}</td>
                  <td className="num">{clearRate !== null ? `${clearRate.toFixed(1)}%` : '—'}</td>
                  <td
                    className="num"
                    style={{
                      color: profit > 0 ? 'var(--hot, #66bb6a)' : profit < 0 ? '#ef5350' : undefined,
                      fontWeight: 700,
                    }}
                  >
                    {settled === 0 ? '—' : `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`}
                  </td>
                  <td
                    className="num"
                    style={{
                      color: roi !== null && roi > 0 ? 'var(--hot, #66bb6a)' : roi !== null && roi < 0 ? '#ef5350' : undefined,
                      fontWeight: 700,
                    }}
                  >
                    {roi !== null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%` : '—'}
                  </td>
                </tr>
              );
            })}
            <tr style={{ borderTop: '2px solid var(--border-subtle)' }}>
              <td><strong>All cards combined</strong></td>
              <td className="num">—</td>
              <td className="num" style={{ color: totalCleared > 0 ? 'var(--hot, #66bb6a)' : undefined }}><strong>{totalCleared}</strong></td>
              <td className="num" style={{ color: totalDead > 0 ? '#ef5350' : undefined }}><strong>{totalDead}</strong></td>
              <td className="num">—</td>
              <td className="num"><strong>{totalClearRate !== null ? `${totalClearRate.toFixed(1)}%` : '—'}</strong></td>
              <td
                className="num"
                style={{
                  color: totalProfit > 0 ? 'var(--hot, #66bb6a)' : totalProfit < 0 ? '#ef5350' : undefined,
                  fontWeight: 800,
                }}
              >
                <strong>{totalSettled === 0 ? '—' : `${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)}`}</strong>
              </td>
              <td
                className="num"
                style={{
                  color: totalRoi !== null && totalRoi > 0 ? 'var(--hot, #66bb6a)' : totalRoi !== null && totalRoi < 0 ? '#ef5350' : undefined,
                  fontWeight: 800,
                }}
              >
                <strong>{totalRoi !== null ? `${totalRoi >= 0 ? '+' : ''}${totalRoi.toFixed(1)}%` : '—'}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        Hypothetical $1-stake P/L assuming PrizePicks full-clear Flex payouts. Partial-clear payouts
        (4/5, 5/6) aren't credited — the strict version of the metric.
      </p>
    </div>
  );
}

function legProb(leg: SlateHistoryCombo['legs'][number]): number {
  // New snapshots emit `probability`; legacy snapshots have `pct`.
  return leg.probability ?? leg.pct ?? 0;
}

function comboHit(combo: SlateHistoryCombo): number {
  return combo.predictedHit ?? combo.combinedPct ?? 0;
}

function ComboRow({ combo }: { combo: SlateHistoryCombo }) {
  const sb = statusBadge(combo.status);
  return (
    <div className={`slate-history-combo ${combo.tag === 'wild' ? 'wild' : ''}`}>
      <div className="slate-history-combo-head">
        <span className="slate-history-combo-label">{combo.label}</span>
        {combo.subtitle && (
          <span className="slate-history-combo-subtitle">{combo.subtitle}</span>
        )}
        <span className="slate-history-combo-size">{combo.legs.length}-leg</span>
        <span className="slate-history-combo-pct" title="Combined hit probability we predicted at lock time">
          {comboHit(combo).toFixed(1)}% predicted
        </span>
        <span className={`slate-history-combo-status ${sb.cls}`}>{sb.label}</span>
      </div>
      <div className="slate-history-combo-legs">
        {combo.legs.map((leg, i) => {
          const lb = legBadge(leg.outcome);
          const lineLabel = `${leg.direction === 'OVER' ? '↑' : '↓'} ${leg.line}`;
          const actualLabel =
            leg.outcome === 'no_game' || leg.actual === null || leg.actual === undefined
              ? '—'
              : leg.statKey === 'double_double'
                ? leg.actual === 1 ? 'DD' : 'No DD'
                : String(leg.actual);
          return (
            <div key={i} className="slate-history-leg-block">
              <div className="slate-history-leg">
                <span className={`slate-history-leg-badge ${lb.cls}`}>{lb.label}</span>
                <span className="slate-history-leg-name">{leg.playerName}</span>
                <span className="slate-history-leg-stat">{leg.statLabel} {lineLabel}</span>
                <span className="slate-history-leg-actual">
                  Actual <strong>{actualLabel}</strong>
                </span>
                <span className="slate-history-leg-pct">
                  {legProb(leg).toFixed(0)}% predicted
                  {leg.confidenceLabel ? ` · ${leg.confidenceLabel}` : ''}
                </span>
              </div>
              {leg.wildCardReason && (
                <div className="slate-history-leg-evidence">
                  {leg.wildCardReason}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
