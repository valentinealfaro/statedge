// MLB calibration page — predicted vs observed accuracy buckets.
// This is the truth-and-accountability surface per the mission.
//
// Honestly handles the empty state: if no projections have been
// graded yet (no slates published with gameDate, or games haven't
// finished), the page shows what's missing rather than fake numbers.

import { useEffect, useState } from 'react';
import {
  getMlbCalibration,
  type MlbCalibrationBucket,
  type MlbCalibrationReport,
} from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

export function MlbCalibration() {
  useTitle(['MLB Calibration']);
  const [report, setReport] = useState<MlbCalibrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<30 | 90>(30);

  useEffect(() => {
    setReport(null);
    setError(null);
    getMlbCalibration(windowDays)
      .then(setReport)
      .catch((err: Error) => setError(err.message));
  }, [windowDays]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>MLB · Calibration</h1>
        <p className="muted small">
          Predicted vs observed accuracy across the rolling window. Bayesian-
          smoothed hit rates so thin samples don't fake-claim accuracy.
          Pushes are excluded from the math.
        </p>

        <div className="mlb-line-row" style={{ marginTop: 8 }}>
          <div className="mlb-direction-toggle">
            <button
              type="button"
              className={`mlb-dir-btn ${windowDays === 30 ? 'active' : ''}`}
              onClick={() => setWindowDays(30)}
            >
              Last 30 days
            </button>
            <button
              type="button"
              className={`mlb-dir-btn ${windowDays === 90 ? 'active' : ''}`}
              onClick={() => setWindowDays(90)}
            >
              Last 90 days
            </button>
          </div>
        </div>

        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}

        {!report && !error && (
          <Skeleton width="100%" height={240} style={{ marginTop: 20 }} />
        )}

        {report && <CalibrationView report={report} />}
      </div>
    </div>
  );
}

function CalibrationView({ report }: { report: MlbCalibrationReport }) {
  const empty = report.totalGraded === 0;
  return (
    <div className="mlb-slate-result">
      {empty && (
        <div className="mlb-info-banner">
          <strong>No graded projections yet.</strong> Calibration becomes
          meaningful once published slates have been graded against actual
          stats. Build a slate via <code>POST /api/mlb/slate</code> with a{' '}
          <code>gameDate</code>, then check back after the games finish and
          the next sync runs.
          {report.gradedThisRequest && report.gradedThisRequest.scanned > 0 && (
            <> · This request scanned {report.gradedThisRequest.scanned} ungraded row(s).</>
          )}
        </div>
      )}

      {!empty && (
        <>
          <div className="mlb-projection">
            <div className="mlb-projection-head">
              <h3>Overall</h3>
              <CalibrationVerdict report={report} />
            </div>
            <div className="mlb-projection-grid">
              <Stat label="Graded" value={String(report.totalGraded)} />
              <Stat label="Hits"   value={String(report.totalHits)} />
              <Stat label="Misses" value={String(report.totalMisses)} />
              <Stat label="Hit rate (raw)" value={`${report.overallHitRate.toFixed(1)}%`} />
              <Stat label="Hit rate (smoothed)" value={`${report.smoothedHitRate.toFixed(1)}%`}
                hint="Bayesian-smoothed against an 11-of-20 prior. Thin samples pulled toward 55%." />
              <Stat label="Avg predicted" value={`${report.averagePredicted.toFixed(1)}%`} />
              <Stat label="Calibration gap"
                value={`${report.calibrationGap >= 0 ? '+' : ''}${report.calibrationGap.toFixed(1)}%`}
                hint="Observed minus predicted. Positive = model underclaimed; negative = overclaimed." />
            </div>
          </div>
        </>
      )}

      <BucketTable title="By predicted probability" buckets={report.byProbability} />
      <BucketTable title="By stat type"             buckets={report.byStatType} />
      <BucketTable title="By risk tier"             buckets={report.byRiskTier} />
      <BucketTable title="By card type"             buckets={report.byCardType} />

      <p className="mlb-disclaimer">{report.disclaimer}</p>
    </div>
  );
}

function CalibrationVerdict({ report }: { report: MlbCalibrationReport }) {
  if (report.totalGraded < 30) {
    return <span className="mlb-projection-verdict ev-neutral">Sample too thin</span>;
  }
  const gap = report.calibrationGap;
  if (Math.abs(gap) < 3) {
    return <span className="mlb-projection-verdict ev-pos">Well-calibrated</span>;
  }
  if (gap > 0) {
    return <span className="mlb-projection-verdict ev-neutral">Underclaimed by {gap.toFixed(1)}%</span>;
  }
  return <span className="mlb-projection-verdict ev-neg">Overclaimed by {Math.abs(gap).toFixed(1)}%</span>;
}

function BucketTable({
  title,
  buckets,
}: {
  title: string;
  buckets: MlbCalibrationBucket[];
}) {
  if (buckets.length === 0) return null;
  const anyData = buckets.some((b) => b.graded > 0);
  return (
    <div className="mlb-projection" style={{ marginTop: 14 }}>
      <div className="mlb-projection-head">
        <h3>{title}</h3>
      </div>
      {!anyData && <p className="muted small">No graded picks in any bucket yet.</p>}
      {anyData && (
        <table className="mlb-bucket-table">
          <thead>
            <tr>
              <th>Bucket</th>
              <th>Predicted</th>
              <th>Observed</th>
              <th>Smoothed</th>
              <th>n</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.label} className={b.graded === 0 ? 'mlb-bucket-empty' : ''}>
                <td>
                  <span className="mlb-bucket-label">{b.label}</span>
                  {b.sampleTier === 'thin' && b.graded > 0 && (
                    <span className="mlb-bucket-tier" title="Thin sample — interpret cautiously">·thin</span>
                  )}
                </td>
                <td>{b.predictedAverage.toFixed(1)}%</td>
                <td>{b.graded === 0 ? '—' : `${b.observedHitRate.toFixed(1)}%`}</td>
                <td>{b.graded === 0 ? '—' : `${b.smoothedHitRate.toFixed(1)}%`}</td>
                <td>{b.graded}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="mlb-stat" title={hint}>
      <span className="mlb-stat-label">{label}</span>
      <span className="mlb-stat-value">{value}</span>
    </div>
  );
}
