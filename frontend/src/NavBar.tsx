import { Link, useLocation } from 'react-router-dom';
import { NavSearch } from './NavSearch';
import { usePlan } from './plan';
import { UserMenu } from './UserMenu';

// Sport-grouped navigation per the UX spec ("institutional sports
// intelligence operating system, not a collection of pages").
//
// Top nav: NBA · MLB · (sport switcher pill)
// Subnav (per sport): Compare · Slate · Standings · Calibration
//   — only the items that actually exist for each sport are rendered.
//
// What's deliberately NOT in the nav yet (per mission's "no fake
// completeness" rule):
//   - Dashboard — needs cross-sport queries + UI work; saved to
//     roadmap as concrete next slice.
//   - Research Lab — needs prop / line / matchup explorers; saved
//     to roadmap.
//   - MLB Standings — page doesn't exist yet.
// All three land in the nav as soon as they're real pages, not
// placeholder links.

type SportKey = 'nba' | 'mlb' | 'wnba';

// Resolve which sport the user is currently viewing from the URL.
// Falls back to 'nba' as the default when the user is on a route
// that's neither sport-specific (home, pricing, game detail).
function resolveSport(pathname: string): SportKey | null {
  if (pathname.startsWith('/nba')) return 'nba';
  if (pathname.startsWith('/mlb')) return 'mlb';
  if (pathname.startsWith('/wnba')) return 'wnba';
  return null;
}

// Subnav items per sport. Only includes pages that ACTUALLY exist —
// adding placeholder links here would violate the mission's "no
// fake completeness" rule. Items get added when their pages ship.
type SubnavItem = { label: string; path: string };

const NBA_SUBNAV: SubnavItem[] = [
  { label: 'Compare', path: '/nba/compare' },
  { label: 'Slate', path: '/nba/slate' },
  { label: 'Standings', path: '/nba/standings' },
];

const MLB_SUBNAV: SubnavItem[] = [
  { label: 'Compare', path: '/mlb/compare' },
  { label: 'Slate', path: '/mlb/slate' },
  { label: 'Standings', path: '/mlb/standings' },
  { label: 'Calibration', path: '/mlb/calibration' },
];

// WNBA subnav grows as Phase 74-78 ship each surface. Only the items
// that ACTUALLY exist appear here per the mission's "no fake
// completeness" rule. Compare / Slate / Calibration land in their
// own phases.
const WNBA_SUBNAV: SubnavItem[] = [
  { label: 'Standings', path: '/wnba/standings' },
];

// Toggle the sport prefix in the current URL. /nba/slate ↔ /mlb/slate
// swaps the prefix while preserving the rest of the path. Lands on
// the sport's "compare" page when the current page doesn't have a
// counterpart in the other sport (e.g. /mlb/calibration → /nba/compare
// because NBA calibration lives inside /nba/slate as a tab).
function switchSportPath(currentPath: string, target: SportKey): string {
  const tail = currentPath.replace(/^\/(nba|mlb|wnba)\//, '');
  const targetSubnav = target === 'nba' ? NBA_SUBNAV : target === 'mlb' ? MLB_SUBNAV : WNBA_SUBNAV;
  const matched = targetSubnav.find((it) => it.path.endsWith(`/${tail}`));
  // Sport-specific landing fallback when the current page has no
  // counterpart (e.g. /mlb/calibration doesn't exist for WNBA yet).
  return matched?.path ?? `/${target}/standings`;
}

export function NavBar() {
  const { pathname } = useLocation();
  const { plan, isAdmin } = usePlan();
  const isPro = plan === 'pro' || isAdmin;
  const sport = resolveSport(pathname);

  const subnav =
    sport === 'nba'  ? NBA_SUBNAV
    : sport === 'mlb' ? MLB_SUBNAV
    : sport === 'wnba' ? WNBA_SUBNAV
    : [];

  return (
    <>
      <nav className="navbar">
        <Link to="/" className="brand" aria-label="StatEdge home">
          <span className="brand-mark">
            Stat<span className="brand-accent">Edge</span>
          </span>
        </Link>

        {isPro ? (
          <div className="nav-links">
            <Link
              to="/nba/compare"
              className={sport === 'nba' ? 'navlink active sport-nba' : 'navlink'}
            >
              NBA
            </Link>
            <Link
              to="/mlb/compare"
              className={sport === 'mlb' ? 'navlink active sport-mlb' : 'navlink'}
            >
              MLB
            </Link>
            <Link
              to="/wnba/standings"
              className={sport === 'wnba' ? 'navlink active sport-wnba' : 'navlink'}
            >
              WNBA
            </Link>
          </div>
        ) : (
          <div className="nav-links">
            <Link
              to="/nba/compare"
              className={sport === 'nba' ? 'navlink active sport-nba' : 'navlink'}
            >
              NBA
            </Link>
            <Link to="/pricing" className={pathname.startsWith('/pricing') ? 'navlink active' : 'navlink'}>
              Upgrade
            </Link>
          </div>
        )}

        <NavSearch />

        {/* Sport-switcher pill — only renders when on a sport page,
            and only for Pro users. Toggles between NBA and MLB at the
            same conceptual depth (slate → slate, compare → compare). */}
        {sport && isPro && (
          <div className="sport-switcher" role="tablist" aria-label="Sport">
            <Link
              to={switchSportPath(pathname, 'nba')}
              className={`sport-pill ${sport === 'nba' ? 'active sport-nba' : ''}`}
              aria-selected={sport === 'nba'}
            >
              NBA
            </Link>
            <Link
              to={switchSportPath(pathname, 'mlb')}
              className={`sport-pill ${sport === 'mlb' ? 'active sport-mlb' : ''}`}
              aria-selected={sport === 'mlb'}
            >
              MLB
            </Link>
            <Link
              to={switchSportPath(pathname, 'wnba')}
              className={`sport-pill ${sport === 'wnba' ? 'active sport-wnba' : ''}`}
              aria-selected={sport === 'wnba'}
            >
              WNBA
            </Link>
          </div>
        )}

        <UserMenu />
      </nav>

      {/* Subnav — visible only inside a sport. Mirrors NBA <-> MLB
          structure for muscle-memory consistency. */}
      {sport && subnav.length > 0 && (
        <nav className={`subnav subnav-${sport}`} aria-label={`${sport.toUpperCase()} sections`}>
          {subnav.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={pathname === item.path ? 'subnav-link active' : 'subnav-link'}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
