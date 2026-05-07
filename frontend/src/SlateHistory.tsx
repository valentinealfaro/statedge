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
