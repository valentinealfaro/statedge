// Mobile sticky bottom nav — Phase 85. Visible only on mobile (≤768px).
// Five-tap surface that gets users to any sport or the dashboard from
// any page in one tap. Intentionally minimal — labels short, icons
// emoji-free, sport color stripes for instant orientation.

import { Link, useLocation } from 'react-router-dom';

const ITEMS: Array<{ label: string; path: string; key: string; color: string }> = [
  { label: 'Dashboard', path: '/dashboard',     key: 'dashboard', color: '#cccccc' },
  { label: 'NBA',       path: '/nba/compare',   key: 'nba',       color: '#7aa2ff' },
  { label: 'MLB',       path: '/mlb/compare',   key: 'mlb',       color: '#66bb6a' },
  { label: 'WNBA',      path: '/wnba/compare',  key: 'wnba',      color: '#b388ff' },
];

export function MobileBottomNav() {
  const { pathname } = useLocation();

  function isActive(item: typeof ITEMS[number]): boolean {
    if (item.key === 'dashboard') return pathname === '/dashboard';
    return pathname.startsWith(`/${item.key}`);
  }

  return (
    <nav className="mobile-bottom-nav" aria-label="Quick navigation">
      {ITEMS.map((item) => {
        const active = isActive(item);
        return (
          <Link
            key={item.key}
            to={item.path}
            className={`mbn-link${active ? ' active' : ''}`}
            style={{
              borderTopColor: active ? item.color : 'transparent',
              color: active ? item.color : 'rgba(255,255,255,0.65)',
            }}
          >
            <span className="mbn-label">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
