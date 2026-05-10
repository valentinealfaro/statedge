// Slate live-state context — Phase 145.
//
// One slate-page-level poll feeds every PropRow / LineCard with live
// verdict state. Avoids threading liveByLegKey through 5 levels of
// component props (Slate → FavoritesSection / GameSection → PlayerCard
// → PropRow / LineCard). Cards read their own state via the
// `useLiveLegState(playerId, statKey, line, direction)` hook.
//
// The provider polls /api/slate/live-grade every 60s with the top-N
// props from the slate (capped to keep the 50-leg server cap honored
// and ESPN/MLB API load reasonable). Any prop on the page that wasn't
// included in the poll simply gets `null` — the card stays static.

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { liveGradeLegs, type EliteLegLiveState, type SlateResolvedLine } from './api';
import { edgeScore } from './edgeScore';

type LegKey = string; // `${playerId}-${statKey}-${line}-${direction}`

const Ctx = createContext<Map<LegKey, EliteLegLiveState>>(new Map());

function makeKey(
  playerId: number,
  statKey: string,
  line: number,
  direction: 'OVER' | 'UNDER',
): LegKey {
  return `${playerId}-${statKey}-${line}-${direction}`;
}

export function SlateLiveStateProvider({
  lines,
  topN = 40,
  children,
}: {
  lines: SlateResolvedLine[];
  topN?: number;
  children: React.ReactNode;
}) {
  const [byKey, setByKey] = useState<Map<LegKey, EliteLegLiveState>>(new Map());

  // Snapshot the top-N picks (by edge score) for grading. Sorting on
  // every render is fine — the slate has < 200 lines max. The
  // dependency-array stringification keeps the effect from spinning
  // on identity changes when the underlying lines are unchanged.
  const top = useMemo(() => {
    return [...lines]
      .filter((l) => (l.injury?.status ?? '') !== 'Out')
      .map((l) => ({ line: l, edge: edgeScore(l) }))
      .sort((a, b) => b.edge - a.edge)
      .slice(0, topN)
      .map((r) => r.line);
  }, [lines, topN]);

  const topSig = top
    .map((l) => `${l.playerId}:${l.statKey}:${l.line}`)
    .join('|');

  useEffect(() => {
    if (top.length === 0) {
      setByKey(new Map());
      return;
    }
    let cancelled = false;
    const tick = () => {
      const payload = top.map((l) => ({
        playerId: l.playerId,
        playerName: l.playerName,
        statKey: l.statKey,
        // Use the model's preferred lean. For DD lines (binary), default
        // OVER — the lean field is meaningless for binary outcomes.
        direction: (l.hitProbability?.lean === 'UNDER' ? 'UNDER' : 'OVER') as 'OVER' | 'UNDER',
        line: l.line,
      }));
      liveGradeLegs(payload)
        .then((legs) => {
          if (cancelled) return;
          const m = new Map<LegKey, EliteLegLiveState>();
          for (let i = 0; i < legs.length; i++) {
            const t = top[i]!;
            const dir = (t.hitProbability?.lean === 'UNDER' ? 'UNDER' : 'OVER') as 'OVER' | 'UNDER';
            m.set(makeKey(t.playerId, t.statKey, t.line, dir), legs[i]!);
          }
          setByKey(m);
        })
        .catch(() => { /* silent — cards stay static */ });
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [topSig]);   // eslint-disable-line react-hooks/exhaustive-deps

  return <Ctx.Provider value={byKey}>{children}</Ctx.Provider>;
}

// Hook for any card to read its own live state. Returns null when the
// prop wasn't in the top-N graded set, or polling hasn't completed yet.
export function useLiveLegState(
  playerId: number,
  statKey: string,
  line: number,
  direction: 'OVER' | 'UNDER',
): EliteLegLiveState | null {
  const byKey = useContext(Ctx);
  return byKey.get(makeKey(playerId, statKey, line, direction)) ?? null;
}

// Compact verdict pill — used by both LineCard and PropRow. Renders
// the right colors/labels per verdict and self-hides when state is
// null (the prop wasn't graded this poll, or the game hasn't started).
export function LiveVerdictPill({
  state,
  compact = false,
}: {
  state: EliteLegLiveState | null;
  compact?: boolean;
}) {
  if (!state) return null;
  // Hide pre-game / pending pills outside of /elite — the slate already
  // shows projections. Surfacing PENDING everywhere creates noise.
  if (state.verdict === 'PENDING') return null;
  if (state.verdict === 'UNGRADED') return null;

  const v = state.verdict;
  const cur = state.currentValue;
  let color = '#7aa2ff';
  let bg = 'rgba(122,162,255,0.10)';
  let border = 'rgba(122,162,255,0.32)';
  let label: string = v;
  if (v === 'HIT' || v === 'ON_PACE_HIT') {
    color = '#66bb6a'; bg = 'rgba(102,187,106,0.14)'; border = 'rgba(102,187,106,0.40)';
    label = v === 'HIT' ? '✓ HIT' : '✓ ON PACE';
  } else if (v === 'MISS' || v === 'ON_PACE_MISS') {
    color = '#ef5350'; bg = 'rgba(239,83,80,0.14)'; border = 'rgba(239,83,80,0.40)';
    label = v === 'MISS' ? '✗ MISS' : '✗ LOCKED OUT';
  } else if (v === 'PUSH') {
    color = '#ffd54f'; bg = 'rgba(255,213,79,0.12)'; border = 'rgba(255,213,79,0.36)';
    label = '— PUSH';
  } else if (v === 'IN_FLIGHT') {
    color = '#ffd54f'; bg = 'rgba(255,213,79,0.10)'; border = 'rgba(255,213,79,0.32)';
    label = 'LIVE';
  }

  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: compact ? 9 : 10,
        fontWeight: 800, letterSpacing: '0.04em',
        padding: compact ? '2px 6px' : '3px 8px',
        borderRadius: 3,
        color, background: bg, border: `1px solid ${border}`,
        whiteSpace: 'nowrap',
      }}
      title={
        cur !== null
          ? `Current value: ${cur} · ${state.gameStatus.toUpperCase()}`
          : `${state.gameStatus.toUpperCase()}`
      }
    >
      {(v === 'IN_FLIGHT' || v === 'ON_PACE_HIT' || v === 'ON_PACE_MISS') && (
        <span
          className="live-pulse"
          style={{
            display: 'inline-block', width: 5, height: 5, borderRadius: 3,
            background: color,
          }}
        />
      )}
      {label}
      {cur !== null && (v !== 'IN_FLIGHT' || cur > 0) && (
        <span style={{ fontWeight: 600, opacity: 0.85 }}>· {cur}</span>
      )}
    </span>
  );
}
