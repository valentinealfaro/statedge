import type { SlateResolvedLine } from './api';

// Composite "best edge" score 0-100 — combines hit confidence with
// supporting signals (line-gap, vsOpp agreement, trend agreement,
// minus injury penalty). Used by /slate's Best-edge sort and the
// Home-page teaser to surface meaningfully strong opportunities,
// not just high-confidence ones.
//
// Tunable; OUT players hard-zero because their L10 averages mean
// nothing tonight.
export function edgeScore(line: SlateResolvedLine): number {
  if (line.injury?.status === 'Out') return 0;

  let s = line.hitProbability?.mightHitPct ?? 50;

  // Line-gap bonus: directional gap between L10 avg and the prop line.
  const lean = line.hitProbability?.lean;
  const directionalGap = lean === 'OVER'
    ? line.last10Avg - line.line
    : lean === 'UNDER'
    ? line.line - line.last10Avg
    : 0;
  if (directionalGap > 0) {
    const normalized = Math.min(directionalGap / Math.max(line.line, 1), 0.5);
    s += normalized * 30;
  }

  // Vs-opponent agreement (only when sample is meaningful).
  if (line.vsOpponent && line.vsOpponent.gamesPlayed >= 2) {
    const vsLean = line.vsOpponent.avg > line.line ? 'OVER' : 'UNDER';
    if (vsLean === lean) s += 5;
    else s -= 3;
  }

  // Trend agreement — hot for OVER leans, cold for UNDER leans.
  if (line.trend && line.last10Avg > 0) {
    const threshold = Math.max(0.5, line.last10Avg * 0.1);
    const isHot = line.trend.deltaVsL10 > threshold;
    const isCold = line.trend.deltaVsL10 < -threshold;
    if ((isHot && lean === 'OVER') || (isCold && lean === 'UNDER')) s += 5;
    else if ((isHot && lean === 'UNDER') || (isCold && lean === 'OVER')) s -= 3;
  }

  // Injury penalty (Out is hard-zero above).
  const injStatus = line.injury?.status?.toLowerCase() ?? '';
  if (injStatus.startsWith('day')) s -= 12;
  else if (injStatus.includes('quest') || injStatus.includes('doubt')) s -= 18;

  return Math.max(0, Math.min(100, Math.round(s)));
}
