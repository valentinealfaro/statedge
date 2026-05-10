import { Link, useLocation } from 'react-router-dom';
import { MobileBottomNav } from './MobileBottomNav';
import { NavSearch } from './NavSearch';
import { usePlan } from './plan';
import { useEliteLiveTally } from './useEliteLiveTally';
import { useLiveGameCounts } from './useLiveGameCounts';
import { useStarredLiveTally } from './useStarredLiveTally';
import { UserMenu } from './UserMenu';

// Sport-grouped navigation per the UX spec ("institutional sports
// intelligence operating system, not a collection of pages").
//
// Top nav (Pro): ★ Elite · Dashboard · Best Bets · ★ Starred · NBA ·
//   MLB · MMA. Each sport tab pulses red while at least one game in
//   that sport is live; Best Bets pulses on any sport live; ★ Elite
//   shows a HIT/MISS check + 'in flight' pulse for today's ticket.
//
// Subnav (per sport):
//   - NBA / MLB / WNBA: Compare · Slate · History · Standings · Calibration
//   - MMA: Scoreboard · Slate (richer subnav lands when a UFC
//     projection engine + standings/calibration story exists).
//
// Items appear here only when their pages actually exist — adding
// placeholder links would violate the mission's no-fake-completeness
// rule. Still deferred:
//   - Research Lab (prop / line / matchup explorers — roadmap).
//   - UFC standings / calibration (waiting on the projection engine).
//   - WNBA enrichment is deprio'd per the 2026-05-09 sport-priorities
//     decision; existing WNBA subnav stays as-is, no new features.

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

// WNBA subnav — Phases 74-78 shipped. Full surface area matches NBA
// + MLB. Per the 2026-05-09 sport-priorities decision, WNBA is on
// maintenance only — existing surfaces stay live but no new features
// are scoped (MMA replaced WNBA as the third focus sport).
const WNBA_SUBNAV: SubnavItem[] = [
  { label: 'Compare', path: '/wnba/compare' },
  { label: 'Slate', path: '/wnba/slate' },
  { label: 'History', path: '/wnba/slate/history' },
  { label: 'Standings', path: '/wnba/standings' },
  { label: 'Calibration', path: '/wnba/calibration' },
];

// MMA subnav — Phase 107 foundation + Phase 110a slate + Phase 146
// fight detail + Phase 148p live-grading wiring. Scoreboard / slate
// is the institutional surface today; standings + calibration land
// when the UFC projection engine ships.
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
  const liveCounts = useLiveGameCounts();
  const starredTally = useStarredLiveTally();
  const eliteTally = useEliteLiveTally();

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
              className={`${pathname === '/elite' ? 'navlink active' : 'navlink'}${eliteTally.inFlight > 0 ? ' has-live' : ''}`}
              style={{ color: pathname === '/elite' ? '#0d1117' : '#ffd54f', background: pathname === '/elite' ? 'linear-gradient(135deg, #ffd54f 0%, #f9a825 100%)' : undefined, fontWeight: 800 }}
              title={
                eliteTally.ticketVerdict === 'HIT' ? 'Today\'s Elite ticket: ✓ HIT'
                : eliteTally.ticketVerdict === 'MISS' ? 'Today\'s Elite ticket: ✗ MISS'
                : eliteTally.inFlight > 0 ? `Today\'s Elite ticket: ${eliteTally.inFlight} ${eliteTally.inFlight === 1 ? 'leg' : 'legs'} in flight`
                : 'Institutional 3-leg service'
              }
            >
              ★ Elite
              {eliteTally.ticketVerdict === 'HIT' && (
                <span style={{ marginLeft: 4, color: '#66bb6a', fontSize: 11, fontWeight: 800 }}>✓</span>
              )}
              {eliteTally.ticketVerdict === 'MISS' && (
                <span style={{ marginLeft: 4, color: '#ef5350', fontSize: 11, fontWeight: 800 }}>✗</span>
              )}
            </Link>
            <Link
              to="/dashboard"
              className={pathname === '/dashboard' ? 'navlink active' : 'navlink'}
            >
              Dashboard
            </Link>
            <Link
              to="/best-bets"
              className={`${pathname === '/best-bets' ? 'navlink active' : 'navlink'}${(liveCounts.nba + liveCounts.mlb + liveCounts.ufc) > 0 ? ' has-live' : ''}`}
              title={(liveCounts.nba + liveCounts.mlb + liveCounts.ufc) > 0
                ? 'Cross-sport unified watchlist — games live now, edges in flight'
                : 'Cross-sport unified watchlist — every edge ranked by EV'}
            >
              Best Bets
            </Link>
            <StarredNavLink
              active={pathname === '/starred'}
              total={starredTally.total}
              live={starredTally.liveInFlight}
              hit={starredTally.hit}
              miss={starredTally.miss}
            />
            <Link
              to="/nba/compare"
              className={`${sport === 'nba' ? 'navlink active sport-nba' : 'navlink'}${liveCounts.nba > 0 ? ' has-live' : ''}`}
              title={liveCounts.nba > 0 ? `${liveCounts.nba} NBA ${liveCounts.nba === 1 ? 'game' : 'games'} live` : undefined}
            >
              NBA
            </Link>
            <Link
              to="/mlb/compare"
              className={`${sport === 'mlb' ? 'navlink active sport-mlb' : 'navlink'}${liveCounts.mlb > 0 ? ' has-live' : ''}`}
              title={liveCounts.mlb > 0 ? `${liveCounts.mlb} MLB ${liveCounts.mlb === 1 ? 'game' : 'games'} live` : undefined}
            >
              MLB
            </Link>
            <Link
              to="/mma/scoreboard"
              className={`${sport === 'mma' ? 'navlink active sport-mma' : 'navlink'}${liveCounts.ufc > 0 ? ' has-live' : ''}`}
              title={liveCounts.ufc > 0 ? `${liveCounts.ufc} UFC ${liveCounts.ufc === 1 ? 'fight' : 'fights'} live` : undefined}
            >
              UFC
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
              to="/best-bets"
              className={`${pathname === '/best-bets' ? 'navlink active' : 'navlink'}${(liveCounts.nba + liveCounts.mlb + liveCounts.ufc) > 0 ? ' has-live' : ''}`}
              title={(liveCounts.nba + liveCounts.mlb + liveCounts.ufc) > 0
                ? 'Cross-sport unified watchlist — games live now, edges in flight'
                : 'Cross-sport unified watchlist — every edge ranked by EV'}
            >
              Best Bets
            </Link>
            <StarredNavLink
              active={pathname === '/starred'}
              total={starredTally.total}
              live={starredTally.liveInFlight}
              hit={starredTally.hit}
              miss={starredTally.miss}
            />
            <Link
              to="/nba/compare"
              className={`${sport === 'nba' ? 'navlink active sport-nba' : 'navlink'}${liveCounts.nba > 0 ? ' has-live' : ''}`}
              title={liveCounts.nba > 0 ? `${liveCounts.nba} NBA ${liveCounts.nba === 1 ? 'game' : 'games'} live` : undefined}
            >
              NBA
            </Link>
            <Link
              to="/mma/scoreboard"
              className={`${sport === 'mma' ? 'navlink active sport-mma' : 'navlink'}${liveCounts.ufc > 0 ? ' has-live' : ''}`}
              title={liveCounts.ufc > 0 ? `${liveCounts.ufc} UFC ${liveCounts.ufc === 1 ? 'fight' : 'fights'} live` : undefined}
            >
              UFC
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
        <nav className={`subnav subnav-${sport}`} aria-label={`${sport === 'mma' ? 'UFC' : sport.toUpperCase()} sections`}>
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

// ★ NavBar entry with a live-tally badge. Shows the total count of
// starred props when the user has any; renders a small red pulse dot
// when at least one is currently in-flight, switching to a gold dot
// when something has hit (no in-flight), or red when something has
// missed and nothing is live anymore. Self-hides the badge entirely
// when the user has zero starred props (just shows ★).
function StarredNavLink({
  active,
  total,
  live,
  hit,
  miss,
}: {
  active: boolean;
  total: number;
  live: number;
  hit: number;
  miss: number;
}) {
  const dot =
    live > 0 ? '#ef5350'
    : hit > 0 ? '#66bb6a'
    : miss > 0 ? '#ef5350'
    : null;
  const tooltip =
    total === 0
      ? 'Your starred-props watchlist'
      : `★ ${total} starred · ${hit} hit · ${live} in flight · ${miss} miss`;

  return (
    <Link
      to="/starred"
      className={active ? 'navlink active' : 'navlink'}
      title={tooltip}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <span>★</span>
      {total > 0 && (
        <span style={{
          fontSize: 11, fontWeight: 800,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontVariantNumeric: 'tabular-nums',
          color: 'rgba(255,255,255,0.65)',
        }}>
          {total}
        </span>
      )}
      {dot && (
        <span
          className="live-pulse"
          style={{
            display: 'inline-block',
            width: 5,
            height: 5,
            borderRadius: 2.5,
            background: dot,
          }}
        />
      )}
    </Link>
  );
}
