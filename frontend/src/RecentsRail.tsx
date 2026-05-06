import { describeItem, type SavedItem } from './saved';
import { useRecents } from './recents';

type Props = {
  onOpen: (item: SavedItem) => void;
};

const TYPE_ICON: Record<SavedItem['type'], string> = {
  pvt: '🏀',
  pvp: '⚔︎',
  tvt: '🛡',
  last10: '📊',
};

// Compact horizontal list of recently-viewed comparisons. Shown above the
// search prompts so the user can jump back into something without re-typing.
export function RecentsRail({ onOpen }: Props) {
  const { items, clear } = useRecents();

  if (items.length === 0) return null;

  return (
    <div className="recents-rail">
      <div className="recents-head">
        <span className="recents-title">Recently viewed</span>
        <button className="link" onClick={clear}>Clear</button>
      </div>
      <div className="recents-row">
        {items.map((item) => (
          <button
            key={item.id}
            className="recent-chip"
            onClick={() => onOpen(item)}
            title={describeItem(item)}
          >
            <span className="recent-icon" aria-hidden>{TYPE_ICON[item.type]}</span>
            <span className="recent-label">{describeItem(item)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
