// Loss Forensics panel — Phase 102a. Shows the distribution of
// failure archetypes across all misses in the calibration window.
// Reads /api/{sport}/calibration → failureArchetypes[].
//
// Mission alignment: per the Phase 102 spec, every missed prop must
// be classified WHY. Over time, archetype distributions become
// institutional knowledge — "we miss disproportionately on
// PUBLIC_TRAP rows" is far more actionable than "we hit 56%."

import type { FailureArchetypeBucket } from './api';

const ARCHETYPE_LABEL: Record<string, string> = {
  PUBLIC_TRAP:           'Public Trap',
  LINE_INFLATION:        'Line Inflation',
  STREAK_FADED:          'Streak Faded',
  STAR_TAX_REVERSE:      'Star Tax Reversed',
  CONTRARIAN_CRUSHED:    'Contrarian Crushed',
  NARRATIVE_OVERLOAD:    'Narrative Overload',
  FRAGILE_PROJECTION:    'Fragile Projection',
  MODEL_ERROR:           'Model Error',
  CLOSE_MISS:            'Close Miss',
  VARIANCE:              'Variance',
  UNKNOWN:               'Unknown',
};

const ARCHETYPE_DETAIL: Record<string, string> = {
  PUBLIC_TRAP:        'Trap score was already elevated when we projected. Public-facing line that punished us.',
  LINE_INFLATION:     'Line walked above season baseline + we took the over. Recency-bias trap realized.',
  STREAK_FADED:       'Rode L5 momentum on the over; streak didn\'t sustain. Regression to baseline.',
  STAR_TAX_REVERSE:   'Faded a star + the star delivered. Line was priced for the name; the name showed up.',
  CONTRARIAN_CRUSHED: 'Took the unloved side and the public was right. Contrarian misses are inevitable.',
  NARRATIVE_OVERLOAD: 'Reason codes flagged a narrative spike + we sided with it.',
  FRAGILE_PROJECTION: 'High fragility was already telegraphed. Outcome inside expected variance.',
  MODEL_ERROR:        'Low fragility + sizable miss. Model misjudged central tendency — investigate.',
  CLOSE_MISS:         'Result within 1 unit of line. Coin-flip variance noise.',
  VARIANCE:           'No archetype dominated. Generic variance noise.',
  UNKNOWN:            'Insufficient data captured at projection time to classify.',
};

const ARCHETYPE_COLOR: Record<string, string> = {
  PUBLIC_TRAP:        '#ef5350',
  LINE_INFLATION:     '#ef5350',
  STREAK_FADED:       '#ffb74d',
  STAR_TAX_REVERSE:   '#ffb74d',
  CONTRARIAN_CRUSHED: '#ffb74d',
  NARRATIVE_OVERLOAD: '#ef5350',
  FRAGILE_PROJECTION: '#7aa2ff',
  MODEL_ERROR:        '#ef5350',
  CLOSE_MISS:         '#7aa2ff',
  VARIANCE:           '#7aa2ff',
  UNKNOWN:            'rgba(255,255,255,0.4)',
};

export function LossForensics({
  archetypes,
  totalMisses,
}: {
  archetypes: FailureArchetypeBucket[] | undefined;
  totalMisses: number;
}) {
  if (!archetypes || archetypes.length === 0) {
    return (
      <section style={{ marginTop: 32 }}>
        <h2 style={{ margin: '0 0 6px' }}>Loss Forensics</h2>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          Why our misses miss. Every loss gets classified by archetype
          (Public Trap / Line Inflation / Streak Faded / Model Error /
          Variance / etc) so we can see WHERE failures concentrate —
          not just how many.
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
          {totalMisses === 0
            ? 'No graded misses in this window yet.'
            : 'Failure archetypes start populating once Phase-102-recorded misses grade in. Older rows have no archetype tag.'}
        </div>
      </section>
    );
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ margin: '0 0 6px' }}>Loss Forensics</h2>
      <p className="muted small" style={{ margin: '0 0 12px' }}>
        Why our misses miss. {archetypes.reduce((s, b) => s + b.count, 0)} classified
        miss{archetypes.reduce((s, b) => s + b.count, 0) === 1 ? '' : 'es'} in this window.
        Concentration here = the signal we can iterate on.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {archetypes.map((b) => {
          const color = ARCHETYPE_COLOR[b.archetype] ?? 'rgba(255,255,255,0.5)';
          const label = ARCHETYPE_LABEL[b.archetype] ?? b.archetype;
          const detail = ARCHETYPE_DETAIL[b.archetype] ?? '';
          return (
            <div
              key={b.archetype}
              style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderLeft: `3px solid ${color}`,
                borderRadius: 6,
                padding: '10px 14px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
                <strong style={{ fontSize: 14, color }}>{label}</strong>
                <span style={{ fontSize: 13, fontWeight: 700 }}>
                  {b.count} miss{b.count === 1 ? '' : 'es'}
                </span>
                <span className="muted small" style={{ fontSize: 12 }}>
                  {b.pct.toFixed(1)}% of misses
                </span>
                {/* Bar */}
                <div
                  style={{
                    flex: 1,
                    minWidth: 80,
                    height: 6,
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: 3,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, b.pct)}%`,
                      height: '100%',
                      background: color,
                      opacity: 0.7,
                    }}
                  />
                </div>
              </div>
              {detail && (
                <p className="muted small" style={{ margin: 0, fontSize: 11, lineHeight: 1.5 }}>
                  {detail}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
