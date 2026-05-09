// "Why this pick" expandable panel — Phase 82. Mission: every
// probability number must come with its explanation. No black-box
// 70% chips on the platform — every leg surfaces the model's
// reasoning, the supporting evidence, and the risk side.
//
// Sport-agnostic: takes the union of fields available across NBA /
// MLB / WNBA slate legs, renders only the ones present. Used inside
// every slate card across all three sports.

import { useState } from 'react';

type WhyLeg = {
  // Always present.
  playerName: string;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  probability: number;
  edgePercent: number;
  projection: number;

  // Variable across sports — render only when present.
  reasonCodes?: string[];
  trapScore?: number;
  trapTier?: string;
  fragilityScore?: number;
  fragilityTier?: string;
  momentumScore?: number;       // NBA: momentumExpansionScore; WNBA: momentumScore
  riskScore?: number;
  l5Avg?: number;
  l10Avg?: number;
  seasonAvg?: number;
  l10HitRate?: number;
  l10HitCount?: number;
  vsOpponentHitRate?: number;
  vsOpponentGames?: number;
};

export function WhyPickPanel({ leg, sportColor }: { leg: WhyLeg; sportColor: string }) {
  const [open, setOpen] = useState(false);

  // Pre-compute the "thesis" — one sentence that explains why this
  // leg made the cut. Built from edge + projection gap + supporting
  // signals.
  const thesis = buildThesis(leg);
  const risks = buildRisks(leg);

  return (
    <div
      style={{
        marginTop: 6,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          background: 'transparent',
          border: 0,
          color: 'rgba(255,255,255,0.7)',
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textAlign: 'left',
        }}
      >
        <span>
          <span style={{ color: sportColor }}>WHY THIS PICK</span>
          {' · '}
          <span style={{ color: 'rgba(255,255,255,0.5)', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>
            {thesis}
          </span>
        </span>
        <span style={{ color: 'rgba(255,255,255,0.4)' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '8px 12px 12px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ marginBottom: 10 }}>
            <SectionLabel color={sportColor}>The case for it</SectionLabel>
            <BulletList items={buildCaseFor(leg)} />
          </div>

          {risks.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <SectionLabel color="#ef5350">Why this might fail</SectionLabel>
              <BulletList items={risks} />
            </div>
          )}

          {leg.reasonCodes && leg.reasonCodes.length > 0 && (
            <div>
              <SectionLabel color="rgba(255,255,255,0.5)">Engine reason codes</SectionLabel>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {leg.reasonCodes.map((rc, i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: 10,
                      padding: '2px 6px',
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 3,
                      color: 'rgba(255,255,255,0.6)',
                      letterSpacing: '0.02em',
                    }}
                  >
                    {rc}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color,
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.5, color: 'rgba(255,255,255,0.75)' }}>
      {items.map((it, i) => <li key={i} style={{ marginBottom: 2 }}>{it}</li>)}
    </ul>
  );
}

// ---------- Thesis builder ----------
//
// Prefers the strongest single signal: extreme edge, big projection
// gap, momentum spike, or "no clear edge but model leans this way".

function buildThesis(leg: WhyLeg): string {
  const projGap = Math.abs(leg.projection - leg.line);
  const sideText = leg.direction === 'OVER' ? 'over' : 'under';

  if (leg.edgePercent >= 15) {
    return `Strong edge: model says ${sideText} hits ${Math.round(leg.probability)}% vs market's break-even.`;
  }
  if (leg.momentumScore !== undefined && leg.momentumScore >= 75) {
    return `Recent form lift — L5 well above season — supports the ${sideText}.`;
  }
  if (projGap >= 1.0) {
    return `Projection ${leg.projection.toFixed(1)} vs line ${leg.line} — model has meaningful gap.`;
  }
  if (leg.l10HitCount !== undefined && leg.l10HitCount >= 7) {
    return `Player has hit this ${leg.l10HitCount}/10 recently — strong recent base rate.`;
  }
  if (leg.edgePercent >= 5) {
    return `Modest edge: model leans ${sideText} ${Math.round(leg.probability)}% vs implied break-even.`;
  }
  return `Model sees ${sideText} as the higher-probability side at ${Math.round(leg.probability)}%.`;
}

// ---------- The case for it ----------
//
// Bullet list of the supporting signals — only the ones that are
// actually positive/relevant to the chosen direction. We don't pad
// the panel with vibes; if a signal is missing or neutral, we skip it.

function buildCaseFor(leg: WhyLeg): string[] {
  const out: string[] = [];

  // Edge bullet always present (could be neutral).
  if (leg.edgePercent >= 5) {
    out.push(
      `Edge: ${leg.edgePercent >= 0 ? '+' : ''}${leg.edgePercent.toFixed(1)}% vs market implied break-even — model says line is mispriced.`,
    );
  }

  const projGap = leg.projection - leg.line;
  if (leg.direction === 'OVER' && projGap > 0) {
    out.push(`Projection: ${leg.projection.toFixed(1)} vs line ${leg.line} — ${projGap.toFixed(1)} above the line.`);
  } else if (leg.direction === 'UNDER' && projGap < 0) {
    out.push(`Projection: ${leg.projection.toFixed(1)} vs line ${leg.line} — ${Math.abs(projGap).toFixed(1)} below the line.`);
  }

  if (leg.l10HitCount !== undefined && leg.l10HitCount >= 6) {
    out.push(`Recent form: hit this prop ${leg.l10HitCount}/10 in last 10 games (${Math.round((leg.l10HitRate ?? 0) * (leg.l10HitRate! < 1 ? 100 : 1))}% rate).`);
  }

  if (leg.vsOpponentHitRate !== undefined && leg.vsOpponentGames && leg.vsOpponentGames >= 3 && leg.vsOpponentHitRate >= 0.6) {
    out.push(`Vs opponent: hit this ${(leg.vsOpponentHitRate * 100).toFixed(0)}% of the time across ${leg.vsOpponentGames} games.`);
  }

  if (leg.l5Avg !== undefined && leg.seasonAvg !== undefined && leg.l5Avg > leg.seasonAvg * 1.15) {
    out.push(`Momentum: L5 average ${leg.l5Avg.toFixed(1)} is ${(((leg.l5Avg / leg.seasonAvg) - 1) * 100).toFixed(0)}% above season — recent form expanding.`);
  } else if (leg.l5Avg !== undefined && leg.seasonAvg !== undefined && leg.l5Avg < leg.seasonAvg * 0.85 && leg.direction === 'UNDER') {
    out.push(`Form-fade: L5 average ${leg.l5Avg.toFixed(1)} is ${(((leg.l5Avg / leg.seasonAvg) - 1) * 100).toFixed(0)}% below season — softening usage supports the under.`);
  }

  if (leg.momentumScore !== undefined && leg.momentumScore >= 70) {
    out.push(`Momentum score: ${Math.round(leg.momentumScore)}/100 — strongest tier of recent expansion.`);
  }

  if (leg.fragilityScore !== undefined && leg.fragilityScore <= 25) {
    out.push(`Solid floor: fragility score ${Math.round(leg.fragilityScore)}/100 — low-variance projection.`);
  }

  if (out.length === 0) {
    out.push('Model has weak conviction — leg made the slate but isn\'t a clean institutional edge.');
  }
  return out;
}

// ---------- Why this might fail ----------
//
// Honesty surface — every pick has a risk side, and we surface it
// explicitly so users can size their cards accordingly.

function buildRisks(leg: WhyLeg): string[] {
  const out: string[] = [];

  if (leg.trapScore !== undefined && leg.trapScore >= 60) {
    out.push(
      `Trap risk: trap score ${Math.round(leg.trapScore)} — recent spike + line inflation pattern. Public-facing line.`,
    );
  } else if (leg.trapScore !== undefined && leg.trapScore >= 40) {
    out.push(`Trap risk: elevated trap score ${Math.round(leg.trapScore)} — line may be inflated vs season baseline.`);
  }

  if (leg.fragilityScore !== undefined && leg.fragilityScore >= 55) {
    out.push(
      `High variance: fragility score ${Math.round(leg.fragilityScore)}/100 — projection is volatile, sample is thin or recent stats are choppy.`,
    );
  }

  if (leg.riskScore !== undefined && leg.riskScore >= 65) {
    out.push(`Risk score: ${Math.round(leg.riskScore)}/100 — composite risk is elevated.`);
  }

  if (leg.probability < 55) {
    out.push(
      `Coin-flip exposure: model probability ${Math.round(leg.probability)}% — this leg has real downside risk on any single play.`,
    );
  }

  if (leg.l10HitCount !== undefined && leg.l10HitCount <= 3 && leg.direction === 'OVER') {
    out.push(`Recent form fade: only hit this ${leg.l10HitCount}/10 — model is fighting the recent base rate.`);
  }

  if (leg.l5Avg !== undefined && leg.seasonAvg !== undefined && Math.abs(leg.l5Avg - leg.line) < leg.seasonAvg * 0.1) {
    out.push(`At-volume line: line ${leg.line} sits within 10% of recent ${leg.l5Avg.toFixed(1)} average — structurally a coin flip.`);
  }

  if (leg.edgePercent < 0) {
    out.push(`Negative edge: ${leg.edgePercent.toFixed(1)}% — model probability is below market implied break-even.`);
  }

  return out;
}
