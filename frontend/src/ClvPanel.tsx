// CLV (Closing Line Value) panel — Phase 103c.
//
// The first REAL truth metric on the platform. Win rate measures
// short-term variance; CLV measures whether we beat the market's
// eventual closing line — direct test of edge regardless of game
// outcome.
//
// Reads /api/market/clv?sport=mlb|wnba. Same component renders for
// both sports.
//
// IMPORTANT: until intra-day pastes / paid feeds accumulate, most
// snapshots will be single-shot (one paste per day) so closingLine
// equals publishLine and beatMarket is null. The panel handles that
// case honestly with a "still accumulating data" empty-state — does
// NOT fabricate fake CLV.

import { useEffect, useState } from 'react';
import { getClv, type ClvSummary } from './api';

export function ClvPanel({ sport }: { sport: 'mlb' | 'wnba' }) {
  const [data, setData] = useState<ClvSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    getClv({ sport, windowDays: 30 })
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [sport]);

  if (error) {
    return (
      <section style={{ marginTop: 32 }}>
        <h2 style={{ margin: '0 0 6px' }}>Closing Line Value (CLV)</h2>
        <div className="mlb-info-banner mlb-info-error">CLV query failed: {error}</div>
      </section>
    );
  }

  if (!data) {
    return (
      <section style={{ marginTop: 32 }}>
        <h2 style={{ margin: '0 0 6px' }}>Closing Line Value (CLV)</h2>
        <div className="muted small">Loading…</div>
      </section>
    );
  }

  // No projections at all in window
  if (data.total === 0) {
    return (
      <section style={{ marginTop: 32 }}>
        <h2 style={{ margin: '0 0 6px' }}>Closing Line Value (CLV)</h2>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          Did we beat the market's eventual closing line? CLV is the institutional
          truth metric — independent of short-term game-outcome variance.
        </p>
        <div
          style={{
            padding: '24px 16px',
            background: 'rgba(255,255,255,0.02)',
            border: '1px dashed rgba(255,255,255,0.1)',
            borderRadius: 6,
            textAlign: 'center',
          }}
          className="muted small"
        >
          No projections in this window yet.
        </div>
      </section>
    );
  }

  // Projections exist but no later snapshots have moved the line yet
  // (single-paste-per-day reality). Honest empty-state.
  if (data.withClosing === 0) {
    return (
      <section style={{ marginTop: 32 }}>
        <h2 style={{ margin: '0 0 6px' }}>Closing Line Value (CLV)</h2>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          Did we beat the market's eventual closing line? CLV is the institutional
          truth metric — independent of short-term game-outcome variance.
        </p>
        <div
          style={{
            padding: '20px 16px',
            background: 'rgba(255,213,79,0.04)',
            border: '1px dashed rgba(255,213,79,0.25)',
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: '#ffd54f' }}>
            CLV pipeline live — {data.total} projections tracked, awaiting line movement
          </div>
          <p className="muted small" style={{ margin: 0, lineHeight: 1.55 }}>
            Every published projection is now persisted with publish-time line
            data. CLV becomes meaningful as soon as a second market snapshot
            captures line movement — either when the admin re-publishes the
            slate during the day, or when polling/paid-feed snapshots land in
            Phase 103b. Until then the engine reports honestly: zero observed
            closes, no fake numbers.
          </p>
        </div>
      </section>
    );
  }

  const beatColor = (data.beatRate ?? 0) >= 55 ? '#66bb6a'
    : (data.beatRate ?? 0) >= 50 ? '#7aa2ff'
    : '#ef5350';

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ margin: '0 0 6px' }}>Closing Line Value (CLV)</h2>
      <p className="muted small" style={{ margin: '0 0 12px' }}>
        Did we beat the market's eventual closing line? CLV is the institutional
        truth metric — independent of short-term game-outcome variance. ≥55% beat
        rate = real edge.
      </p>

      {/* Top-line stats */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 8,
          marginBottom: 14,
        }}
      >
        <ClvStat
          label="Beat rate"
          value={data.beatRate === null ? '—' : `${data.beatRate.toFixed(1)}%`}
          color={beatColor}
          hint={`${data.beatMarket} of ${data.withClosing} prop${data.withClosing === 1 ? '' : 's'} with line movement beat the market.`}
        />
        <ClvStat
          label="Tracked"
          value={String(data.total)}
          hint={`Total projections in last ${data.windowDays} days. Of those, ${data.withClosing} had line movement to compare against.`}
        />
        <ClvStat
          label="Beat market"
          value={String(data.beatMarket)}
          color="#66bb6a"
          hint="Market moved AWAY from our line — confirms our publish-time edge."
        />
        <ClvStat
          label="Lost to market"
          value={String(data.lostToMarket)}
          color="#ef5350"
          hint="Market moved TOWARD our line — we likely chased the line late."
        />
        {data.averageLineDelta !== null && (
          <ClvStat
            label="Avg line beat"
            value={`${data.averageLineDelta >= 0 ? '+' : ''}${data.averageLineDelta.toFixed(2)}`}
            color={data.averageLineDelta >= 0 ? '#66bb6a' : '#ef5350'}
            hint="Direction-aware: how many stat units of line movement we beat (positive) or lost (negative) on average."
          />
        )}
        {data.averageHoursToClosing !== null && (
          <ClvStat
            label="Avg time-to-close"
            value={`${data.averageHoursToClosing.toFixed(1)}h`}
            hint="Average hours between our publish and the latest observed market snapshot. Faster movement on beat picks = stronger early-edge signal."
          />
        )}
      </div>

      {/* By stat type */}
      {data.byStatType.length > 0 && (
        <>
          <h3 style={{ margin: '14px 0 6px', fontSize: 14, letterSpacing: '0.04em' }}>By stat type</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.byStatType.slice(0, 12).map((b) => (
              <div
                key={b.stat}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 80px 80px 100px 1fr',
                  gap: 8,
                  alignItems: 'baseline',
                  padding: '6px 10px',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.05)',
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                <strong>{b.stat}</strong>
                <span className="muted small">{b.samples} props</span>
                <span className="muted small">
                  {b.withClosing} closed
                </span>
                <span style={{
                  fontWeight: 700,
                  color: b.beatRate === null ? 'rgba(255,255,255,0.5)'
                    : b.beatRate >= 55 ? '#66bb6a'
                    : b.beatRate >= 50 ? '#7aa2ff'
                    : '#ef5350',
                }}>
                  {b.beatRate === null ? '—' : `${b.beatRate.toFixed(0)}% beat`}
                </span>
                <span className="muted small">
                  {b.averageLineDelta === null ? '—'
                    : `avg ${b.averageLineDelta >= 0 ? '+' : ''}${b.averageLineDelta.toFixed(2)} line beat`}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ClvStat({
  label,
  value,
  color,
  hint,
}: {
  label: string;
  value: string;
  color?: string;
  hint?: string;
}) {
  return (
    <div
      title={hint}
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 6,
        padding: '10px 12px',
      }}
    >
      <div className="muted small" style={{ fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 800, color: color ?? undefined }}>
        {value}
      </div>
    </div>
  );
}
