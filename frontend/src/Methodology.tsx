// /methodology — public "How StatEdge works" explainer. Phase 119.
//
// Bloomberg-Terminal value prop = transparency. Every cell drills
// into its provenance. This page documents the 10-layer projection
// architecture so the institutional claim is fully audit-able. Not
// marketing copy — process documentation. The truth-metric receipts
// (CLV + Calibration + Durability) prove each claim.
//
// Static content, no API. Anyone can read it; institutional users
// can trust it because the math is published.

import { Link } from 'react-router-dom';
import { BeatRateTrend } from './BeatRateTrend';
import { EliteHeatmap } from './EliteHeatmap';
import { EngineStatus } from './EngineStatus';
import { NavBar } from './NavBar';
import { useTitle } from './useTitle';

export function Methodology() {
  useTitle(['How StatEdge Works', 'Methodology']);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell" style={{ maxWidth: 800 }}>
        <div style={{ marginBottom: 8 }}>
          <Link to="/" className="muted small">← Home</Link>
        </div>

        <div style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
        }}>
          STATEDGE METHODOLOGY
        </div>
        <h1 style={{ margin: '4px 0 16px', fontSize: 32 }}>How StatEdge works</h1>

        <p style={{ fontSize: 16, lineHeight: 1.6, color: 'rgba(255,255,255,0.85)' }}>
          StatEdge is quantitative sports intelligence — a Bloomberg Terminal for sports,
          not a picks site. We don't sell hot takes. We publish projections, the math
          behind them, and our track record on whether the numbers held up. Every claim
          on this site is auditable; every probability is graded against actual outcomes.
        </p>

        <p style={{ fontSize: 14, lineHeight: 1.6, color: 'rgba(255,255,255,0.75)' }}>
          The model is built around a 10-layer architecture. Each layer answers a
          different question, and a projection only ships after all ten have weighed in.
          That's why we don't claim hit rates — they're noise. We claim{' '}
          <Link to="/clv" style={{ color: '#7aa2ff' }}>closing line value</Link>,{' '}
          <Link to="/calibration" style={{ color: '#7aa2ff' }}>calibration</Link>, and edge
          durability instead, because those are what an honest model can be measured against.
        </p>

        <h2 style={{ marginTop: 32, fontSize: 22, fontWeight: 800, borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 8 }}>
          The 10-layer architecture
        </h2>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', marginBottom: 24 }}>
          Every projection flows through these layers in order. Skip one and the result is
          unreliable; running them out of order produces incoherent answers. The architecture
          is the same across MLB, NBA, WNBA, and UFC — only the inputs change per sport.
        </p>

        <Layer
          n={1}
          title="Baseline"
          q="What does the player normally do?"
        >
          A robust baseline blends seven windows: season, last-30 games, last-20, last-10,
          last-5, median, and trimmed mean. Each gets regressed toward stat-specific
          stabilization thresholds — strikeouts stabilize fast (around 60 PA), home runs
          stabilize slowly (300+ PA). No single hot streak distorts the anchor. We don't
          take "last 5 games" as gospel; we mathematically pull thin samples toward the
          population mean.
        </Layer>

        <Layer
          n={2}
          title="Opportunity"
          q="How much will the player play tonight?"
        >
          A great per-minute or per-PA rate means nothing if the player doesn't get the
          minutes. Layer 2 forecasts plate appearances (MLB), minutes (NBA/WNBA), or
          fight time (UFC) given starting status, recent role, blowout risk, and
          injury news. A starter pulled in the 6th inning of a 10-2 game caps your home
          run prop at zero plate appearances after that point. We model that.
        </Layer>

        <Layer
          n={3}
          title="Matchup"
          q="Who's the player going against?"
        >
          Opposing pitcher / defender / matchup quality. MLB hitters get pitcher-handedness
          splits, pitcher's specific pitch arsenal, and recent form. NBA scorers get
          defender DVPA + opposing team pace + on-ball/off-ball minutes against likely
          assignments. UFC fighters get opponent strike-defense, takedown defense, and
          recent finish patterns. Matchup is the layer where most public models stop;
          for us it's just the third pass.
        </Layer>

        <Layer
          n={4}
          title="Environment"
          q="What's the context the game happens in?"
        >
          Park factors (MLB), pace (NBA/WNBA), weather (MLB outdoor), altitude (Coors).
          Wind blowing in at Wrigley turns over-1.5 total bases into a coin flip;
          blowing out turns 2.5 into a value spot. We adjust before the projection
          ships. Environment is sport-specific by definition.
        </Layer>

        <Layer
          n={5}
          title="Variance / Trap"
          q="How fragile is this projection?"
        >
          Two projections at 75% probability can have wildly different failure profiles.
          A trap watch flags when (a) the line is suspiciously close to season average,
          (b) the player is on a recent streak driving public action, (c) recent volatility
          spikes the standard deviation, or (d) the matchup creates asymmetric downside.
          Fragility ≠ probability. We surface them as separate dimensions.
        </Layer>

        <Layer
          n={6}
          title="Distribution"
          q="What does the full outcome curve look like?"
        >
          The point estimate is just the median of a distribution. Layer 6 generates the
          full distribution — what's the 25th percentile? 75th? 95th? Tail risk lets us
          price extreme outcomes (5+ HR games, 50-point performances) honestly instead of
          treating "75% to go over 22.5" as a deterministic answer.
        </Layer>

        <Layer
          n={7}
          title="EV"
          q="Is this a +EV bet at the offered line?"
        >
          Probability × payout − (1 − probability) × stake. We compute expected value
          against the actual payout structure of the line, not against a generic 50/50.
          A 60% probability is +EV at -130 odds, neutral at -150, -EV at -180. Layer 7
          is where probability meets pricing.
        </Layer>

        <Layer
          n={8}
          title="Card Construction"
          q="Which legs go on tonight's card?"
        >
          Stricter than EV alone. We rank by edge magnitude, durability score, and trap
          flags — then cap the card size. Smaller cards beat forced volume; the Phase 100
          mission was explicit: "smaller cards over forced volume." Filling 10 slots with
          marginal edges is worse than 4 with sharp ones.
        </Layer>

        <Layer
          n={9}
          title="Calibration"
          q="When we say 70%, do players actually hit at 70%?"
        >
          Every published projection grades against the actual game result. Bucketed by
          predicted probability, we measure observed hit rate vs predicted. The gap is
          the calibration error — see the{' '}
          <Link to="/calibration" style={{ color: '#7aa2ff' }}>full calibration audit</Link>.
          Static models drift; adaptive ones survive. We re-fit periodically against
          the graded sample.
        </Layer>

        <Layer
          n={10}
          title="Confidence"
          q="How sure are we — and what's the sample size warning?"
        >
          The probability we ship to the UI gets one final pass: how thin is the sample?
          A "73%" projected from 4 prior games gets a thin-sample tag; a "73%" from a
          stable 80-game season is shipped without caveats. Bayesian smoothing pulls
          thin-sample projections toward the prior so we never overclaim confidence we
          don't have.
        </Layer>

        <h2 style={{ marginTop: 32, fontSize: 22, fontWeight: 800, borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 8 }}>
          Data sources
        </h2>
        <ul style={{ fontSize: 13, lineHeight: 1.7, color: 'rgba(255,255,255,0.85)' }}>
          <li><strong>MLB Stats API</strong> — schedules, boxscores, player metadata, season + last-N stats. Authoritative source, free, no auth.</li>
          <li><strong>ESPN site API</strong> — NBA + WNBA + UFC scoreboards, summaries, athlete bios. Public CDN, no auth required.</li>
          <li><strong>The Odds API</strong> — multi-book consensus odds (NBA, MLB, WNBA, UFC). 500-credit free tier with strict per-month budget guard.</li>
          <li><strong>PrizePicks</strong> — player prop board, ingested via admin paste of pipe-format slate (Cloudflare blocks server-side scraping; the user's residential IP is the only viable path).</li>
          <li><strong>YouTube Data API v3</strong> — highlight video search, restricted to a trusted-channel whitelist (NBA, MLB, UFC, ESPN, etc.).</li>
          <li><strong>Google News RSS</strong> — passthrough headlines on player pages. Cached 10 minutes; never stored.</li>
        </ul>
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', fontStyle: 'italic' }}>
          We don't scrape competitors. We don't rewrite other people's articles. Every
          piece of original analysis on this site comes from data we collect ourselves.
        </p>

        <h2 style={{ marginTop: 32, fontSize: 22, fontWeight: 800, borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 8 }}>
          The truth metric
        </h2>
        <p style={{ fontSize: 14, lineHeight: 1.6 }}>
          A model is only as good as its track record under independent measurement.
          We publish three pillars:
        </p>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
          margin: '12px 0',
        }}>
          <TruthCard
            title="CLV"
            sub="Process accuracy"
            href="/clv"
            blurb="Did our published projection beat the market's eventual closing line? Independent of game-outcome variance. ≥55% on volume = real edge."
          />
          <TruthCard
            title="Calibration"
            sub="Probability accuracy"
            href="/calibration"
            blurb="When we say 70% probability, do players actually hit at 70%? Tight gap (≤2pp) = honest model."
          />
          <TruthCard
            title="Durability"
            sub="Edge stability"
            href="/clv"
            blurb="How much does our line move after publish? Stable + Confirmed = market validated. Eroded = market disagreed."
          />
        </div>

        {/* 90-day Elite track-record heatmap. Third visual proof
            (alongside beat-rate trend + engine status) that we publish
            receipts. Self-hides until ≥3 graded days exist. */}
        <EliteHeatmap />

        {/* Beat-rate time series — proves the receipt is more than
            a snapshot. Self-hides until graded volume accumulates. */}
        <BeatRateTrend
          weeks={12}
          heading="Beat Rate · 12-Week Trend"
          blurb="The truth metric over time. If our process is real edge, the bars cluster above 50% (the dotted line) and ideally above 55% (the green dotted institutional bar). One bar per ISO week; gaps mean weeks with no graded props."
        />

        {/* Operational pulse — live counters showing the engine is
            actually running. Self-hides if the status endpoint
            returns nothing. */}
        <EngineStatus />

        <h2 style={{ marginTop: 32, fontSize: 22, fontWeight: 800, borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 8 }}>
          What's NOT here yet
        </h2>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6 }}>
          The mission's "no fake completeness" rule applies to this page too. Things that
          will land in subsequent phases:
        </p>
        <ul style={{ fontSize: 13, lineHeight: 1.6, color: 'rgba(255,255,255,0.75)' }}>
          <li>UFC projection engine — fighter-stat database in progress; current /mma/slate stores props but doesn't project them.</li>
          <li>NBA + UFC contributing to the cross-sport CLV/Calibration metric — projection_history needs graded volume to accumulate.</li>
          <li>Per-projection L1-L10 audit trail — clicking a projected probability to see exactly which layer contributed what is on the roadmap.</li>
          <li>Monte Carlo (Layer 6) — currently we ship distributional summaries; full Monte Carlo simulation lands when the projection-error distribution from grading stabilizes.</li>
          <li>ML feedback loop — calibration gap currently informs hand-tuned reweighting; automated gradient-based recalibration is queued.</li>
        </ul>

        <div style={{
          position: 'relative',
          marginTop: 32, padding: 18,
          background: `
            radial-gradient(ellipse 50% 80% at 0% 0%, rgba(102,187,106,0.10) 0%, transparent 60%),
            linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
            var(--surface-1)
          `,
          border: '1px solid rgba(102,187,106,0.30)',
          borderLeft: '3px solid #66bb6a',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-card)',
          fontSize: 13, lineHeight: 1.65,
          overflow: 'hidden',
        }}>
          <span aria-hidden style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(102,187,106,0.55), transparent)',
          }} />
          <div style={{
            fontSize: 10, fontWeight: 800, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: '#66bb6a', marginBottom: 8,
          }}>
            The mission line
          </div>
          <p style={{ margin: 0, color: 'rgba(255,255,255,0.85)' }}>
            Data over hype. EV over hit rate. Smaller cards over forced volume.
            We're not the loudest sports site; we're the most honest one. That's
            the promise, and the truth-metric pages are where we hold ourselves to it.
          </p>
        </div>
      </div>
    </div>
  );
}

function Layer({ n, title, q, children }: { n: number; title: string; q: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24, paddingLeft: 0 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.05em',
          color: 'rgba(255,255,255,0.55)',
          padding: '2px 8px',
          background: 'rgba(122,162,255,0.1)',
          border: '1px solid rgba(122,162,255,0.25)',
          borderRadius: 3,
          flexShrink: 0,
        }}>
          L{n}
        </span>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{title}</h3>
      </div>
      <p className="muted small" style={{ margin: '4px 0 8px', fontSize: 12, fontStyle: 'italic' }}>
        {q}
      </p>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: 'rgba(255,255,255,0.85)', margin: 0 }}>
        {children}
      </p>
    </section>
  );
}

function TruthCard({ title, sub, href, blurb }: { title: string; sub: string; href: string; blurb: string }) {
  return (
    <Link
      to={href}
      className="truth-card"
      style={{
        position: 'relative',
        display: 'block',
        padding: 16,
        background: `
          radial-gradient(ellipse 50% 80% at 0% 0%, rgba(122,162,255,0.06) 0%, transparent 60%),
          linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
          var(--surface-1)
        `,
        border: '1px solid rgba(122,162,255,0.20)',
        borderLeft: '3px solid #7aa2ff',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        textDecoration: 'none',
        color: 'inherit',
        overflow: 'hidden',
        transition: 'transform 200ms cubic-bezier(0.4,0,0.2,1), box-shadow 200ms, border-color 200ms',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(122,162,255,0.55), transparent)',
      }} />
      <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: '-0.2px' }}>{title}</div>
      <div className="muted small" style={{ fontSize: 11, fontWeight: 800, color: '#7aa2ff', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 4 }}>
        {sub}
      </div>
      <div className="muted small" style={{ fontSize: 12, lineHeight: 1.55, marginTop: 10, color: 'rgba(255,255,255,0.75)' }}>
        {blurb}
      </div>
      <div style={{ fontSize: 11, fontWeight: 800, color: '#7aa2ff', marginTop: 10, letterSpacing: '0.04em' }}>
        See the math →
      </div>
    </Link>
  );
}
