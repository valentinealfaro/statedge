// Mobile sticky bottom nav — Phase 85, refreshed Phase 148i. Visible
// only on mobile (≤768px). Five-tap surface that gets users to the
// platform's institutional surfaces in one tap, plus the live-pulse
// per-sport signal so users can see which sport is active without
// drilling in.
//
// Item order is value-of-pick-first:
//   ★ Elite  →  Best Bets  →  ★ Starred  →  NBA  →  MLB
// Dashboard moved off (still in main NavBar). WNBA dropped per the
// sport-priorities decision (no new WNBA features). MMA stays in the
// main NavBar — UFC slate doesn't yet feed live tracking the same way.

import { Link, useLocation } from 'react-router-dom';
import { useLiveGameCounts } from './useLiveGameCounts';
import { useStarredLiveTally } from './useStarredLiveTally';

type MbnItem = {
  label: string;
  path: string;
  key: string;
  color: string;
  /**
   * Custom active-route check — defaults to startsWith(`/${key}`).
   */
  matchPath?: (pathname: string) => boolean;
};

const ITEMS: MbnItem[] = [
  { label: '★ Elite',  path: '/elite',         key: 'elite',     color: '#ffd54f', matchPath: (p) => p === '/elite' },
  { label: 'Bets',     path: '/best-bets',     key: 'best-bets', color: '#7aa2ff', matchPath: (p) => p === '/best-bets' },
  { label: '★',        path: '/starred',       key: 'starred',   color: '#ffd54f', matchPath: (p) => p === '/starred' },
  { label: 'NBA',      path: '/nba/compare',   key: 'nba',       color: '#7aa2ff' },
  { label: 'MLB',      path: '/mlb/compare',   key: 'mlb',       color: '#66bb6a' },
];

export function MobileBottomNav() {
  const { pathname } = useLocation();
  const liveCounts = useLiveGameCounts();
  const starredTally = useStarredLiveTally();

  function isActive(item: MbnItem): boolean {
    if (item.matchPath) return item.matchPath(pathname);
    return pathname.startsWith(`/${item.key}`);
  }

  function liveDot(key: string): boolean {
    if (key === 'nba') return liveCounts.nba > 0;
    if (key === 'mlb') return liveCounts.mlb > 0;
    if (key === 'starred') return starredTally.liveInFlight > 0 || starredTally.hit > 0 || starredTally.miss > 0;
    if (key === 'best-bets') return (liveCounts.nba + liveCounts.mlb + liveCounts.ufc) > 0;
    return false;
  }

  return (
    <nav className="mobile-bottom-nav" aria-label="Quick navigation">
      {ITEMS.map((item) => {
        const active = isActive(item);
        const showDot = liveDot(item.key);
        return (
          <Link
            key={item.key}
            to={item.path}
            className={`mbn-link${active ? ' active' : ''}${showDot ? ' has-live' : ''}`}
            style={{
              borderTopColor: active ? item.color : 'transparent',
              color: active ? item.color : 'rgba(255,255,255,0.65)',
              position: 'relative',
            }}
          >
            <span className="mbn-label">{item.label}</span>
            {item.key === 'starred' && starredTally.total > 0 && (
              <span style={{
                marginLeft: 4, fontSize: 10, fontWeight: 800,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: 'rgba(255,255,255,0.65)',
              }}>
                {starredTally.total}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
