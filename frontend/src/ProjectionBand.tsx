// ProjectionBand — Phase 147c.
//
// Bloomberg-Terminal-style confidence-band badge for prop projections.
// Surfaces the model's projection range alongside the line value so
// users see at a glance whether the prop sits at the comfortable
// center of the distribution or at a fragile edge.
//
// Visual: a tight horizontal track [low ─── HIGH ─── high], with the
// line value marked along the track. Colors by where the line falls
// relative to the projection center: deep green if the line is well
// below projection (over-favorable), deep red if line is well above
// projection (under-favorable), yellow in the middle (coin-flip).

type Props = {
  rangeLow: number;
  projection: number;
  rangeHigh: number;
  line: number;
  /**
   * Direction the model is leaning. Used to color the side of the
   * track that's "in your favor".
   */
  lean?: 'OVER' | 'UNDER' | null;
  /**
   * Compact mode shrinks the badge for table cells.
   */
  compact?: boolean;
};

export function ProjectionBand({ rangeLow, projection, rangeHigh, line, lean, compact }: Props) {
  // Sanity bounds — we can't render a track with zero range.
  const low = Math.min(rangeLow, projection, rangeHigh, line);
  const high = Math.max(rangeLow, projection, rangeHigh, line);
  if (high === low) return null;

  // Pad the visible track 5% beyond min/max so endpoints don't touch
  // the edge of the badge.
  const pad = (high - low) * 0.05;
  const trackLow = low - pad;
  const trackHigh = high + pad;
  const span = trackHigh - trackLow;

  const lowPct  = ((rangeLow  - trackLow) / span) * 100;
  const highPct = ((rangeHigh - trackLow) / span) * 100;
  const projPct = ((projection - trackLow) / span) * 100;
  const linePct = ((line - trackLow) / span) * 100;

  // Score: if line < projection, OVER is favorable (positive score);
  // if line > projection, UNDER is favorable (negative score).
  // Magnitude relative to half-band-width.
  const halfBand = (rangeHigh - rangeLow) / 2;
  const score = halfBand === 0 ? 0 : (projection - line) / halfBand;

  // Color: green when line is materially below projection (over hits
  // easily) or above projection (under hits easily), depending on lean.
  let color = '#ffd54f';
  if (lean === 'OVER') {
    if (score >= 0.5) color = '#66bb6a';
    else if (score <= -0.5) color = '#ef5350';
  } else if (lean === 'UNDER') {
    if (score <= -0.5) color = '#66bb6a';
    else if (score >= 0.5) color = '#ef5350';
  } else {
    if (Math.abs(score) >= 0.5) color = '#66bb6a';
  }

  const trackHeight = compact ? 4 : 6;
  const dotSize = compact ? 8 : 10;
  const lineMark = compact ? 12 : 16;
  const fontSize = compact ? 10 : 11;

  return (
    <div
      title={`Projection: ${projection.toFixed(1)} (range ${rangeLow.toFixed(1)}–${rangeHigh.toFixed(1)}) · Line: ${line}`}
      style={{
        display: 'flex', flexDirection: 'column', gap: 4,
        minWidth: compact ? 110 : 140,
      }}
    >
      <div style={{
        position: 'relative',
        height: lineMark,
      }}>
        {/* Track */}
        <div style={{
          position: 'absolute',
          top: (lineMark - trackHeight) / 2, left: 0, right: 0,
          height: trackHeight,
          background: 'rgba(255,255,255,0.08)',
          borderRadius: trackHeight / 2,
        }} />
        {/* Range fill */}
        <div style={{
          position: 'absolute',
          top: (lineMark - trackHeight) / 2,
          left: `${lowPct}%`,
          width: `${Math.max(0, highPct - lowPct)}%`,
          height: trackHeight,
          background: `linear-gradient(90deg, ${color}55, ${color})`,
          borderRadius: trackHeight / 2,
        }} />
        {/* Projection dot */}
        <div style={{
          position: 'absolute',
          top: (lineMark - dotSize) / 2,
          left: `calc(${projPct}% - ${dotSize / 2}px)`,
          width: dotSize, height: dotSize,
          background: color,
          borderRadius: '50%',
          boxShadow: `0 0 8px ${color}88`,
          border: '1px solid rgba(0,0,0,0.4)',
        }} />
        {/* Line marker — vertical bar */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: `calc(${linePct}% - 1px)`,
          width: 2, height: lineMark,
          background: 'rgba(255,255,255,0.85)',
          boxShadow: '0 0 4px rgba(0,0,0,0.6)',
        }} />
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize, color: 'rgba(255,255,255,0.55)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontVariantNumeric: 'tabular-nums',
      }}>
        <span>{rangeLow.toFixed(1)}</span>
        <span style={{ fontWeight: 800, color }}>
          μ {projection.toFixed(1)}
        </span>
        <span>{rangeHigh.toFixed(1)}</span>
      </div>
    </div>
  );
}
