// MLB Slate History — date-by-date track record of past published
// slates. Reads /api/mlb/slate/history (Phase 24 endpoint) which
// aggregates from mlb_projection_history.
//
// Mission alignment: accountability is the whole point. We don't
// hide the days the model went 4-and-12; users see the receipt.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '') as string;

type CardBucket = {
  cardType: string;
  legs: number;
  hits: number;
  misses: number;
  pending: number;
  cleared: boolean | null;
};

type DayBucket = {
  date: string;
  totalLegs: number;
  gradedLegs: number;
  hits: number;
  misses: number;
  pending: number;
  hitRate: number | null;
  byCardType?: Record<string, CardBucket>;
};

type StatTypeBucket = {
  stat: string;
  direction: 'OVER' | 'UNDER';
  legs: number;
  hits: number;
  misses: number;
  pending: number;
  hitRate: number | null;
};

type HistoryResponse = {
  windowDays: number;
  days: DayBucket[];
  byStatType?: StatTypeBucket[];
  disclaimer: string;
};

export function MlbSlateHistory() {
  useTitle(['MLB Slate History']);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<30 | 90 | 180>(30);

  useEffect(() => {
    setData(null);
    setError(null);
    fetch(`${API_BASE}/api/mlb/slate/history?windowDays=${windowDays}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [windowDays]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>MLB · Slate History</h1>
        <p className="muted small">
          Past published slates with hit-rate tracking. Each row is one
          calendar day; legs are graded against actual game outcomes
          once games finalize. The model's accountability surface —
          you see the wins and the losses, no cherry-picking.
        </p>

        <div className="mlb-line-row" style={{ marginTop: 8 }}>
          <div className="mlb-direction-toggle">
            {([30, 90, 180] as const).map((w) => (
              <button
                key={w}
                type="button"
                className={`mlb-dir-btn ${windowDays === w ? 'active' : ''}`}
                onClick={() => setWindowDays(w)}
              >
                Last {w} days
              </button>
            ))}
          </div>
        </div>

        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        {!data && !error && <Skeleton width="100%" height={240} style={{ marginTop: 20 }} />}

        {data && data.days.length === 0 && (
          <div className="mlb-info-banner" style={{ marginTop: 16 }}>
            <strong>No slate history yet.</strong> Past published slates will
            appear here once they accumulate. Each card-leg from /mlb/slate
            gets recorded when the day's slate is first viewed; grading
            happens automatically as games finalize over the next 24-48 hrs.
          </div>
        )}

        {data && data.days.length > 0 && <HistoryTable days={data.days} />}
        {data && data.byStatType && data.byStatType.length > 0 && (
          <StatTypeBreakdown buckets={data.byStatType} />
        )}

        {data && (
          <p className="mlb-disclaimer">{data.disclaimer}</p>
        )}
      </div>
    </div>
  );
}

// Standard card-type ordering — keeps the rollup table consistent
// even when a particular card type is missing from a given window.
const CARD_TYPE_ORDER = ['Best 2', 'Best 3', 'Best 4', 'Best 5', 'Best 6', 'Wild Card'];

// PrizePicks Flex Play full-clear payouts. We use FULL clear as the
// net profit basis (cleared = payout − 1, dead = −1). This is the
// hardest version of the metric — partial-clear payouts on 5/6 etc
// aren't credited. If we still show net positive ROI under this
// rule, the platform is genuinely +EV.
const FLEX_PAYOUTS: Record<string, number> = {
  'Best 2': 3,
  'Best 3': 5,
  'Best 4': 10,
  'Best 5': 7,    // PP's 5/5 full Flex
  'Best 6': 25,
  'Wild Card': 5,  // typical 3-leg shape
};

function HistoryTable({ days }: { days: DayBucket[] }) {
  // Cumulative aggregates across the visible window.
  const totals = days.reduce(
    (acc, d) => ({
      totalLegs: acc.totalLegs + d.totalLegs,
      gradedLegs: acc.gradedLegs + d.gradedLegs,
      hits: acc.hits + d.hits,
      misses: acc.misses + d.misses,
      pending: acc.pending + d.pending,
    }),
    { totalLegs: 0, gradedLegs: 0, hits: 0, misses: 0, pending: 0 },
  );
  const cumulativeHitRate =
    totals.gradedLegs > 0
      ? Math.round((totals.hits / totals.gradedLegs) * 1000) / 10
      : null;

  // Card-type rollup across the entire window: how many days did
  // each card type CLEAR (every leg hit) vs DIE (any leg missed)?
  // This is the metric that matters for parlay players — leg hit rate
  // doesn't pay; whole-card clearance does.
  const cardRollup = new Map<string, { cleared: number; dead: number; pending: number; days: number }>();
  for (const d of days) {
    if (!d.byCardType) continue;
    for (const [name, card] of Object.entries(d.byCardType)) {
      const r = cardRollup.get(name) ?? { cleared: 0, dead: 0, pending: 0, days: 0 };
      r.days += 1;
      if (card.cleared === true) r.cleared += 1;
      else if (card.cleared === false) r.dead += 1;
      else r.pending += 1;
      cardRollup.set(name, r);
    }
  }
  const orderedCards = [
    ...CARD_TYPE_ORDER.filter((n) => cardRollup.has(n)),
    ...[...cardRollup.keys()].filter((n) => !CARD_TYPE_ORDER.includes(n)),
  ];

  return (
    <>
      <div className="mlb-projection" style={{ marginTop: 16 }}>
        <div className="mlb-projection-head">
          <h3>Window totals</h3>
          <span className="muted small">{days.length} days</span>
        </div>
        <div className="mlb-projection-grid">
          <div className="mlb-stat" title="Total card-legs published in this window">
            <span className="mlb-stat-label">Legs</span>
            <span className="mlb-stat-value">{totals.totalLegs}</span>
          </div>
          <div className="mlb-stat" title="Legs whose games have finalized and been graded">
            <span className="mlb-stat-label">Graded</span>
            <span className="mlb-stat-value">{totals.gradedLegs}</span>
          </div>
          <div className="mlb-stat" title="Legs that hit their line in the chosen direction">
            <span className="mlb-stat-label">Hits</span>
            <span className="mlb-stat-value">{totals.hits}</span>
          </div>
          <div className="mlb-stat" title="Legs that did not hit">
            <span className="mlb-stat-label">Misses</span>
            <span className="mlb-stat-value">{totals.misses}</span>
          </div>
          <div className="mlb-stat" title="Legs with no actual data yet (games still pending or sync lag)">
            <span className="mlb-stat-label">Pending</span>
            <span className="mlb-stat-value">{totals.pending}</span>
          </div>
          <div className="mlb-stat" title="Bayesian-smoothed hit rate would lift this near 50% with thin samples; this is the raw number.">
            <span className="mlb-stat-label">Hit rate</span>
            <span className="mlb-stat-value">
              {cumulativeHitRate !== null ? `${cumulativeHitRate.toFixed(1)}%` : '—'}
            </span>
          </div>
        </div>
      </div>

      {orderedCards.length > 0 && (
        <div className="mlb-context" style={{ marginTop: 12 }} title="Per-card-type clearance rate + simulated ROI. Cleared = every leg hit. Dead = at least one leg missed.">
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
                  <th className="num" title="Hypothetical $1 stake on this card every day. Cleared = +(payout-1). Dead = -$1. Pending excluded.">$1 P/L</th>
                  <th className="num" title="Return on capital staked across settled days. + means StatEdge beat the payout odds.">ROI</th>
                </tr>
              </thead>
              <tbody>
                {orderedCards.map((name) => {
                  const r = cardRollup.get(name)!;
                  const settled = r.cleared + r.dead;
                  const clearRate = settled > 0 ? Math.round((r.cleared / settled) * 1000) / 10 : null;
                  const payout = FLEX_PAYOUTS[name] ?? 1;
                  const profit = r.cleared * (payout - 1) - r.dead * 1;
                  const roi = settled > 0 ? (profit / settled) * 100 : null;
                  return (
                    <tr key={name}>
                      <td><strong>{name}</strong></td>
                      <td className="num">{r.days}</td>
                      <td className="num" style={{ color: r.cleared > 0 ? 'var(--hot, #66bb6a)' : undefined }}>{r.cleared}</td>
                      <td className="num" style={{ color: r.dead > 0 ? '#ef5350' : undefined }}>{r.dead}</td>
                      <td className="num">{r.pending}</td>
                      <td className="num">
                        {clearRate !== null ? `${clearRate.toFixed(1)}%` : '—'}
                      </td>
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
                {/* Aggregate row across all card types — the "if you played
                    EVERY card every day" version. */}
                {(() => {
                  let totalProfit = 0;
                  let totalSettled = 0;
                  let totalCleared = 0;
                  let totalDead = 0;
                  for (const name of orderedCards) {
                    const r = cardRollup.get(name)!;
                    const payout = FLEX_PAYOUTS[name] ?? 1;
                    totalProfit += r.cleared * (payout - 1) - r.dead * 1;
                    totalSettled += r.cleared + r.dead;
                    totalCleared += r.cleared;
                    totalDead += r.dead;
                  }
                  const totalClearRate = totalSettled > 0
                    ? Math.round((totalCleared / totalSettled) * 1000) / 10
                    : null;
                  const totalRoi = totalSettled > 0 ? (totalProfit / totalSettled) * 100 : null;
                  return (
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
                  );
                })()}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            Hypothetical $1-stake P/L assuming PrizePicks full-clear Flex payouts (B2=3×, B3=5×, B4=10×,
            B5=7×, B6=25×, Wild=5×). Partial-clear payouts (e.g. 4/5) aren't credited — the strict version
            of the metric. Pending days excluded from settled counts.
          </p>
        </div>
      )}

      <div className="mlb-context" style={{ marginTop: 12 }}>
        <div className="mlb-context-heading">Day by day</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="mlb-standings-table" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Legs</th>
                <th className="num">Graded</th>
                <th className="num">Hits</th>
                <th className="num">Misses</th>
                <th className="num">Pending</th>
                <th className="num">Hit %</th>
                <th className="num" title="Sum of $1-stake P/L across every card on that day. Cleared cards = +(payout-1), dead = -1.">Daily P/L</th>
                <th>Cards</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                // Daily P/L: walk the day's byCardType and sum the
                // $1-stake outcome of each card. Pending cards
                // contribute 0.
                let dailyProfit = 0;
                let anySettled = false;
                if (d.byCardType) {
                  for (const [name, card] of Object.entries(d.byCardType)) {
                    const payout = FLEX_PAYOUTS[name] ?? 1;
                    if (card.cleared === true)  { dailyProfit += payout - 1; anySettled = true; }
                    else if (card.cleared === false) { dailyProfit -= 1;     anySettled = true; }
                  }
                }
                return (
                <tr key={d.date}>
                  <td><strong>{d.date}</strong></td>
                  <td className="num">{d.totalLegs}</td>
                  <td className="num">{d.gradedLegs}</td>
                  <td className="num" style={{ color: d.hits > 0 ? 'var(--hot, #66bb6a)' : undefined }}>{d.hits}</td>
                  <td className="num" style={{ color: d.misses > 0 ? '#ef5350' : undefined }}>{d.misses}</td>
                  <td className="num">{d.pending}</td>
                  <td className="num">
                    {d.hitRate !== null ? `${d.hitRate.toFixed(1)}%` : '—'}
                  </td>
                  <td
                    className="num"
                    style={{
                      fontWeight: 700,
                      color: !anySettled ? undefined
                        : dailyProfit > 0 ? 'var(--hot, #66bb6a)'
                        : dailyProfit < 0 ? '#ef5350'
                        : undefined,
                    }}
                  >
                    {!anySettled ? '—' : `${dailyProfit >= 0 ? '+' : ''}$${dailyProfit.toFixed(2)}`}
                  </td>
                  <td>
                    {d.byCardType && Object.keys(d.byCardType).length > 0 ? (
                      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                        {orderedCards
                          .filter((n) => d.byCardType![n])
                          .map((n) => {
                            const c = d.byCardType![n];
                            const color =
                              c.cleared === true ? '#66bb6a'
                              : c.cleared === false ? '#ef5350'
                              : '#7aa2ff';
                            const symbol =
                              c.cleared === true ? '✓'
                              : c.cleared === false ? '✗'
                              : '●';
                            const tooltip =
                              c.cleared === true ? `${n} CLEARED — all ${c.legs} legs hit`
                              : c.cleared === false ? `${n} DEAD — ${c.misses} of ${c.legs} legs missed (${c.hits} hit)`
                              : `${n} pending: ${c.hits} hit, ${c.misses} miss, ${c.pending} pending`;
                            return (
                              <span
                                key={n}
                                title={tooltip}
                                style={{ color, fontWeight: 700, fontSize: 11 }}
                              >
                                {symbol} {n.replace('Best ', 'B')}
                                {c.cleared === false && ` (${c.hits}/${c.legs})`}
                              </span>
                            );
                          })}
                      </span>
                    ) : (
                      <span className="muted small">—</span>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="muted small" style={{ marginTop: 12 }}>
        <Link to="/mlb/calibration" className="footer-link">
          See the calibration breakdown →
        </Link>
        {' · '}
        <Link to="/mlb/slate" className="footer-link">
          ← Back to today's slate
        </Link>
      </p>
    </>
  );
}

// Stat-type rollup — shows where the model has edge vs where it's
// getting beaten. Sorted strongest signal first; thin samples (<5
// legs) sink to the bottom and gray out so users don't over-index.
function StatTypeBreakdown({ buckets }: { buckets: StatTypeBucket[] }) {
  if (buckets.length === 0) return null;
  // Pretty-print stat keys (selected_stat is snake_case)
  const fmt = (s: string): string =>
    s.replace(/_/g, ' ')
      .replace(/\brbis\b/g, 'RBIs')
      .replace(/\bhrs?\b/gi, 'HR')
      .replace(/\bera\b/gi, 'ERA')
      .replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="mlb-context" style={{ marginTop: 12 }} title="Per-stat-type+direction hit rates. Shows where the model has signal and where it doesn't.">
      <div className="mlb-context-heading">
        Stat-type performance <span className="muted small">— where the model has edge</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="mlb-standings-table" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>Stat</th>
              <th>Side</th>
              <th className="num">Legs</th>
              <th className="num">Hits</th>
              <th className="num">Misses</th>
              <th className="num">Pending</th>
              <th className="num">Hit %</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b, i) => {
              const settled = b.hits + b.misses;
              const thin = settled < 5;
              return (
                <tr key={i} style={{ opacity: thin ? 0.55 : 1 }}>
                  <td><strong>{fmt(b.stat)}</strong></td>
                  <td>
                    <span style={{
                      color: b.direction === 'OVER' ? '#66bb6a' : '#7aa2ff',
                      fontWeight: 700,
                      fontSize: 11,
                    }}>
                      {b.direction === 'OVER' ? '↑ OVER' : '↓ UNDER'}
                    </span>
                  </td>
                  <td className="num">{b.legs}</td>
                  <td className="num" style={{ color: b.hits > 0 ? 'var(--hot, #66bb6a)' : undefined }}>{b.hits}</td>
                  <td className="num" style={{ color: b.misses > 0 ? '#ef5350' : undefined }}>{b.misses}</td>
                  <td className="num">{b.pending}</td>
                  <td
                    className="num"
                    title={thin ? 'Thin sample — interpret cautiously' : undefined}
                    style={{
                      fontWeight: 700,
                      color: b.hitRate !== null && b.hitRate >= 60 ? 'var(--hot, #66bb6a)'
                        : b.hitRate !== null && b.hitRate <= 40 ? '#ef5350'
                        : undefined,
                    }}
                  >
                    {b.hitRate !== null ? `${b.hitRate.toFixed(1)}%` : '—'}
                    {thin && <span className="muted small" style={{ marginLeft: 4 }}>·thin</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        Buckets with fewer than 5 settled legs are dimmed — too thin to read
        as signal. Use the calibration page for Bayesian-smoothed numbers.
      </p>
    </div>
  );
}
