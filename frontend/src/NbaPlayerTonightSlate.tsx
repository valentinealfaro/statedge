// NbaPlayerTonightSlate — Phase 148b.
//
// Surfaces the player's tonight's-slate lines on their /nba/player/:id
// profile page. If they're not on tonight's slate, renders nothing
// (player off-day, didn't get featured, or slate not published yet).
//
// Shows the same star toggle the slate cards have so users can build
// a watchlist directly from a player profile, plus a live verdict
// pill on each line. Closes the loop: research a player → see their
// edges tonight → add to watchlist without leaving the page.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getTodaySlate,
  liveGradeLegs,
  type EliteLegLiveState,
  type SlateResolvedLine,
} from './api';
import { ProjectionBand } from './ProjectionBand';
import { LiveVerdictPill } from './slateLiveState';
import { useStarredProps } from './starredProps';

export function NbaPlayerTonightSlate({
  playerId,
}: {
  playerId: number;
}) {
  const [lines, setLines] = useState<SlateResolvedLine[] | null>(null);
  const [liveByKey, setLiveByKey] = useState<Map<string, EliteLegLiveState>>(new Map());
  const { isStarred, toggle } = useStarredProps();

  useEffect(() => {
    let cancelled = false;
    getTodaySlate('balanced')
      .then((r) => {
        if (cancelled) return;
        const all = r.resolved?.lines ?? [];
        const mine = all.filter((l) => l.playerId === playerId);
        setLines(mine);
      })
      .catch(() => {
        if (cancelled) return;
        setLines([]);
      });
    return () => { cancelled = true; };
  }, [playerId]);

  // Live-grade the player's lines every 60s.
  const linesSig = (lines ?? []).map((l) => `${l.playerId}-${l.statKey}-${l.line}`).join('|');
  useEffect(() => {
    if (!lines || lines.length === 0) { setLiveByKey(new Map()); return; }
    let cancelled = false;
    const tick = () => {
      const payload = lines.map((l) => ({
        playerId: l.playerId,
        playerName: l.playerName,
        statKey: l.statKey,
        direction: (l.hitProbability?.lean === 'UNDER' ? 'UNDER' : 'OVER') as 'OVER' | 'UNDER',
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
  }, [linesSig]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Don't render the section if the player isn't on tonight's slate
  // (or slate hasn't published / fetch failed).
  if (!lines || lines.length === 0) return null;

  return (
    <section
      className="fade-up"
      style={{
        position: 'relative',
        marginTop: 24, padding: '16px 18px',
        background: `
          radial-gradient(ellipse 50% 80% at 0% 0%, rgba(122,162,255,0.08) 0%, transparent 60%),
          linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
          var(--surface-1)
        `,
        border: '1px solid rgba(122,162,255,0.30)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        overflow: 'hidden',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(122,162,255,0.55), transparent)',
      }} />
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 12,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.10em',
          textTransform: 'uppercase', color: '#7aa2ff',
        }}>
          Tonight's slate
        </span>
        <span className="muted small" style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
          · {lines.length} {lines.length === 1 ? 'line' : 'lines'} for this player
        </span>
        <span style={{ flex: 1 }} />
        <Link to="/nba/slate" style={{ fontSize: 11, fontWeight: 700, color: '#7aa2ff', textDecoration: 'none' }}>
          Full slate →
        </Link>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {lines.map((l) => {
          const lean = (l.projection?.edge.lean ?? '').toLowerCase().includes('under') ? 'UNDER' : 'OVER';
          const prob = lean === 'OVER'
            ? (l.projection?.probability.over ?? l.hitProbability?.hitOver ?? 50)
            : (l.projection?.probability.under ?? l.hitProbability?.hitUnder ?? 50);
          const edgePct = l.projection?.edge.score ?? 0;
          const projection = l.projection?.projection.final ?? null;
          const id = `nba-${l.playerId}-${l.statKey}-${l.line}-${lean}`;
          const starred = isStarred(id);
          const live = liveByKey.get(id) ?? null;
          const notes = l.projection?.modelNotes?.slice(0, 2) ?? [];
          return (
            <li
              key={`${l.statKey}-${l.line}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '10px 12px',
                background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 30%), rgba(0,0,0,0.22)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderLeft: `3px solid ${lean === 'OVER' ? '#66bb6a' : '#ef5350'}`,
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {l.statLabel}
                  {' '}
                  <strong style={{ color: 'var(--text-1)' }}>{l.line}</strong>
                  {' '}
                  <span style={{ color: lean === 'OVER' ? '#66bb6a' : '#ef5350', fontWeight: 800 }}>
                    {lean === 'OVER' ? '↑ OVER' : '↓ UNDER'}
                  </span>
                </div>
                <div className="muted small" style={{ fontSize: 11, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span><strong style={{ color: '#fff' }}>{prob.toFixed(1)}%</strong> prob</span>
                  <span style={{ color: edgePct >= 5 ? '#66bb6a' : edgePct <= -5 ? '#ef5350' : 'rgba(255,255,255,0.55)' }}>
                    {edgePct >= 0 ? '+' : ''}{edgePct.toFixed(1)}pp edge
                  </span>
                </div>
                {notes.length > 0 && (
                  <ul style={{
                    margin: '6px 0 0', paddingLeft: 14, fontSize: 10, lineHeight: 1.45,
                    color: 'rgba(255,255,255,0.55)',
                  }}>
                    {notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}
              </div>
              {projection !== null && l.projection && (
                <ProjectionBand
                  rangeLow={l.projection.projection.rangeLow}
                  projection={projection}
                  rangeHigh={l.projection.projection.rangeHigh}
                  line={l.line}
                  lean={lean}
                  compact
                />
              )}
              <LiveVerdictPill state={live} compact />
              <button
                type="button"
                onClick={() => toggle({
                  sport: 'nba',
                  playerId: l.playerId,
                  playerName: l.playerName,
                  team: l.team,
                  statKey: l.statKey,
                  statLabel: l.statLabel,
                  line: l.line,
                  direction: lean,
                  snapshot: { probability: prob, edgePercent: edgePct, projection },
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
