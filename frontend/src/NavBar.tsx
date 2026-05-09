import { Link, useLocation } from 'react-router-dom';
import { MobileBottomNav } from './MobileBottomNav';
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

type SportKey = 'nba' | 'mlb' | 'wnba' | 'mma';

// Resolve which sport the user is currently viewing from the URL.
// Falls back to 'nba' as the default when the user is on a route
// that's neither sport-specific (home, pricing, game detail).
function resolveSport(pathname: string): SportKey | null {
  if (pathname.startsWith('/nba')) return 'nba';
  if (pathname.startsWith('/mlb')) return 'mlb';
  if (pathname.startsWith('/wnba')) return 'wnba';
  if (pathname.startsWith('/mma')) return 'mma';
  return null;
}

// Subnav items per sport. Only includes pages that ACTUALLY exist —
// adding placeholder links here would violate the mission's "no
// fake completeness" rule. Items get added when their pages ship.
type SubnavItem = { label: string; path: string };

const NBA_SUBNAV: SubnavItem[] = [
  { label: 'Compare', path: '/nba/compare' },
  { label: 'Slate', path: '/nba/slate' },
  { label: 'History', path: '/nba/slate/history' },
  { label: 'Standings', path: '/nba/standings' },
  { label: 'Calibration', path: '/nba/calibration' },
];

const MLB_SUBNAV: SubnavItem[] = [
  { label: 'Compare', path: '/mlb/compare' },
  { label: 'Slate', path: '/mlb/slate' },
  { label: 'History', path: '/mlb/slate/history' },
  { label: 'Standings', path: '/mlb/standings' },
  { label: 'Calibration', path: '/mlb/calibration' },
];

// WNBA subnav — Phases 74-78 shipped. Full institutional surface area
// matches NBA + MLB.
const WNBA_SUBNAV: SubnavItem[] = [
  { label: 'Compare', path: '/wnba/compare' },
  { label: 'Slate', path: '/wnba/slate' },
  { label: 'History', path: '/wnba/slate/history' },
  { label: 'Standings', path: '/wnba/standings' },
  { label: 'Calibration', path: '/wnba/calibration' },
];

// MMA subnav — Phase 107 foundation, Phase 110a adds slate.
const MMA_SUBNAV: SubnavItem[] = [
  { label: 'Scoreboard', path: '/mma/scoreboard' },
  { label: 'Slate',      path: '/mma/slate' },
];

// Toggle the sport prefix in the current URL. /nba/slate ↔ /mlb/slate
// (sport-switcher pill removed — main nav already has sport links;
// the secondary pill row was redundant.)

export function NavBar() {
  const { pathname } = useLocation();
  const { plan, isAdmin } = usePlan();
  const isPro = plan === 'pro' || isAdmin;
  const sport = resolveSport(pathname);

  const subnav =
    sport === 'nba'  ? NBA_SUBNAV
    : sport === 'mlb' ? MLB_SUBNAV
    : sport === 'wnba' ? WNBA_SUBNAV
    : sport === 'mma' ? MMA_SUBNAV
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
              to="/elite"
              className={pathname === '/elite' ? 'navlink active' : 'navlink'}
              style={{ color: pathname === '/elite' ? '#0d1117' : '#ffd54f', background: pathname === '/elite' ? 'linear-gradient(135deg, #ffd54f 0%, #f9a825 100%)' : undefined, fontWeight: 800 }}
              title="Institutional 3-leg service"
            >
              ★ Elite
            </Link>
            <Link
              to="/dashboard"
              className={pathname === '/dashboard' ? 'navlink active' : 'navlink'}
            >
              Dashboard
            </Link>
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
              to="/mma/scoreboard"
              className={sport === 'mma' ? 'navlink active sport-mma' : 'navlink'}
            >
              MMA
            </Link>
            <Link
              to="/wnba/compare"
              className={sport === 'wnba' ? 'navlink active sport-wnba' : 'navlink'}
            >
              WNBA
            </Link>
            <Link
              to="/news"
              className={pathname.startsWith('/news') ? 'navlink active' : 'navlink'}
            >
              News
            </Link>
            <Link
              to="/clv"
              className={pathname === '/clv' || pathname === '/calibration' || pathname === '/methodology' ? 'navlink active' : 'navlink'}
              title="Truth metric: CLV + Calibration + Methodology"
            >
              Truth
            </Link>
          </div>
        ) : (
          <div className="nav-links">
            <Link
              to="/dashboard"
              className={pathname === '/dashboard' ? 'navlink active' : 'navlink'}
            >
              Dashboard
            </Link>
            <Link
              to="/nba/compare"
              className={sport === 'nba' ? 'navlink active sport-nba' : 'navlink'}
            >
              NBA
            </Link>
            <Link
              to="/mma/scoreboard"
              className={sport === 'mma' ? 'navlink active sport-mma' : 'navlink'}
            >
              MMA
            </Link>
            <Link
              to="/news"
              className={pathname.startsWith('/news') ? 'navlink active' : 'navlink'}
            >
              News
            </Link>
            <Link
              to="/clv"
              className={pathname === '/clv' || pathname === '/calibration' || pathname === '/methodology' ? 'navlink active' : 'navlink'}
              title="Truth metric: CLV + Calibration + Methodology"
            >
              Truth
            </Link>
            <Link to="/pricing" className={pathname.startsWith('/pricing') ? 'navlink active' : 'navlink'}>
              Upgrade
            </Link>
          </div>
        )}

        <NavSearch />

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

      <MobileBottomNav />
    </>
  );
}
