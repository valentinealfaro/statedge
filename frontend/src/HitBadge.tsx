import type { HitProbability } from './api';

type Props = { hit: HitProbability; gamesAnalyzed: number };

export function HitBadge({ hit, gamesAnalyzed }: Props) {
  // Color rule from spec:
  //   green if pct >= 75 and lean = OVER
  //   red   if pct >= 75 and lean = UNDER
  //   gray  otherwise
  let cls = 'hit-badge gray';
  if (hit.mightHitPct >= 75 && hit.lean === 'OVER') cls = 'hit-badge green';
  else if (hit.mightHitPct >= 75 && hit.lean === 'UNDER') cls = 'hit-badge red';

  // Historical hit ratio for the chosen lean ("hit X/N" mini-string).
  const ratio = hit.lean === 'OVER' ? hit.hitOver : hit.hitUnder;
  const hitCount = Math.round(ratio * gamesAnalyzed);

  return (
    <div className="hit-wrap">
      <div className={cls}>
        <span className="hit-pct">{hit.mightHitPct}%</span>
        <span className="hit-lean">{hit.lean}</span>
      </div>
      <div className="hit-sub">hit {hitCount}/{gamesAnalyzed} historically</div>
    </div>
  );
}
