// MmaFighterTonightSlate — Phase 148d (live verdicts wired in 148p).
//
// Symmetric to NbaPlayerTonightSlate / MlbPlayerTonightSlate, scoped
// to /mma/fighter/:fighterId. Filters today's UFC slate by fighter
// display name (the slate stores fighter NAME — no fighter id — since
// admin pastes pipe-format text).
//
// Iter 44 wired UFC live grading via fightcenter for sig_strikes,
// takedowns, knockdowns, and control_time. This panel now polls
// /api/slate/live-grade once a minute and shows a verdict pill on
// every line. Unsupported stat keys (rd1_*, rounds, fight_time,
// fantasy_score) come back UNGRADED honestly — those rows just hide
// the pill rather than showing a fake verdict.

import { Link } from 'react-router-dom';
import { getUfcSlateToday, liveGradeLegs, type EliteLegLiveState, type UfcStoredLine } from './api';
import { useEffect, useState } from 'react';
import { LiveVerdictPill } from './slateLiveState';
import { useStarredProps } from './starredProps';

// Keep in sync with backend liveEliteGrader.gradeMmaLegLive — anything
// outside this set comes back UNGRADED, so we shouldn't render a pill.
const MMA_GRADABLE = new Set(['sig_strikes', 'takedowns', 'knockdowns', 'control_time']);

const STAT_LABEL: Record<string, string> = {
  sig_strikes:     'Sig Strikes',
  rd1_sig_strikes: 'R1 Sig Strikes',
  takedowns:       'Takedowns',
  rd1_takedowns:   'R1 Takedowns',
  knockdowns:      'Knockdowns',
  rounds:          'Rounds',
  fight_time:      'Fight Time',
  fantasy_score:   'Fantasy',
  control_time:    'Control Time',
};

function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

export function MmaFighterTonightSlate({
  fighterId,
  fighterName,
}: {
  fighterId: string;
  fighterName: string;
}) {
  const [lines, setLines] = useState<UfcStoredLine[] | null>(null);
  const [liveByKey, setLiveByKey] = useState<Map<string, EliteLegLiveState>>(new Map());
  const { isStarred, toggle } = useStarredProps();
  const numericId = Number(fighterId) || 0;

  useEffect(() => {
    let cancelled = false;
    getUfcSlateToday()
      .then((r) => {
        if (cancelled) return;
        const target = normalizeName(fighterName);
        const mine = (r.slate?.lines ?? []).filter(
          (l) => normalizeName(l.fighterName) === target,
        );
        setLines(mine);
      })
      .catch(() => {
        if (cancelled) return;
        setLines([]);
      });
    return () => { cancelled = true; };
  }, [fighterName]);

  // Poll live verdicts for the fighter's gradable lines once we know
  // them. We send only the supported stat keys to keep payload tight;
  // each line gets its own OVER + UNDER variant when published as
  // 'both' (PrizePicks "either side" flex), so the user sees the
  // pill for whichever direction they care about.
  const gradableSig = (lines ?? [])
    .filter((l) => MMA_GRADABLE.has(l.statKey))
    .map((l) => `${l.statKey}|${l.line}|${l.direction}`)
    .join('::');
  useEffect(() => {
    if (!lines) return;
    const gradable = lines.filter((l) => MMA_GRADABLE.has(l.statKey));
    if (gradable.length === 0) { setLiveByKey(new Map()); return; }
    let cancelled = false;
    const tick = () => {
      // Expand 'both' into OVER + UNDER so each side's pill ticks.
      const payload: Array<{ playerId: number; playerName: string; statKey: string; direction: 'OVER' | 'UNDER'; line: number; key: string }> = [];
      for (const l of gradable) {
        const dirs: Array<'OVER' | 'UNDER'> = l.direction === 'both' ? ['OVER', 'UNDER'] : [l.direction === 'under' ? 'UNDER' : 'OVER'];
        for (const dir of dirs) {
          payload.push({
            playerId: numericId,
            playerName: fighterName,
            statKey: l.statKey,
            direction: dir,
            line: l.line,
            key: `${l.statKey}|${l.line}|${dir}`,
          });
        }
      }
      liveGradeLegs(payload.map(({ playerId, playerName, statKey, direction, line }) => ({
        playerId, playerName, statKey, direction, line,
      })))
        .then((states) => {
          if (cancelled) return;
          const m = new Map<string, EliteLegLiveState>();
          for (let i = 0; i < states.length; i++) {
            m.set(payload[i]!.key, states[i]!);
          }
          setLiveByKey(m);
        })
        .catch(() => { /* silent — pill self-hides on null */ });
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [gradableSig, fighterName, numericId]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!lines || lines.length === 0) return null;

  return (
    <section
      className="fade-up"
      style={{
        position: 'relative',
        marginTop: 18, padding: '16px 18px',
        background: `
          radial-gradient(ellipse 50% 80% at 0% 0%, rgba(239,83,80,0.08) 0%, transparent 60%),
          linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
          var(--surface-1)
        `,
        border: '1px solid rgba(239,83,80,0.30)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        overflow: 'hidden',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(239,83,80,0.55), transparent)',
      }} />
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 12,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.10em',
          textTransform: 'uppercase', color: '#ef5350',
        }}>
          Tonight's UFC slate
        </span>
        <span className="muted small" style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
          · {lines.length} {lines.length === 1 ? 'line' : 'lines'} for this fighter
        </span>
        <span style={{ flex: 1 }} />
        <Link to="/mma/slate" style={{ fontSize: 11, fontWeight: 700, color: '#7aa2ff', textDecoration: 'none' }}>
          Full slate →
        </Link>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {lines.map((l) => {
          // UFC slate exposes 'over'/'under'/'both'. We star one side
          // at a time so 'both' goes through the toggle as OVER (the
          // primary line). User can re-toggle / choose later.
          const dir: 'OVER' | 'UNDER' = l.direction === 'under' ? 'UNDER' : 'OVER';
          const id = `mma-${numericId}-${l.statKey}-${l.line}-${dir}`;
          const starred = isStarred(id);
          const isGradable = MMA_GRADABLE.has(l.statKey);
          // For 'both' lines the user-facing pill defaults to OVER —
          // matching the star toggle's primary side. Avoids two pills
          // competing for the same row's attention.
          const liveKey = `${l.statKey}|${l.line}|${dir}`;
          const live = liveByKey.get(liveKey) ?? null;
          return (
            <li
              key={`${l.statKey}-${l.line}-${l.direction}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '10px 12px',
                background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 30%), rgba(0,0,0,0.22)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderLeft: `3px solid ${dir === 'OVER' ? '#66bb6a' : '#ef5350'}`,
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {STAT_LABEL[l.statKey] ?? l.statKey}
                  {' '}
                  <strong style={{ color: 'var(--text-1)' }}>{l.line}</strong>
                  {' '}
                  <span style={{ color: dir === 'OVER' ? '#66bb6a' : '#ef5350', fontWeight: 800 }}>
                    {l.direction === 'both' ? '↕ BOTH' : dir === 'OVER' ? '↑ OVER' : '↓ UNDER'}
                  </span>
                </div>
                <div className="muted small" style={{ fontSize: 11, marginTop: 4, color: 'rgba(255,255,255,0.55)' }}>
                  {isGradable
                    ? 'Line shown as published — UFC projection engine ships in a later phase. Live verdict on the right ticks every 60s from fightcenter.'
                    : 'Line shown as published. No live grading for this stat key yet — needs round-by-round or fight-clock data.'}
                </div>
              </div>
              {live && live.verdict !== 'UNGRADED' && (
                <LiveVerdictPill state={live} compact />
              )}
              <button
                type="button"
                onClick={() => toggle({
                  sport: 'mma',
                  playerId: numericId,
                  playerName: fighterName,
                  team: null,
                  statKey: l.statKey,
                  statLabel: STAT_LABEL[l.statKey] ?? l.statKey,
                  line: l.line,
                  direction: dir,
                  snapshot: { probability: 0, edgePercent: 0, projection: null },
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
