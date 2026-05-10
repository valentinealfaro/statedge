import { Link } from 'react-router-dom';
import { ActivityFeed } from './ActivityFeed';
import { ClvTrustBanner } from './ClvTrustBanner';
import { EnginePulseStrip } from './EnginePulseStrip';
import { HomeEliteTeaser } from './HomeEliteTeaser';
import { HomeHero } from './HomeHero';
import { LatestNewsRail } from './LatestNewsRail';
import { LiveDeck } from './LiveDeck';
import { RecentGames } from './RecentGames';
import { RecentsRail } from './RecentsRail';
import { SlateTeaser } from './SlateTeaser';
import { TodayAtAGlance } from './TodayAtAGlance';
import { TodayGames } from './TodayGames';
import { TopPerformers } from './TopPerformers';
import { TrendingPlayers } from './TrendingPlayers';
import { TrendingTeams } from './TrendingTeams';

export function Home() {
  return (
    <div className="home">
      <HomeHero />

      {/* Today at a glance — Bloomberg ticker pinned high so the
          institutional user sees today's market state in 4 numbers
          before scrolling. Live games + active edges + Elite verdict
          + 30d CLV beat-rate. Self-hides on quiet days. */}
      <TodayAtAGlance />

      {/* Compact engine pulse — Bloomberg-feel ticker showing
          live activity. Self-hides until at least one engine
          source has data; click-through to /methodology for the
          full operational view. */}
      <EnginePulseStrip />

      {/* Today's Elite play — cross-sport ticket teaser. The
          institutional-grade card front-and-center on Home so
          users see the headline pick before scrolling for context. */}
      <HomeEliteTeaser />

      {/* CLV truth metric — the institutional credential. Pinned high
          so the data-first promise is visible, not buried. Banner
          silently hides when no projection has graded yet. */}
      <ClvTrustBanner />

      {/* Live deck — only renders when at least one NBA or MLB game is
          actually in progress. Bloomberg-Terminal framing: when markets
          are live, that's what users see first. */}
      <LiveDeck />

      {/* Activity feed — every Elite leg + starred prop that has
          settled or locked today, in one chronological view. Bloomberg
          'what just happened to my picks' ticker. Self-hides until at
          least one event has resolved. */}
      <ActivityFeed />

      <section className="home-recents">
        <RecentsRail heading="Pick up where you left off" />
      </section>

      <LatestNewsRail limit={4} />

      <TodayGames />
      <SlateTeaser />
      <RecentGames />
      <TopPerformers />
      <TrendingPlayers />
      <TrendingTeams />

      <section className="features">
        <h2>The institutional engine</h2>
        <div className="grid">
          <div className="feature">
            <h3>Robust baseline (L1)</h3>
            <p>
              Every projection blends 7 windows — season, L30, L20, L10, L5, median, trimmed
              mean — then regresses toward stat-specific stabilization thresholds. No single
              hot streak distorts the anchor.
            </p>
          </div>
          <div className="feature">
            <h3>Fragility ≠ probability (L5)</h3>
            <p>
              A 75% probability HR prop and a 75% probability hits-1.5 prop look identical on
              the dial — but the failure modes are wildly different. We surface fragility as
              its own dimension so you see what could go wrong.
            </p>
          </div>
          <div className="feature">
            <h3>Self-correcting calibration (L9 → L6)</h3>
            <p>
              Every graded slate teaches the model where it lies. Predicted-vs-observed buckets
              feed back into tomorrow's probabilities. Static models die; adaptive ones survive.
            </p>
          </div>
        </div>
      </section>

      <section className="pricing">
        <h2>Simple plans</h2>
        <div className="grid">
          <div className="plan">
            <h3>Free</h3>
            <div className="price">$0</div>
            <ul>
              <li>Daily comparisons (NBA / MLB / UFC)</li>
              <li>Last-10 game logs</li>
              <li>Hit probability vs any line</li>
              <li>Daily limit on comparisons</li>
            </ul>
            <Link className="cta" to="/nba/compare">Try Compare free</Link>
          </div>
          <div className="plan featured">
            <h3>Pro</h3>
            <div className="price">$19.99<span>/mo</span></div>
            <ul>
              <li>Tonight's full prop slate (NBA + MLB + UFC)</li>
              <li>Pre-built parlays + 6-leg builder</li>
              <li>Live line override</li>
              <li>AI &quot;why?&quot; on every prop</li>
              <li>Saved parlays + favorites</li>
            </ul>
            <Link className="cta primary" to="/pricing">Get Pro →</Link>
          </div>
        </div>
      </section>

      <footer className="footer">
        <p>
          <Link to="/best-bets" className="footer-link">Best Bets</Link>
          {' · '}
          <Link to="/elite" className="footer-link">★ Elite</Link>
          {' · '}
          <Link to="/dashboard" className="footer-link">Command Center</Link>
          {' · '}
          <Link to="/methodology" className="footer-link">How StatEdge works</Link>
          {' · '}
          <Link to="/clv" className="footer-link">CLV report</Link>
          {' · '}
          <Link to="/calibration" className="footer-link">Calibration</Link>
          {' · '}
          <Link to="/news" className="footer-link">News</Link>
        </p>
        <p>
          <Link to="/nba/standings" className="footer-link">NBA standings</Link>
          {' · '}
          <Link to="/nba/slate" className="footer-link">NBA slate</Link>
          {' · '}
          <Link to="/mlb/standings" className="footer-link">MLB standings</Link>
          {' · '}
          <Link to="/mlb/slate" className="footer-link">MLB slate</Link>
          {' · '}
          <Link to="/mlb/slate/history" className="footer-link">MLB history</Link>
          {' · '}
          <Link to="/mlb/calibration" className="footer-link">MLB calibration</Link>
          {' · '}
          <Link to="/mma/scoreboard" className="footer-link">UFC scoreboard</Link>
          {' · '}
          <Link to="/mma/slate" className="footer-link">UFC slate</Link>
        </p>
        <p>Stats and analysis only. No odds, no gambling advice.</p>
      </footer>
    </div>
  );
}
