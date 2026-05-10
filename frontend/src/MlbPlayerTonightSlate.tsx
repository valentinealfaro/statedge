// MlbPlayerTonightSlate — Phase 148c.
//
// Symmetric to NbaPlayerTonightSlate. Surfaces every leg the model has
// flagged for this player on tonight's MLB slate, deduplicated across
// combo cards (same leg can appear on Best 2/Best 3/etc.). Self-hides
// cleanly when the player isn't featured.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMlbDailySlate,
  liveGradeLegs,
  type EliteLegLiveState,
  type MlbSlateLeg,
} from './api';
import { ProjectionBand } from './ProjectionBand';
import { LiveVerdictPill } from './slateLiveState';
import { useStarredProps } from './starredProps';

export function MlbPlayerTonightSlate({
  playerId,
}: {
  playerId: number;
}) {
  const [legs, setLegs] = useState<MlbSlateLeg[] | null>(null);
  const [liveByKey, setLiveByKey] = useState<Map<string, EliteLegLiveState>>(new Map());
  const { isStarred, toggle } = useStarredProps();

  useEffect(() => {
    let cancelled = false;
    getMlbDailySlate()
      .then((r) => {
        if (cancelled) return;
        const out: MlbSlateLeg[] = [];
        const seen = new Set<string>();
        // Walk every combo's legs, dedupe by player+stat+line+direction
        for (const slot of r.resolved?.combos ?? []) {
          if (!slot.combo) continue;
          for (const leg of slot.combo.legs) {
            if (leg.playerId !== playerId) continue;
            const k = `${leg.statKey}-${leg.line}-${leg.direction}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(leg);
          }
        }
        // Wild Card legs too
        for (const wc of r.resolved?.wildCard.legs ?? []) {
          if (wc.playerId !== playerId) continue;
          const k = `${wc.statKey}-${wc.line}-${wc.direction}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(wc as unknown as MlbSlateLeg);
        }
        setLegs(out);
      })
      .catch(() => {
        if (cancelled) return;
        setLegs([]);
      });
    return () => { cancelled = true; };
  }, [playerId]);

  const sig = (legs ?? []).map((l) => `${l.statKey}-${l.line}-${l.direction}`).join('|');
  useEffect(() => {
    if (!legs || legs.length === 0) { setLiveByKey(new Map()); return; }
    let cancelled = false;
    const tick = () => {
      const payload = legs.map((l) => ({
        playerId: l.playerId,
        playerName: l.playerName,
        statKey: l.statKey,
        direction: l.direction,
        line: l.line,
      }));
      liveGradeLegs(payload)
        .then((states) => {
          if (cancelled) return;
          const m = new Map<string, EliteLegLiveState>();
          for (let i = 0; i < states.length; i++) {
            const p = payload[i]!;
            m.set(`${p.playerId}-${p.statKey}-${p.line}-${p.direction}`, states[i]!);
          }
          setLiveByKey(m);
        })
        .catch(() => { /* silent */ });
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [sig]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!legs || legs.length === 0) return null;

  return (
    <section
      className="fade-up"
      style={{
        position: 'relative',
        marginTop: 24, padding: '16px 18px',
        background: `
          radial-gradient(ellipse 50% 80% at 0% 0%, rgba(102,187,106,0.08) 0%, transparent 60%),
          linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
          var(--surface-1)
        `,
        border: '1px solid rgba(102,187,106,0.30)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        overflow: 'hidden',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(102,187,106,0.55), transparent)',
      }} />
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 12,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.10em',
          textTransform: 'uppercase', color: '#66bb6a',
        }}>
          Tonight's slate
        </span>
        <span className="muted small" style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
          · {legs.length} {legs.length === 1 ? 'line' : 'lines'} for this player
        </span>
        <span style={{ flex: 1 }} />
        <Link to="/mlb/slate" style={{ fontSize: 11, fontWeight: 700, color: '#7aa2ff', textDecoration: 'none' }}>
          Full slate →
        </Link>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {legs.map((l) => {
          const id = `mlb-${l.playerId}-${l.statKey}-${l.line}-${l.direction}`;
          const starred = isStarred(id);
          const live = liveByKey.get(id) ?? null;
          return (
            <li
              key={`${l.statKey}-${l.line}-${l.direction}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '10px 12px',
                background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 30%), rgba(0,0,0,0.22)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderLeft: `3px solid ${l.direction === 'OVER' ? '#66bb6a' : '#ef5350'}`,
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {l.statLabel}
                  {' '}
                  <strong style={{ color: 'var(--text-1)' }}>{l.line}</strong>
                  {' '}
                  <span style={{ color: l.direction === 'OVER' ? '#66bb6a' : '#ef5350', fontWeight: 800 }}>
                    {l.direction === 'OVER' ? '↑ OVER' : '↓ UNDER'}
                  </span>
                </div>
                <div className="muted small" style={{ fontSize: 11, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span><strong style={{ color: '#fff' }}>{l.probability.toFixed(1)}%</strong> prob</span>
                  <span style={{ color: l.edgePercent >= 5 ? '#66bb6a' : l.edgePercent <= -5 ? '#ef5350' : 'rgba(255,255,255,0.55)' }}>
                    {l.edgePercent >= 0 ? '+' : ''}{l.edgePercent.toFixed(1)}pp edge
                  </span>
                  {l.trapScore >= 60 && (
                    <span style={{ color: '#ef5350' }}>⚠ trap {l.trapScore}</span>
                  )}
                </div>
              </div>
              {l.rangeLow !== undefined && l.rangeHigh !== undefined && (
                <ProjectionBand
                  rangeLow={l.rangeLow}
                  projection={l.projection}
                  rangeHigh={l.rangeHigh}
                  line={l.line}
                  lean={l.direction}
                  compact
                />
              )}
              <LiveVerdictPill state={live} compact />
              <button
                type="button"
                onClick={() => toggle({
                  sport: 'mlb',
                  playerId: l.playerId,
                  playerName: l.playerName,
                  team: l.team,
                  statKey: l.statKey,
                  statLabel: l.statLabel,
                  line: l.line,
                  direction: l.direction,
                  snapshot: { probability: l.probability, edgePercent: l.edgePercent, projection: l.projection },
                })}
                title={starred ? 'Unstar' : 'Star — track on /starred'}
                aria-label={starred ? 'Unstar' : 'Star'}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: starred ? '#ffd54f' : 'rgba(255,255,255,0.30)',
                  fontSize: 16, fontWeight: 800,
                  padding: '4px 8px',
                  lineHeight: 1,
                }}
              >
                {starred ? '★' : '☆'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
