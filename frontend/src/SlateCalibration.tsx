// Calibration view — "we said X%, actuals say Y%". Reads the
// /slate/calibration endpoint, which aggregates every graded snapshot
// in slate_results and reports predicted-vs-actual hit rate by
// probability bucket, by stat, and by confidence tier.
//
// This is the StatEdge truth-telling mirror: if we're systematically
// overconfident in a bucket, the gap shows up here. The data comes
// for free — the History tab already grades each day's picks against
// player_game_logs.

import { useEffect, useState } from 'react';
import {
  getSlateCalibration,
  type CalibrationBucket,
  type CalibrationReport,
} from './api';
import { Skeleton } from './Skeleton';

const SMALL_SAMPLE = 10;

function fmtRange(start: string | null, end: string | null): string {
  if (!start || !end) return 'No graded days yet';
  if (start === end) return start;
  return `${start} → ${end}`;
}

function gapClass(gap: number): string {
  if (gap >= 5) return 'gap over';        // overconfident
  if (gap <= -5) return 'gap under';      // under-sold
  return 'gap calibrated';
}

function gapLabel(gap: number): string {
  if (gap >= 5) return `+${gap.toFixed(1)} overconfident`;
  if (gap <= -5) return `${gap.toFixed(1)} under-sold`;
  return `${gap >= 0 ? '+' : ''}${gap.toFixed(1)} calibrated`;
}

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
          Predicted hit % vs actual hit rate, aggregated across past graded picks.
          Push counts as a hit (matches the parlay grader). Buckets with
          fewer than {SMALL_SAMPLE} legs are flagged — interpret with caution.
        </p>
        <div className="slate-calibration-meta">
          <span><strong>{report.legsAnalyzed}</strong> graded legs</span>
          <span>·</span>
          <span><strong>{report.daysAnalyzed}</strong> days</span>
          <span>·</span>
          <span>{fmtRange(report.rangeStart, report.rangeEnd)}</span>
        </div>
      </div>

      <OverallBanner b={report.overall} />

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
    </div>
  );
}

function OverallBanner({ b }: { b: CalibrationBucket }) {
  if (b.sampleSize === 0) return null;
  return (
    <div className="slate-calibration-overall">
      <div className="slate-calibration-overall-row">
        <span className="slate-calibration-overall-label">Overall</span>
        <span className="slate-calibration-overall-pred">
          predicted <strong>{b.predictedAvg.toFixed(1)}%</strong>
        </span>
        <span className="slate-calibration-overall-actual">
          actual <strong>{b.actualHitRate.toFixed(1)}%</strong>
        </span>
        <span className={`slate-calibration-overall-gap ${gapClass(b.gap)}`}>
          {gapLabel(b.gap)}
        </span>
      </div>
      <div className="muted small">
        {b.gap >= 5
          ? 'The model is overconfident — picks claimed higher hit rate than they delivered.'
          : b.gap <= -5
          ? 'The model is under-selling — picks delivered better than claimed.'
          : 'The model is well-calibrated overall — predictions track actuals within ±5 points.'}
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
          <span>Predicted</span>
          <span>Actual</span>
          <span>Gap</span>
        </div>
        {populated.map((b) => (
          <div key={b.label} className="slate-calibration-row">
            <span className="slate-calibration-bucket-label">{b.label}</span>
            <span className={b.sampleSize < SMALL_SAMPLE ? 'small-n' : ''}>
              {b.sampleSize}
              {b.sampleSize < SMALL_SAMPLE && <span className="small-n-flag" title="Small sample — interpret with caution">*</span>}
            </span>
            <span>{b.predictedAvg.toFixed(1)}%</span>
            <span>{b.actualHitRate.toFixed(1)}%</span>
            <span className={gapClass(b.gap)}>
              {b.gap >= 0 ? '+' : ''}{b.gap.toFixed(1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
