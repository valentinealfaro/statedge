import type { SeasonRange } from './api';

const RANGES: { value: SeasonRange; label: string }[] = [
  { value: 'current', label: 'Current season' },
  { value: 'last2',   label: 'Last 2 seasons' },
  { value: 'last3',   label: 'Last 3 seasons' },
  { value: 'last5',   label: 'Last 5 seasons' },
];

type Props = {
  value: SeasonRange;
  onChange: (v: SeasonRange) => void;
};

export function SeasonTabs({ value, onChange }: Props) {
  return (
    <div className="season-tabs">
      <span className="season-label">Seasons</span>
      <div className="season-tab-row">
        {RANGES.map((r) => (
          <button
            key={r.value}
            className={r.value === value ? 'season-tab active' : 'season-tab'}
            onClick={() => onChange(r.value)}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  );
}
