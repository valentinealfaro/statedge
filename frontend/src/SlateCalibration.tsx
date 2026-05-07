// Calibration view — "we said X%, actuals say Y%". Reads the
// /slate/calibration endpoint, which aggregates every graded snapshot
// in slate_results and reports predicted-vs-actual hit rate by
// probability bucket, stat, confidence tier, and risk tier.
//
// Hit rates are Bayesian-smoothed (prior 11/20 ≈ 55%) so 0/1 doesn't
// show as 0% and 1/1 doesn't show as 100% — the dashboard renders an
// honest, statistically-stable picture even on small samples. Each
// bucket carries its own status label so the user can see at a
// glance which categories are well-calibrated and which need work.

import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  getSlateCalibration,
  type CalibrationBucket,
  type CalibrationReport,
  type CalibrationStatus,
  type DailyCalibrationPoint,
  type ProjectionErrorSummary,
  type RollingWindows,
  type SampleConfidence,
} from './api';
import { Skeleton } from './Skeleton';

// Defensive coercion — JSON serialization turns NaN/Infinity into
// null, which would crash .toFixed(). If any numeric field comes
// through as null/undefined/NaN we treat it as 0 rather than
// blanking the page.
function n(x: number | null | undefined): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

// Smoothed hit rate is the new canonical "actual" — older responses
// may not carry it; fall back to the raw value for backward compat.
function smoothed(b: CalibrationBucket): number {
  return n(b.smoothedHitRate ?? b.actualHitRate);
}

function calError(b: CalibrationBucket): number {
  return n(b.calibrationError ?? b.gap);
}

function fmtRange(start: string | null, end: string | null): string {
  if (!start || !end) return 'No graded days yet';
  if (start === end) return start;
  return `${start} → ${end}`;
}

// Status → CSS class. Keeps the cell coloring consistent across
// buckets (green/blue for calibrated/under-confident, amber for
// drift, red for poor or dangerous).
function statusClass(s: CalibrationStatus | undefined): string {
  switch (s) {
    case 'Excellent Calibration':     return 'cal-status excellent';
    case 'Good Calibration':          return 'cal-status good';
    case 'Underconfident':            return 'cal-status under';
    case 'Moderate Drift':            return 'cal-status drift';
    case 'Poor Calibration':          return 'cal-status poor';
    case 'Dangerously Overconfident': return 'cal-status danger';
    default:                          return 'cal-status';
  }
}

function sampleClass(s: SampleConfidence | undefined): string {
  switch (s) {
    case 'Highly Stable':   return 'sample-conf stable';
    case 'Strong':          return 'sample-conf strong';
    case 'Stabilizing':     return 'sample-conf stabilizing';
    case 'Low Confidence':  return 'sample-conf low';
    case 'Experimental':    return 'sample-conf experimental';
    default:                return 'sample-conf';
  }
}

// Inline error sign — positive prefixed with "+", with one decimal.
function fmtError(error: number): string {
  return `${error >= 0 ? '+' : ''}${error.toFixed(1)}`;
}

const ERROR_TOOLTIP =
  'Predicted % minus the Bayesian-smoothed actual hit rate. '
  + 'Positive = we overestimated (overconfident). '
  + 'Negative = we underestimated (under-sold). '
  + 'Hit rate uses a prior of 11 hits over 20 samples (≈55%) '
  + 'so tiny samples get pulled toward a realistic baseline.';

export function SlateCalibration() {
  const [report, setReport] = useState<CalibrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSlateCalibration()
      .then((r) => { if (alive) setReport(r); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, []);

  if (error) {
    return (
      <div className="slate-error" style={{ marginTop: 16 }}>
        <strong>Calibration failed:</strong> {error}
      </div>
    );
  }

  if (report === null) {
    return (
      <div className="slate-history-loading">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} width="100%" height={70} style={{ marginBottom: 12 }} />
        ))}
      </div>
    );
  }

  if (report.legsAnalyzed === 0) {
    return (
      <div className="slate-empty">
        <h3>No graded picks yet</h3>
        <p className="muted small">
          Calibration aggregates from past days where the History tab has
          already graded picks against actuals. Visit the History tab so
          past days resolve, then come back here.
        </p>
      </div>
    );
  }

  return (
    <div className="slate-calibration">
      <div className="slate-calibration-head">
        <p className="muted small" style={{ marginTop: 0 }}>
          Predicted hit % vs Bayesian-smoothed actual hit rate, aggregated
          across past graded picks. Push counts as a hit (matches the
          parlay grader). Tiny samples get pulled toward a realistic ~55%
          prior so 0/1 ≠ 0% and 1/1 ≠ 100%.
        </p>
        <div className="slate-calibration-meta">
          <span><strong>{report.legsAnalyzed}</strong> graded legs</span>
          <span>·</span>
          <span><strong>{report.daysAnalyzed}</strong> days</span>
          <span>·</span>
          <span>{fmtRange(report.rangeStart, report.rangeEnd)}</span>
          {report.overall.sampleConfidence && (
            <>
              <span>·</span>
              <span className={sampleClass(report.overall.sampleConfidence)}>
                {report.overall.sampleConfidence}
              </span>
            </>
          )}
        </div>
      </div>

      <OverallBanner b={report.overall} />

      {report.windows && (
        <RollingTiles windows={report.windows} />
      )}

      {report.series && report.series.length > 0 && (
        <DailySeriesChart series={report.series} />
      )}

      <BucketTable
        title="By probability bucket"
        buckets={report.byProbability}
        labelHeader="Probability"
      />
      <BucketTable
        title="By stat"
        buckets={report.byStat}
        labelHeader="Stat"
      />
      <BucketTable
        title="By confidence tier"
        buckets={report.byConfidence}
        labelHeader="Confidence"
      />
      {report.byRisk && report.byRisk.some((b) => b.sampleSize > 0) && (
        <BucketTable
          title="By risk tier"
          buckets={report.byRisk}
          labelHeader="Risk"
        />
      )}
      {report.byArchetype && report.byArchetype.length > 0 && (
        <BucketTable
          title="By volatility archetype"
          buckets={report.byArchetype}
          labelHeader="Archetype"
        />
      )}
      {report.projectionError && (
        <ProjectionAccuracy err={report.projectionError} />
      )}
    </div>
  );
}

// "Did the projected stat value land near the actual?" Independent
// from hit-rate calibration: a model can hit 70% of its lines and
// still systematically under-project the actual stat by 3 points.
// Surfaces mean/median miss + absolute miss + over/under bias.
function ProjectionAccuracy({ err }: { err: ProjectionErrorSummary }) {
  const meanMiss = n(err.meanMiss);
  const median = n(err.medianMiss);
  const abs = n(err.meanAbsoluteMiss);
  const under = n(err.underProjectionRate);
  const over = n(err.overProjectionRate);
  // Verdict copy keyed off the signed mean miss + bias rates.
  let verdict = 'Projections track actuals tightly — no systematic bias.';
  if (meanMiss > 1) {
    verdict = `Model under-projects on average: actuals come in ${meanMiss.toFixed(1)} stat units higher.`;
  } else if (meanMiss < -1) {
    verdict = `Model over-projects on average: actuals come in ${Math.abs(meanMiss).toFixed(1)} stat units lower.`;
  } else if (Math.abs(under - over) >= 15) {
    verdict =
      under > over
        ? 'Projections skew low — actuals beat the projection more often than not.'
        : 'Projections skew high — actuals fall short more often than not.';
  }
  return (
    <div className="slate-calibration-section">
      <h3>Projection accuracy</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        How close the projected stat value lands to the actual game-end
        value. Hit-rate calibration tells you if 70% means 70%; this
        tells you if "we said 28 points" tends to land near 28.
      </p>
      <div className="proj-accuracy">
        <div className="proj-accuracy-stat">
          <span className="muted small">Mean miss (signed)</span>
          <strong>{meanMiss >= 0 ? '+' : ''}{meanMiss.toFixed(1)}</strong>
        </div>
        <div className="proj-accuracy-stat">
          <span className="muted small">Median miss</span>
          <strong>{median >= 0 ? '+' : ''}{median.toFixed(1)}</strong>
        </div>
        <div className="proj-accuracy-stat">
          <span className="muted small">Mean absolute miss</span>
          <strong>{abs.toFixed(1)}</strong>
        </div>
        <div className="proj-accuracy-stat">
          <span className="muted small">Under-projected</span>
          <strong>{under.toFixed(0)}%</strong>
        </div>
        <div className="proj-accuracy-stat">
          <span className="muted small">Over-projected</span>
          <strong>{over.toFixed(0)}%</strong>
        </div>
        <div className="proj-accuracy-stat">
          <span className="muted small">Sample</span>
          <strong>{err.sampleSize}</strong>
        </div>
      </div>
      <div className="muted small" style={{ marginTop: 8 }}>{verdict}</div>
    </div>
  );
}

function OverallBanner({ b }: { b: CalibrationBucket }) {
  if (b.sampleSize === 0) return null;
  const pred = n(b.predictedAvg);
  const actual = smoothed(b);
  const error = calError(b);
  const status = b.status;
  return (
    <div className="slate-calibration-overall">
      <div className="slate-calibration-overall-row">
        <span className="slate-calibration-overall-label">Overall</span>
        <span className="slate-calibration-overall-pred">
          predicted <strong>{pred.toFixed(1)}%</strong>
        </span>
        <span className="slate-calibration-overall-actual">
          actual <strong>{actual.toFixed(1)}%</strong>
        </span>
        <span className={statusClass(status)}>
          {fmtError(error)} · {status ?? 'Calibrated'}
        </span>
      </div>
      <div className="muted small">
        {status === 'Dangerously Overconfident' && (
          <>The model is dangerously overconfident — predictions claimed substantially higher hit rates than they delivered. Treat predicted % as a ceiling, not the actual.</>
        )}
        {status === 'Poor Calibration' && (
          <>The model is poorly calibrated — there's a meaningful gap between predicted and actual hit rates. Look for which buckets are driving it below.</>
        )}
        {status === 'Moderate Drift' && (
          <>The model is moderately off — within tolerance for an experimental sample, but worth watching as the dataset grows.</>
        )}
        {status === 'Good Calibration' && (
          <>Predicted % tracks actuals within ±7 points — solid calibration.</>
        )}
        {status === 'Excellent Calibration' && (
          <>Predicted % tracks actuals within ±3 points — the model is accurately self-aware.</>
        )}
        {status === 'Underconfident' && (
          <>The model is under-selling — picks delivered noticeably better than claimed.</>
        )}
      </div>
    </div>
  );
}

// Four "at-a-glance" tiles above the daily chart — last 7/30 days
// (calendar-bounded) and last 100/500 picks (count-bounded). Empty
// tiles render greyed out so the layout doesn't shift before data
// accrues.
function RollingTiles({ windows }: { windows: RollingWindows }) {
  const tiles: Array<{ key: string; label: string; b: CalibrationBucket }> = [
    { key: 'last7Days', label: 'Last 7 days', b: windows.last7Days },
    { key: 'last30Days', label: 'Last 30 days', b: windows.last30Days },
    { key: 'last100Picks', label: 'Last 100 picks', b: windows.last100Picks },
    { key: 'last500Picks', label: 'Last 500 picks', b: windows.last500Picks },
  ];
  return (
    <div className="slate-calibration-section">
      <h3>Rolling accuracy</h3>
      <div className="rolling-tiles">
        {tiles.map(({ key, label, b }) => {
          const empty = b.sampleSize === 0;
          const pred = n(b.predictedAvg);
          const actual = smoothed(b);
          const error = calError(b);
          return (
            <div key={key} className={`rolling-tile ${empty ? 'empty' : ''}`}>
              <div className="rolling-tile-label">{label}</div>
              {empty ? (
                <div className="rolling-tile-empty muted small">No data yet</div>
              ) : (
                <>
                  <div className="rolling-tile-numbers">
                    <span>
                      <span className="muted small">predicted</span>{' '}
                      <strong>{pred.toFixed(1)}%</strong>
                    </span>
                    <span>
                      <span className="muted small">actual</span>{' '}
                      <strong>{actual.toFixed(1)}%</strong>
                    </span>
                  </div>
                  <div className={statusClass(b.status)}>
                    {fmtError(error)} · {b.status ?? 'Calibrated'}
                  </div>
                  <div className="muted small rolling-tile-meta">
                    n={b.sampleSize} · {b.sampleConfidence ?? '—'}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Line chart of predicted % vs actual smoothed % per slate date.
// Shows model improvement, decay, and meta shifts the way no
// summary table can. Uses Recharts (already in the bundle from the
// Last10View / ComparisonView pages).
function DailySeriesChart({ series }: { series: DailyCalibrationPoint[] }) {
  // Format dates short ("May 6") for x-axis tick labels.
  const data = series.map((p) => {
    const [y, m, d] = p.date.split('-').map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d!));
    const short = dt.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    return {
      ...p,
      shortDate: short,
      // Recharts gets confused if smoothedHitRate is 0 for an empty
      // bucket — replace with null so the line breaks gracefully.
      predictedAvg: p.sampleSize > 0 ? p.predictedAvg : null,
      smoothedHitRate: p.sampleSize > 0 ? p.smoothedHitRate : null,
    };
  });
  return (
    <div className="slate-calibration-section">
      <h3>Predicted vs actual over time</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        Daily predicted hit % (blue) plotted against the Bayesian-smoothed
        actual hit rate (green). Tight tracking = well-calibrated; large
        persistent gap = systematic over- or underconfidence.
      </p>
      <div className="rolling-chart">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#1f2330" strokeDasharray="3 3" />
            <XAxis
              dataKey="shortDate"
              stroke="#5a6378"
              tick={{ fontSize: 11 }}
              minTickGap={20}
            />
            <YAxis
              stroke="#5a6378"
              tick={{ fontSize: 11 }}
              domain={[40, 100]}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              contentStyle={{
                background: '#14171f',
                border: '1px solid #1f2330',
                borderRadius: 8,
                fontSize: 12,
              }}
              // Recharts' typed Formatter narrows ValueType to a union of
              // number | string | (number | string)[]. Coerce defensively
              // so the tooltip works for either shape.
              formatter={((v: unknown, name: unknown) => {
                if (v === null || v === undefined) return ['—', String(name)];
                if (typeof v === 'number') return [`${v.toFixed(1)}%`, String(name)];
                return [String(v), String(name)];
              }) as never}
              labelStyle={{ color: '#c8cfdc' }}
            />
            {/* 50% line as a reference — calibration error bands either side */}
            <ReferenceLine y={50} stroke="#2a2f3a" strokeDasharray="2 4" />
            <Line
              type="monotone"
              dataKey="predictedAvg"
              name="Predicted"
              stroke="#5b8def"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="smoothedHitRate"
              name="Actual (smoothed)"
              stroke="#6dd07a"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function BucketTable({
  title,
  buckets,
  labelHeader,
}: {
  title: string;
  buckets: CalibrationBucket[];
  labelHeader: string;
}) {
  const populated = buckets.filter((b) => b.sampleSize > 0);
  if (populated.length === 0) return null;
  return (
    <div className="slate-calibration-section">
      <h3>{title}</h3>
      <div className="slate-calibration-table">
        <div className="slate-calibration-row head">
          <span>{labelHeader}</span>
          <span>n</span>
          <span>Confidence</span>
          <span>Predicted</span>
          <span>Actual</span>
          <span title={ERROR_TOOLTIP}>Calibration Error</span>
        </div>
        {populated.map((b) => {
          const pred = n(b.predictedAvg);
          const actual = smoothed(b);
          const error = calError(b);
          return (
            <div key={b.label} className="slate-calibration-row">
              <span className="slate-calibration-bucket-label">{b.label}</span>
              <span>{b.sampleSize}</span>
              <span className={sampleClass(b.sampleConfidence)}>
                {b.sampleConfidence ?? '—'}
              </span>
              <span>{pred.toFixed(1)}%</span>
              <span>{actual.toFixed(1)}%</span>
              <span className={statusClass(b.status)} title={b.status}>
                {fmtError(error)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
