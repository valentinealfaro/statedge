import type { SelectedStat } from './api';

const SINGLES: SelectedStat[] = ['points', 'rebounds', 'assists'];
const COMBOS: SelectedStat[] = ['PRA', 'PR', 'PA', 'RA', 'STOCKS'];

const LABELS: Record<SelectedStat, string> = {
  points: 'Points',
  rebounds: 'Rebounds',
  assists: 'Assists',
  PRA: 'Pts + Rebs + Asts',
  PR: 'Pts + Rebs',
  PA: 'Pts + Asts',
  RA: 'Rebs + Asts',
  STOCKS: 'Blks + Stls',
};

type Props = {
  value: SelectedStat;
  onChange: (s: SelectedStat) => void;
};

export function StatPicker({ value, onChange }: Props) {
  return (
    <div className="stat-picker">
      <span className="picker-label">Stat</span>
      <div className="picker-row">
        {SINGLES.map((s) => (
          <button
            key={s}
            className={s === value ? 'pick-btn active' : 'pick-btn'}
            onClick={() => onChange(s)}
          >
            {LABELS[s]}
          </button>
        ))}
      </div>
      <div className="picker-row combos">
        {COMBOS.map((s) => (
          <button
            key={s}
            className={s === value ? 'pick-btn active' : 'pick-btn'}
            onClick={() => onChange(s)}
          >
            {LABELS[s]}
          </button>
        ))}
      </div>
    </div>
  );
}

export const STAT_LABELS = LABELS;
