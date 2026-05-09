// PlayerProjectionTrail — Phase 128.
//
// The deepest truth-metric surface: every prior projection we shipped
// on a specific player + stat, charted vs the actual outcome. For
// each graded game, you see (a) what we projected, (b) what the line
// was, (c) what the player actually did, and (d) the hit/miss verdict
// per the direction we projected.
//
// Calibration in motion for one specific decision. Drops onto
// MlbPlayerLog under the existing PlayerStatCalibration card.
// Self-hides when no graded projections exist for this player+stat
// in the window.

import { useEffect, useState } from 'react';
import { getMlbPlayerProjectionHistory, type MlbPlayerProjection } from './api';

type Props = {
  playerId: number;
  statKey: string;
  statLabel?: string;
  windowDays?: number;
};

export function PlayerProjectionTrail({ playerId, statKey, statLabel, windowDays = 90 }: Props) {
  const [data, setData] = useState<MlbPlayerProjection[] | null>(null);

  useEffect(() => {
    setData(null);
    getMlbPlayerProjectionHistory({ playerId, statKey, windowDays })
      .then((r) => setData(r.projections))
      .catch(() => setData([]));
  }, [playerId, statKey, windowDays]);

  if (!data || data.length === 0) return null;

  // Compute chart bounds from the data we got. Y-axis covers from
  // 0 (or below if some result is negative — won't happen for stat
  // counts) up to the max of (line, projection, actual) across all
  // rows, with a small headroom buffer.
  const allValues = data.flatMap((p) => [
    p.lineValue,
    p.projectionValue,
    p.resultValue ?? 0,
  ]);
  const yMax = Math.max(1, ...allValues) * 1.15;

  const beats = data.filter((p) => p.hitOrMiss === true).length;
  const misses = data.filter((p) => p.hitOrMiss === false).length;
  const graded = beats + misses;
  const hitRate = graded > 0 ? (beats / graded) * 100 : null;

  const label = statLabel ?? statKey;

  return (
    <section style={{
      marginTop: 14, padding: 14,
      background: 'rgba(0,0,0,0.2)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>
            Projection Trail · {label} · last {windowDays}d
          </div>
          <div className="muted small" style={{ fontSize: 11, marginTop: 2 }}>
            {data.length} graded projection{data.length === 1 ? '' : 's'} · projection vs line vs actual outcome
          </div>
        </div>
        {hitRate !== null && (
          <span style={{
            fontSize: 11, fontWeight: 800, letterSpacing: '0.04em',
            padding: '3px 8px', borderRadius: 3,
            color: hitRate >= 60 ? '#66bb6a' : hitRate >= 50 ? '#ffd54f' : '#ef5350',
            background: hitRate >= 60 ? 'rgba(102,187,106,0.12)' : hitRate >= 50 ? 'rgba(255,213,79,0.12)' : 'rgba(239,83,80,0.12)',
            textTransform: 'uppercase',
          }}>
            {hitRate.toFixed(1)}% hit · {beats}/{graded}
          </span>
        )}
      </div>

      {/* Chart */}
      <div style={{
        position: 'relative', height: 160,
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 4,
        padding: '12px 12px 24px',
        display: 'flex', alignItems: 'flex-end', gap: 4,
      }}>
        {data.map((p) => {
          const lineH    = (p.lineValue       / yMax) * 100;
          const projH    = (p.projectionValue / yMax) * 100;
          const actualH  = p.resultValue !== null ? (p.resultValue / yMax) * 100 : null;
          const hit = p.hitOrMiss;
          const fillColor = hit === true ? '#66bb6a' : hit === false ? '#ef5350' : 'rgba(255,255,255,0.3)';
          const directionArrow = p.direction === 'OVER' ? '↑' : '↓';

          return (
            <div
              key={`${p.gameDate}-${p.lineValue}`}
              title={[
                `Game date: ${p.gameDate}`,
                `Direction: ${p.direction} ${p.lineValue}`,
                `Projection: ${p.projectionValue.toFixed(2)} (${Math.round(p.probability)}%)`,
                p.resultValue !== null ? `Actual: ${p.resultValue}` : 'Pending',
                hit === true ? '✓ HIT' : hit === false ? '✗ MISS' : '— ungraded',
              ].join(' · ')}
              style={{
                flex: 1, height: '100%', position: 'relative',
                cursor: 'help',
              }}
            >
              {/* Line value as a horizontal tick */}
              <div style={{
                position: 'absolute',
                bottom: `${lineH}%`,
                left: 0, right: 0, height: 2,
                background: 'rgba(255,255,255,0.4)',
              }} />
              {/* Projection bar (transparent) */}
              <div style={{
                position: 'absolute',
                bottom: 0, left: '20%', right: '20%',
                height: `${projH}%`,
                background: 'rgba(122,162,255,0.25)',
                border: '1px solid rgba(122,162,255,0.5)',
              }} />
              {/* Actual outcome dot */}
              {actualH !== null && (
                <div style={{
                  position: 'absolute',
                  bottom: `calc(${actualH}% - 4px)`,
                  left: 'calc(50% - 4px)',
                  width: 8, height: 8, borderRadius: 4,
                  background: fillColor,
                  border: '1px solid rgba(0,0,0,0.5)',
                }} />
              )}
              {/* Direction tick at the line value */}
              <div style={{
                position: 'absolute',
                bottom: `calc(${lineH}% - 4px)`,
                right: 0,
                fontSize: 8, color: 'rgba(255,255,255,0.5)',
                fontWeight: 800,
              }}>
                {directionArrow}
              </div>
              {/* Date label */}
              <div style={{
                position: 'absolute',
                bottom: -18, left: 0, right: 0,
                fontSize: 8, fontWeight: 600,
                color: 'rgba(255,255,255,0.4)',
                textAlign: 'center',
              }}>
                {p.gameDate.slice(5)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, marginTop: 14, fontSize: 11, color: 'rgba(255,255,255,0.65)', flexWrap: 'wrap' }}>
        <span><span style={{ display: 'inline-block', width: 14, height: 2, background: 'rgba(255,255,255,0.4)', verticalAlign: 'middle' }} /> Line</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(122,162,255,0.25)', border: '1px solid rgba(122,162,255,0.5)', verticalAlign: 'middle' }} /> Projection</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: '#66bb6a', verticalAlign: 'middle' }} /> Hit</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: '#ef5350', verticalAlign: 'middle' }} /> Miss</span>
      </div>
    </section>
  );
}
