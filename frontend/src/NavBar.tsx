import { Link, useLocation } from 'react-router-dom';
import { NavSearch } from './NavSearch';
import { UserMenu } from './UserMenu';

// Shared top-of-page brand row. The brand wordmark goes home, the nav
// links cover the secondary routes, and the always-visible NavSearch
// lets the user jump straight to any player's last-10 from any page.
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
        <Link to="/slate" className={active('/slate')}>Slate</Link>
        <Link to="/standings" className={active('/standings')}>Standings</Link>
      </div>
      <NavSearch />
      <UserMenu />
    </nav>
  );
}
