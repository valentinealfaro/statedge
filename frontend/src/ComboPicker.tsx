import type { ComboKey } from './api';

const ORDER: ComboKey[] = ['PRA', 'PR', 'PA', 'RA', 'STOCKS'];

const LABELS: Record<ComboKey, string> = {
  PRA: 'Pts + Rebs + Asts',
  PR: 'Pts + Rebs',
  PA: 'Pts + Asts',
  RA: 'Rebs + Asts',
  STOCKS: 'Blks + Stls',
};

type Props = {
  combos: Record<ComboKey, number>;
  gamesAnalyzed: number;
  selected: ComboKey;
  onSelect: (k: ComboKey) => void;
};

export function ComboPicker({ combos, gamesAnalyzed, selected, onSelect }: Props) {
  return (
    <div className="combo">
      <div className="combo-buttons">
        {ORDER.map((k) => (
          <button
            key={k}
            className={k === selected ? 'combo-btn active' : 'combo-btn'}
            onClick={() => onSelect(k)}
          >
            {LABELS[k]}
          </button>
        ))}
      </div>
      <div className="combo-display">
        <div className="combo-label">{LABELS[selected]}</div>
        <div className="combo-value">{combos[selected].toFixed(1)}</div>
        <div className="combo-meta">
          Average across {gamesAnalyzed} game{gamesAnalyzed === 1 ? '' : 's'}
        </div>
      </div>
    </div>
  );
}
