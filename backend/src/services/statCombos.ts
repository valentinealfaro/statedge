import type { PlayerGame } from '../nba/client.js';

export type ComboKey = 'PRA' | 'PR' | 'PA' | 'RA' | 'STOCKS';

export const COMBO_LABELS: Record<ComboKey, string> = {
  PRA: 'Pts + Rebs + Asts',
  PR: 'Pts + Rebs',
  PA: 'Pts + Asts',
  RA: 'Rebs + Asts',
  STOCKS: 'Blks + Stls',
};

export function calcPRA(g: PlayerGame): number {
  return g.points + g.rebounds + g.assists;
}

export function calcPR(g: PlayerGame): number {
  return g.points + g.rebounds;
}

export function calcPA(g: PlayerGame): number {
  return g.points + g.assists;
}

export function calcRA(g: PlayerGame): number {
  return g.rebounds + g.assists;
}

export function calcStocks(g: PlayerGame): number {
  return g.blocks + g.steals;
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function calculateComboStats(games: PlayerGame[]): Record<ComboKey, number> {
  return {
    PRA: round2(average(games.map(calcPRA))),
    PR: round2(average(games.map(calcPR))),
    PA: round2(average(games.map(calcPA))),
    RA: round2(average(games.map(calcRA))),
    STOCKS: round2(average(games.map(calcStocks))),
  };
}
