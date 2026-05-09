// /calibration — cross-sport calibration audit. Phase 114.
//
// The second pillar of the truth metric. CLV = "did we beat the
// market" (process accuracy). Calibration = "are our probabilities
// honest?" (model accuracy). When we say a player has a 70% chance
// of going over, do players actually hit at 71%? If yes, the
// probabilities are real. If no, the model is lying about its
// confidence — even when it's right on average.
//
// Cross-sport view: probability deciles + per-sport detail. Same
// audit-page DNA as /clv: top-line number → drill-down → per-bucket
// → methodology.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getCalibrationSummary, type CrossSportCalibration, type CrossSportProbabilityBucket } from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

const SPORT_COLOR: Record<string, string> = {
  mlb:  '#66bb6a',
  nba:  '#7aa2ff',
  wnba: '#b388ff',
  mma:  '#ef5350',
};

export function CalibrationAudit() {
  useTitle(['Calibration', 'Truth Metric']);
  const [data, setData] = useState<CrossSportCalibration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(30);

  useEffect(() => {
    setData(null);
    setError(null);
    getCalibrationSummary({ windowDays })
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [windowDays]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ marginBottom: 8 }}>
          <Link to="/" className="muted small">← Home</Link>
        </div>

        <div style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
        }}>
          STATEDGE TRUTH METRIC · CALIBRATION
        </div>
        <h1 style={{ margin: '4px 0 12px' }}>Predicted vs Observed</h1>
        <p className="muted small" style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.5, maxWidth: 760 }}>
          When we say a leg has a <strong>70% chance</strong> of hitting, do players actually
          hit at 70%? Calibration is the second pillar of the truth metric — paired with CLV
          on the <Link to="/clv" style={{ color: '#7aa2ff' }}>audit page</Link>. CLV is process
          accuracy ("did we beat the market"); calibration is model accuracy ("is our
          probability honest"). A model can be uncalibrated AND right on average. We track
          both.
        </p>

        <div role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {[7, 30, 90].map((d) => (
            <WindowTab key={d} active={windowDays === d} onClick={() => setWindowDays(d)}>
              Last {d} days
            </WindowTab>
          ))}
        </div>

        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        {!data && !error && <Skeleton width="100%" height={400} />}

        {data && data.totalGraded === 0 && (
          <div className="muted small" style={{ padding: '32px 16px', textAlign: 'center', fontStyle: 'italic' }}>
            No graded projections in the last {windowDays} days. Calibration data populates
            as projections grade against actual game results.
          </div>
        )}

        {data && data.totalGraded > 0 && (
          <>
            {/* Top-line scoreboard */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
              marginBottom: 18,
            }}>
              <ScoreCard
                label="Predicted Hit Rate"
                value={`${data.averagePredicted.toFixed(1)}%`}
                hint="Mean confidence on graded legs"
              />
              <ScoreCard
                label="Observed Hit Rate"
                value={`${data.overallHitRate.toFixed(1)}%`}
                hint={`${data.totalHits} of ${data.totalGraded} graded`}
                accent
              />
              <ScoreCard
                label="Calibration Gap"
                value={`${data.calibrationGap >= 0 ? '+' : ''}${data.calibrationGap.toFixed(1)}pp`}
                hint={
                  Math.abs(data.calibrationGap) <= 2
                    ? 'Tight — model is honest'
                    : data.calibrationGap > 0
                      ? 'Underclaiming (better than predicted)'
                      : 'Overclaiming (worse than predicted)'
                }
                color={
                  Math.abs(data.calibrationGap) <= 2 ? '#66bb6a'
                  : Math.abs(data.calibrationGap) <= 5 ? '#ffd54f'
                  : '#ef5350'
                }
              />
            </div>

            {/* Probability decile breakdown */}
            {data.byProbability.length > 0 && (
              <section style={{ marginBottom: 24 }}>
                <h2 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>
                  By Probability Bucket
                </h2>
                <p className="muted small" style={{ margin: '0 0 12px', fontSize: 12, lineHeight: 1.5 }}>
                  For each predicted-probability range, what fraction of legs actually hit?
                  A perfectly calibrated model would have observed = predicted at every row.
                </p>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 640 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.15)' }}>
                        <th style={thStyle}>Bucket</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Predicted</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Observed</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Gap</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Sample</th>
                        <th style={thStyle}>Calibration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byProbability.map((b) => <BucketRow key={b.label} bucket={b} />)}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Per-sport panel */}
            {data.bySport.length > 0 && (
              <section style={{ marginBottom: 24 }}>
                <h2 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>
                  By Sport
                </h2>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 10,
                }}>
                  {data.bySport.map((s) => (
                    <div key={s.sport} style={{
                      padding: 14,
                      background: 'rgba(0,0,0,0.2)',
                      border: `1px solid ${(SPORT_COLOR[s.sport] ?? '#666')}33`,
                      borderLeft: `3px solid ${SPORT_COLOR[s.sport] ?? '#666'}`,
                      borderRadius: 6,
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: SPORT_COLOR[s.sport] ?? 'rgba(255,255,255,0.7)' }}>
                        {s.sport}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
                        <span style={{ fontSize: 22, fontWeight: 800 }}>{s.overallHitRate.toFixed(1)}%</span>
                        <span className="muted small" style={{ fontSize: 11 }}>predicted {s.averagePredicted.toFixed(1)}%</span>
                      </div>
                      <div style={{ fontSize: 11, marginTop: 4, color: gapColor(s.calibrationGap) }}>
                        {s.calibrationGap >= 0 ? '+' : ''}{s.calibrationGap.toFixed(1)}pp gap · {s.totalGraded} graded
                      </div>
                      <Link
                        to={s.sport === 'mlb' ? '/mlb/calibration' : s.sport === 'wnba' ? '/wnba/calibration' : `/${s.sport}/calibration`}
                        style={{ fontSize: 11, fontWeight: 700, color: SPORT_COLOR[s.sport] ?? '#7aa2ff', textDecoration: 'none', marginTop: 8, display: 'inline-block' }}
                      >
                        Sport detail →
                      </Link>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Methodology */}
            <section style={{
              marginTop: 24,
              padding: 16,
              background: 'rgba(0,0,0,0.2)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6,
            }}>
              <h3 style={{ margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>
                Methodology
              </h3>
              <ul className="muted small" style={{ marginTop: 8, paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
                <li><strong>Predicted hit rate</strong> = mean of model probabilities on every projection that has graded against an actual game.</li>
                <li><strong>Observed hit rate</strong> = (hits) ÷ (hits + misses). Pushes excluded — they're not hits or misses.</li>
                <li><strong>Calibration gap</strong> = observed − predicted. A positive gap means the model underclaimed (we said 65% but they hit at 70% — surprise upside). A negative gap means we overclaimed (we said 65% but they hit at 60% — confidence too high).</li>
                <li><strong>Tight calibration</strong> ≤2pp absolute gap. The honest model. The cross-sport gap weights by sample mix, so a sport with more graded legs pulls the average more.</li>
                <li><strong>Window</strong> filters by game date. NBA + UFC start contributing once their projection histories accumulate graded rows.</li>
                <li><strong>Sources</strong>: <code>mlb_projection_history</code> + <code>wnba_projection_history</code> via <code>computeMlbCalibration</code> and <code>computeWnbaCalibration</code>. Per-sport pages have full detail (stat type, card type, risk tier, failure archetypes).</li>
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function BucketRow({ bucket }: { bucket: CrossSportProbabilityBucket }) {
  const gap = bucket.observedHitRate - bucket.predictedAverage;
  // Bar visualization — predicted vs observed side-by-side.
  const max = 100;
  const predW = (bucket.predictedAverage / max) * 100;
  const obsW = (bucket.observedHitRate / max) * 100;

  return (
    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <td style={tdStyle}><strong>{bucket.label}</strong></td>
      <td style={{ ...tdStyle, textAlign: 'right', color: 'rgba(255,255,255,0.65)' }}>
        {bucket.predictedAverage.toFixed(1)}%
      </td>
      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>
        {bucket.observedHitRate.toFixed(1)}%
      </td>
      <td style={{ ...tdStyle, textAlign: 'right', color: gapColor(gap), fontWeight: 700 }}>
        {gap >= 0 ? '+' : ''}{gap.toFixed(1)}pp
      </td>
      <td style={{ ...tdStyle, textAlign: 'right', color: 'rgba(255,255,255,0.55)' }}>
        {bucket.hits}/{bucket.graded}
      </td>
      <td style={{ ...tdStyle, minWidth: 160 }}>
        <div style={{ position: 'relative', height: 18, background: 'rgba(255,255,255,0.04)', borderRadius: 3, overflow: 'hidden' }}>
          {/* Predicted bar (background, blue-grey) */}
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${predW}%`,
            background: 'rgba(122,162,255,0.25)',
          }} />
          {/* Observed bar (foreground, color-coded) */}
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${obsW}%`,
            background: gapColor(gap),
            opacity: 0.65,
            borderRight: `2px solid ${gapColor(gap)}`,
          }} />
        </div>
      </td>
    </tr>
  );
}

function ScoreCard({ label, value, hint, accent, color }: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
  color?: string;
}) {
  return (
    <div style={{
      padding: 16,
      background: 'rgba(0,0,0,0.25)',
      border: `1px solid ${accent ? 'rgba(102,187,106,0.3)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 8,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)',
      }}>
        {label}
      </div>
      <div style={{ fontSize: 32, fontWeight: 800, marginTop: 6, lineHeight: 1, color: color ?? (accent ? '#66bb6a' : 'inherit') }}>
        {value}
      </div>
      <div className="muted small" style={{ fontSize: 11, marginTop: 6 }}>
        {hint}
      </div>
    </div>
  );
}

function WindowTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: '6px 12px',
        borderRadius: 4,
        border: `1px solid ${active ? '#7aa2ff' : 'rgba(255,255,255,0.1)'}`,
        background: active ? 'rgba(122,162,255,0.1)' : 'transparent',
        color: active ? '#7aa2ff' : 'rgba(255,255,255,0.65)',
        fontWeight: 700,
        fontSize: 11,
        letterSpacing: '0.04em',
        cursor: 'pointer',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </button>
  );
}

function gapColor(gap: number): string {
  const abs = Math.abs(gap);
  if (abs <= 2) return '#66bb6a';
  if (abs <= 5) return '#ffd54f';
  return '#ef5350';
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'rgba(255,255,255,0.5)',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 12px',
  fontSize: 13,
};
