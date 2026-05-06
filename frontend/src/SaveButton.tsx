import { usePlan } from './plan';
import { useSavedComparisons, type SavedDraft, type SavedItem } from './saved';

type Props = {
  // Same shape as a SavedItem minus the runtime id/savedAt.
  draft: SavedDraft;
};

// Renders a "Save matchup" / "Saved ✓" toggle. Pro-only per spec — for free
// users it shows a locked CTA instead of saving.
export function SaveButton({ draft }: Props) {
  const { plan } = usePlan();
  const { save, remove, has } = useSavedComparisons();

  if (plan === 'free') {
    return (
      <button className="save-btn locked" disabled title="Saving matchups is a Pro feature">
        Save matchup <span className="lock-pill small">PRO</span>
      </button>
    );
  }

  const saved = has(draft);

  return (
    <button
      className={saved ? 'save-btn saved' : 'save-btn'}
      onClick={() => {
        if (saved) {
          // The contentKey logic produces a stable id, so we can recompute it
          // by saving once to read the id, then remove. Simpler: synthesize id.
          // Rather than duplicate that logic here, just remove by content match.
          // (We persist `id === contentKey`, so any saved entry with matching
          //  content will share an id.)
          // Find current id and remove.
          // (Keeps this component agnostic about id encoding.)
          // Note: useSavedComparisons.has read fresh from storage, so this is safe.
          // We re-read to find the actual entry.
          const raw = localStorage.getItem('statedge.saved');
          const list: SavedItem[] = raw ? JSON.parse(raw) : [];
          const found = list.find((i) => contentKeyMatches(i, draft));
          if (found) remove(found.id);
        } else {
          save(draft);
        }
      }}
    >
      {saved ? 'Saved ✓' : 'Save matchup'}
    </button>
  );
}

function contentKeyMatches(
  item: SavedItem,
  draft: SavedDraft,
): boolean {
  if (item.type !== draft.type) return false;
  switch (item.type) {
    case 'pvt':
      return draft.type === 'pvt'
        && item.player.id === draft.player.id
        && item.team.id === draft.team.id;
    case 'pvp':
      return draft.type === 'pvp'
        && item.a.id === draft.a.id
        && item.b.id === draft.b.id;
    case 'tvt':
      return draft.type === 'tvt'
        && item.a.id === draft.a.id
        && item.b.id === draft.b.id;
    case 'last10':
      return draft.type === 'last10' && item.player.id === draft.player.id;
  }
}
