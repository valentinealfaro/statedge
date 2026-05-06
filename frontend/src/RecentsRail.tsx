import { Link } from 'react-router-dom';
import { describeItem, type SavedItem } from './saved';
import { useRecents } from './recents';

type Props = {
  // When provided (from Compare.tsx), clicking a chip mutates parent state
  // directly — needed because react-router doesn't remount Compare when
  // searchParams change, so URL-based navigation alone wouldn't trigger
  // the hydration effect.
  // When omitted (e.g. from Home), each chip is a real <Link> that
  // navigates to /compare?... and Compare hydrates from the URL on mount.
  onOpen?: (item: SavedItem) => void;
  heading?: string;
};

const TYPE_ICON: Record<SavedItem['type'], string> = {
  pvt: '🏀',
  pvp: '⚔︎',
  tvt: '🛡',
  last10: '📊',
};

// Compact horizontal list of recently-viewed comparisons. Used both inside
// Compare (above the search prompts when nothing is picked) and on the
// Home page below the trending rails for returning visitors.
export function RecentsRail({ onOpen, heading = 'Recently viewed' }: Props) {
  const { items, clear } = useRecents();

  if (items.length === 0) return null;

  return (
    <div className="recents-rail">
      <div className="recents-head">
        <span className="recents-title">{heading}</span>
        <button className="link" onClick={clear}>Clear</button>
      </div>
      <div className="recents-row">
        {items.map((item) => onOpen ? (
          <button
            key={item.id}
            className="recent-chip"
            onClick={() => onOpen(item)}
            title={describeItem(item)}
          >
            <span className="recent-icon" aria-hidden>{TYPE_ICON[item.type]}</span>
            <span className="recent-label">{describeItem(item)}</span>
          </button>
        ) : (
          <Link
            key={item.id}
            className="recent-chip"
            to={hrefFor(item)}
            title={describeItem(item)}
          >
            <span className="recent-icon" aria-hidden>{TYPE_ICON[item.type]}</span>
            <span className="recent-label">{describeItem(item)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function hrefFor(item: SavedItem): string {
  switch (item.type) {
    case 'pvt':    return `/compare?m=pvt&pid=${item.player.id}&tid=${item.team.id}`;
    case 'pvp':    return `/compare?m=pvp&pa=${item.a.id}&pb=${item.b.id}`;
    case 'tvt':    return `/compare?m=tvt&ta=${item.a.id}&tb=${item.b.id}`;
    case 'last10': return `/compare?m=last10&pid=${item.player.id}`;
  }
}
