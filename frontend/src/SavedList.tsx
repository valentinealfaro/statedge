import { describeItem, useSavedComparisons, type SavedItem } from './saved';

type Props = {
  onOpen: (item: SavedItem) => void;
};

const TYPE_LABEL: Record<SavedItem['type'], string> = {
  pvt: 'Player vs Team',
  pvp: 'Player vs Player',
  tvt: 'Team vs Team',
  last10: 'Last 10 Games',
};

function relTime(ts: number): string {
  const secs = (Date.now() - ts) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function SavedList({ onOpen }: Props) {
  const { items, remove } = useSavedComparisons();

  if (items.length === 0) {
    return (
      <p className="muted">
        No saved comparisons yet. Use the "Save matchup" button on any comparison
        page to keep it here.
      </p>
    );
  }

  return (
    <div className="saved-list">
      {items.map((item) => (
        <div key={item.id} className="saved-row">
          <button className="saved-open" onClick={() => onOpen(item)}>
            <div className="saved-title">{describeItem(item)}</div>
            <div className="saved-meta">
              {TYPE_LABEL[item.type]} · saved {relTime(item.savedAt)}
            </div>
          </button>
          <button
            className="link saved-remove"
            onClick={() => remove(item.id)}
            title="Remove from saved"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
