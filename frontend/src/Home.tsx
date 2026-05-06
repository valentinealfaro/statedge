import { Link } from 'react-router-dom';
import { RecentGames } from './RecentGames';
import { RecentsRail } from './RecentsRail';
import { TodayGames } from './TodayGames';
import { TopPerformers } from './TopPerformers';
import { TrendingPlayers } from './TrendingPlayers';
import { TrendingTeams } from './TrendingTeams';

export function Home() {
  return (
    <div className="home">
      <header className="hero">
        <h1>StatEdge</h1>
        <p className="hero-tag">
          The sports stats comparison engine. <br />
          Player vs Team. Player vs Player. Team vs Team.
        </p>
        <Link className="cta primary" to="/compare">
          Start comparing →
        </Link>
        <p className="disclaimer">
          We provide statistics and analysis only. No betting advice.
        </p>
      </header>

      <section className="home-recents">
        <RecentsRail heading="Pick up where you left off" />
      </section>

      <TodayGames />
      <RecentGames />
      <TopPerformers />
      <TrendingPlayers />
      <TrendingTeams />

      <section className="features">
        <h2>Built for fans who want the real story</h2>
        <div className="grid">
          <div className="feature">
            <h3>Trend & consistency</h3>
            <p>
              See if a player is trending up, trending down, or stable — and how consistent their
              numbers are vs. their season average.
            </p>
          </div>
          <div className="feature">
            <h3>Last 5 to last season</h3>
            <p>
              Toggle between last 5, last 10, last 20, and the full season. Spot streaks and
              slumps fast.
            </p>
          </div>
          <div className="feature">
            <h3>AI insights (Pro)</h3>
            <p>
              An AI sports analyst breaks down each matchup into trends, breakdowns, and risks —
              never betting picks.
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
            <Link className="cta" to="/compare">Try it free</Link>
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
          <Link to="/standings" className="footer-link">League standings</Link>
        </p>
        <p>Stats and analysis only. No odds, no gambling advice.</p>
      </footer>
    </div>
  );
}
