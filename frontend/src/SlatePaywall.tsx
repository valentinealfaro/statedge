import { Link } from 'react-router-dom';

// Marketing preview shown to free / signed-out users on /slate.
// Lists the features they'd unlock with Pro and points them at the
// pricing page. The actual /slate experience stays accessible to
// admin emails and Pro accounts.
export function SlatePaywall() {
  return (
    <div className="slate-paywall">
      <div className="slate-paywall-hero">
        <span className="slate-paywall-tag">PRO FEATURE</span>
        <h1>Tonight's prop board, with the model on every line.</h1>
        <p className="slate-paywall-sub">
          Slate is StatEdge's flagship view — every prop on every player on
          tonight's NBA slate, scored by a layered probabilistic engine that
          blends recent form, matchup history, and over a dozen context
          factors. Build a 6-leg parlay in seconds and see the combined hit
          probability before you lock it in.
        </p>
        <div className="slate-paywall-ctas">
          <Link to="/pricing" className="cta primary">See pricing →</Link>
          <Link to="/compare" className="cta">Try Compare (free)</Link>
        </div>
      </div>

      <div className="slate-paywall-features">
        <FeatureCard
          icon="📊"
          title="Tonight's full prop board"
          body="Every player's every line — points, rebounds, assists, PRA, threes, even foul lines — with the model's hit probability stamped on each one."
        />
        <FeatureCard
          icon="✨"
          title="Pre-built parlays"
          body="Best 2 / 3 / 4 / 5 / 6 combos auto-built from the slate's strongest plays. Plus a Wild Card longshot for high-payout parlays."
        />
        <FeatureCard
          icon="🎯"
          title="Live line override"
          body="Sportsbooks move lines through the day. Type the new line — we recompute probability instantly against the player's last 10 games."
        />
        <FeatureCard
          icon="⭐"
          title="Favorites + saved parlays"
          body="Star the players you bet on every night. They surface at the top of the board. Save your parlays to history for later review."
        />
        <FeatureCard
          icon="🤖"
          title="AI insight on demand"
          body="Click 'Why?' on any prop and Gemini explains the model's lean in plain English — what factors drove it, what risks could derail it."
        />
        <FeatureCard
          icon="📈"
          title="Layered projection engine"
          body="Five-layer model: baselines per window, eight context multipliers, std-dev probability, confidence + risk scores, conservative lean rules. Says 'No Clear Edge' when the data is weak."
        />
      </div>

      <div className="slate-paywall-foot">
        <Link to="/pricing" className="cta primary">Unlock Slate — see plans</Link>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="slate-paywall-feature">
      <div className="slate-paywall-feature-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
