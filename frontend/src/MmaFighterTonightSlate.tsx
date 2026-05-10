// MmaFighterTonightSlate — Phase 148d.
//
// Symmetric to NbaPlayerTonightSlate / MlbPlayerTonightSlate, scoped
// to /mma/fighter/:fighterId. Filters today's UFC slate by fighter
// display name (the slate stores fighter NAME — no fighter id — since
// admin pastes pipe-format text).
//
// MMA legs stay UNGRADED in our live grader by design (no per-fight
// live stat ingestion yet), so this panel doesn't try to live-poll
// verdicts — but star toggle + the prop chip rendering work the same.

import { Link } from 'react-router-dom';
import { getUfcSlateToday, type UfcStoredLine } from './api';
import { useEffect, useState } from 'react';
import { useStarredProps } from './starredProps';

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
  const { isStarred, toggle } = useStarredProps();

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
          const numericId = Number(fighterId) || 0;
          const id = `mma-${numericId}-${l.statKey}-${l.line}-${dir}`;
          const starred = isStarred(id);
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
                  UFC projection engine ships in a future phase — line shown as published; no live grading yet.
                </div>
              </div>
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
