import { Link, useLocation } from 'react-router-dom';
import { NavSearch } from './NavSearch';
import { usePlan } from './plan';
import { UserMenu } from './UserMenu';

// Shared top-of-page brand row. The brand wordmark goes home, the nav
// links cover the secondary routes, and the always-visible NavSearch
// lets the user jump straight to any player's last-10 from any page.
//
// Free users see only Compare in the nav. Slate + Standings are
// Pro-only nav items (the routes themselves stay accessible by URL —
// /slate then renders the SlatePaywall and /standings stays open as
// public NBA data).
export function NavBar() {
  const { pathname } = useLocation();
  const { plan, isAdmin } = usePlan();
  const isPro = plan === 'pro' || isAdmin;

  const active = (path: string): string => {
    if (path === '/') return pathname === '/' ? 'navlink active' : 'navlink';
    return pathname.startsWith(path) ? 'navlink active' : 'navlink';
  };

  return (
    <nav className="navbar">
      <Link to="/" className="brand" aria-label="StatEdge home">
        <span className="brand-mark">
          Stat<span className="brand-accent">Edge</span>
        </span>
      </Link>
      <div className="nav-links">
        <Link to="/compare" className={active('/compare')}>Compare</Link>
        {isPro ? (
          <>
            <Link to="/slate" className={active('/slate')}>Slate</Link>
            <Link to="/standings" className={active('/standings')}>Standings</Link>
            <Link to="/mlb" className={pathname === '/mlb' ? 'navlink active' : 'navlink'}>MLB</Link>
            <Link to="/mlb/slate" className={pathname.startsWith('/mlb/slate') ? 'navlink active' : 'navlink'}>MLB Slate</Link>
            <Link to="/mlb/calibration" className={pathname.startsWith('/mlb/calibration') ? 'navlink active' : 'navlink'}>MLB Cal.</Link>
          </>
        ) : (
          <Link to="/pricing" className={active('/pricing')}>Upgrade</Link>
        )}
      </div>
      <NavSearch />
      <UserMenu />
    </nav>
  );
}
