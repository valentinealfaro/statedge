import { Link, useLocation } from 'react-router-dom';

// Shared top-of-page brand row. The brand wordmark goes home, the nav
// links cover the secondary routes. Active link is highlighted by
// matching pathname (Compare highlights for any /compare* URL since
// sub-routes don't yet exist but URL params do).
export function NavBar() {
  const { pathname } = useLocation();
  const active = (path: string): string => {
    if (path === '/') return pathname === '/' ? 'navlink active' : 'navlink';
    return pathname.startsWith(path) ? 'navlink active' : 'navlink';
  };

  return (
    <nav className="navbar">
      <Link to="/" className="brand">StatEdge</Link>
      <div className="nav-links">
        <Link to="/compare" className={active('/compare')}>Compare</Link>
        <Link to="/standings" className={active('/standings')}>Standings</Link>
      </div>
    </nav>
  );
}
