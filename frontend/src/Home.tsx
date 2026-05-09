import { Link } from 'react-router-dom';
import { ClvTrustBanner } from './ClvTrustBanner';
import { EnginePulseStrip } from './EnginePulseStrip';
import { HomeHero } from './HomeHero';
import { LatestNewsRail } from './LatestNewsRail';
import { LiveDeck } from './LiveDeck';
import { RecentGames } from './RecentGames';
import { RecentsRail } from './RecentsRail';
import { SlateTeaser } from './SlateTeaser';
import { TodayGames } from './TodayGames';
import { TopPerformers } from './TopPerformers';
import { TrendingPlayers } from './TrendingPlayers';
import { TrendingTeams } from './TrendingTeams';

export function Home() {
  return (
    <div className="home">
      <HomeHero />

      {/* Compact engine pulse — Bloomberg-feel ticker showing
          live activity. Self-hides until at least one engine
          source has data; click-through to /methodology for the
          full operational view. */}
      <EnginePulseStrip />

      {/* CLV truth metric — the institutional credential. Pinned high
          so the data-first promise is visible, not buried. Banner
          silently hides when no projection has graded yet. */}
      <ClvTrustBanner />

      {/* Live deck — only renders when at least one NBA or MLB game is
          actually in progress. Bloomberg-Terminal framing: when markets
          are live, that's what users see first. */}
      <LiveDeck />

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
              <li>2 comparisons / day</li>
              <li>Last 5 games only</li>
              <li>Basic stats</li>
              <li>No AI</li>
            </ul>
            <Link className="cta" to="/nba/compare">Try it free</Link>
          </div>
          <div className="plan featured">
            <h3>Pro</h3>
            <div className="price">$19<span>/mo</span></div>
            <ul>
              <li>Unlimited comparisons</li>
              <li>Last 10 + season</li>
              <li>AI summaries</li>
              <li>Save comparisons</li>
            </ul>
            <span className="cta primary disabled">Coming soon</span>
          </div>
          <div className="plan">
            <h3>Elite</h3>
            <div className="price">$49<span>/mo</span></div>
            <ul>
              <li>3–5 year history</li>
              <li>Advanced filters</li>
              <li>Export reports</li>
              <li>Alerts</li>
            </ul>
            <span className="cta disabled">Coming soon</span>
          </div>
        </div>
      </section>

      <footer className="footer">
        <p>
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
          <Link to="/mlb/standings" className="footer-link">MLB standings</Link>
          {' · '}
          <Link to="/mlb/slate" className="footer-link">MLB slate</Link>
          {' · '}
          <Link to="/mlb/slate/history" className="footer-link">MLB history</Link>
          {' · '}
          <Link to="/mlb/calibration" className="footer-link">MLB calibration</Link>
        </p>
        <p>Stats and analysis only. No odds, no gambling advice.</p>
      </footer>
    </div>
  );
}
