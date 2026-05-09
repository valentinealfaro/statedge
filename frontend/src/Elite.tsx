// /elite — StatEdge Elite institutional 3-leg service. Phase 131.
//
// Per the Elite product spec: low-volume, high-conviction. The page
// shows ONE ticket OR an honest "no qualifying edge today" message.
// We never force a ticket — that's a feature, not a bug. Discipline
// builds trust.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getCrossSportEliteToday,
  getMlbEliteToday,
  getNbaEliteToday,
  type CrossSportEliteResponse,
  type CrossSportEliteTicket,
  type EliteEdgeReason,
  type EliteLeg,
  type EliteResponse,
  type EliteTicket,
} from './api';
import { MlbPlayerAvatar, PlayerAvatar, UfcFighterAvatar } from './Avatar';
import { NavBar } from './NavBar';
import { PastElitePlays } from './PastElitePlays';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

// Stat-key sets for sport detection — same logic the backend uses to
// route legs through the right normalizer. Mirrors collectSports() in
// crossSportEliteBuilder.ts.
const MLB_STAT_KEYS = new Set([
  'home_runs', 'total_bases', 'rbis', 'runs', 'hits', 'hits_runs_rbis',
  'walks', 'stolen_bases', 'strikeouts', 'doubles', 'triples', 'ks',
  'pitcher_outs', 'innings_pitched', 'earned_runs_allowed',
  'hits_allowed', 'walks_allowed', 'home_runs_allowed',
]);
const MMA_STAT_KEYS = new Set([
  'sig_strikes', 'rd1_sig_strikes', 'takedowns', 'rd1_takedowns',
  'knockdowns', 'rounds', 'fight_time', 'fantasy_score', 'control_time',
]);

function detectLegSport(leg: EliteLeg): 'mlb' | 'nba' | 'mma' {
  if (MMA_STAT_KEYS.has(leg.statKey)) return 'mma';
  if (MLB_STAT_KEYS.has(leg.statKey)) return 'mlb';
  return 'nba';
}

// Render the right avatar component for the leg's sport. UFC legs
// carry espnAthleteId (resolved from the scoreboard by fighter-name
// match in the cross-sport endpoint); when missing, the fighter
// gracefully falls back to initials.
function LegAvatar({ leg }: { leg: EliteLeg }) {
  const sport = detectLegSport(leg);
  if (sport === 'mlb') {
    return <MlbPlayerAvatar playerId={leg.playerId} name={leg.playerName} size="md" />;
  }
  if (sport === 'mma') {
    return <UfcFighterAvatar athleteId={leg.espnAthleteId ?? ''} name={leg.playerName} size="md" />;
  }
  return <PlayerAvatar playerId={leg.playerId} name={leg.playerName} size="md" />;
}

type EliteView = 'cross' | 'mlb' | 'nba';

const SPORT_COLOR: Record<'mlb' | 'nba', string> = {
  mlb: '#66bb6a',
  nba: '#7aa2ff',
};

const EDGE_LABEL: Record<EliteEdgeReason, string> = {
  market_disagreement:    'Market Disagreement',
  model_disagreement:     'Model Disagreement',
  clv_opportunity:        'CLV Opportunity',
  role_expansion:         'Role Expansion',
  public_overreaction:    'Public Overreaction',
  matchup_asymmetry:      'Matchup Asymmetry',
  historical_archetype:   'Historical Archetype',
};

const STAT_LABEL: Record<string, string> = {
  hits: 'Hits',
  total_bases: 'Total Bases',
  hits_runs_rbis: 'H+R+RBI',
  rbis: 'RBIs',
  runs: 'Runs',
  home_runs: 'Home Runs',
  strikeouts: 'Strikeouts',
  stolen_bases: 'Stolen Bases',
  walks: 'Walks',
  ks: 'Pitcher Ks',
  earned_runs_allowed: 'Earned Runs',
  hits_allowed: 'Hits Allowed',
  walks_allowed: 'Walks Allowed',
  innings_pitched: 'Innings Pitched',
  pitcher_outs: 'Pitcher Outs',
};

export function Elite() {
  useTitle(['Elite', '3-Leg Service']);
  const [view, setView] = useState<EliteView>('cross');
  const [data, setData] = useState<EliteResponse | CrossSportEliteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    const fetcher = view === 'cross'
      ? getCrossSportEliteToday
      : view === 'nba'
        ? getNbaEliteToday
        : getMlbEliteToday;
    fetcher()
      .then((r) => setData(r))
      .catch((e: Error) => setError(e.message));
  }, [view]);

  // CrossSportTicket extends EliteTicket with tierName + sportsCovered.
  // The render path treats them uniformly; tier-specific labeling is
  // additive and only shown when present.
  const ticket = data?.ticket ?? null;
  const candidatesScanned = data && 'candidatesScanned' in data
    ? typeof data.candidatesScanned === 'object'
      ? data.candidatesScanned.total
      : data.candidatesScanned ?? 0
    : 0;

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell" style={{ maxWidth: 820 }}>
        <header style={{ marginBottom: 18 }}>
          <div style={{
            fontSize: 11, fontWeight: 800, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: '#ffd54f',
          }}>
            STATEDGE ELITE
          </div>
          <h1 style={{ margin: '4px 0 8px', fontSize: 28 }}>Institutional 3-Leg Service</h1>
          <p className="muted small" style={{ margin: 0, fontSize: 13, lineHeight: 1.6, maxWidth: 720 }}>
            Cross-sport ticket combining the day's strongest legs from MLB and NBA into
            ONE play. Target: 3-leg at 6× payout, full institutional filter. Fallbacks:
            2-leg at 3×, then progressively-relaxed tiers — there's always a play.
            The grade and tier label tell you which tier produced the ticket so you
            can size accordingly. MMA joins when its projection engine ships.
          </p>
        </header>

        {/* View selector — Cross-Sport is the default and primary view;
            sport-specific tabs are still available for users who want
            to drill into one league. */}
        <div role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          <ViewTab active={view === 'cross'} onClick={() => setView('cross')} accent="#ffd54f">
            ★ Cross-Sport
          </ViewTab>
          <ViewTab active={view === 'mlb'} onClick={() => setView('mlb')} accent={SPORT_COLOR.mlb}>
            MLB only
          </ViewTab>
          <ViewTab active={view === 'nba'} onClick={() => setView('nba')} accent={SPORT_COLOR.nba}>
            NBA only
          </ViewTab>
        </div>

        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        {!data && !error && (
          <div style={{
            padding: '32px 20px',
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid rgba(255,213,79,0.18)',
            borderRadius: 8,
            textAlign: 'center',
          }}>
            <div style={{
              fontSize: 11, fontWeight: 800, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: 'rgba(255,213,79,0.85)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}>
              <span style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: 4,
                background: '#ffd54f',
                animation: 'pulse 1.4s ease-in-out infinite',
              }} />
              Computing today's institutional ticket
            </div>
            <p className="muted small" style={{ marginTop: 10, marginBottom: 0, fontSize: 12, lineHeight: 1.5, maxWidth: 480, marginLeft: 'auto', marginRight: 'auto' }}>
              {view === 'cross'
                ? 'Resolving NBA + MLB slates, projecting every leg, scoring every cross-sport combination through the tier ladder. Cross-sport pulls both slates in parallel — first load can take 15–25s on a cold backend.'
                : 'Resolving today\'s slate, projecting every leg, scoring combinations against the institutional filter. First load can take 10–20s on a cold backend.'}
            </p>
            <Skeleton width="100%" height={140} style={{ marginTop: 16 }} />
            <style>{`@keyframes pulse { 0%,100% { opacity: 1; transform: scale(1) } 50% { opacity: 0.4; transform: scale(0.85) } }`}</style>
          </div>
        )}

        {data && ticket && <TicketCard ticket={ticket} date={'date' in data ? data.date : undefined} />}
        {data && !ticket && (
          <NoTicketCard reason={data.reason ?? 'no qualifying edge today'} candidates={candidatesScanned} />
        )}

        {/* Track record — every prior Elite play the engine has
            published. Self-hides if no historical articles exist. */}
        <PastElitePlays />

        <section style={{
          marginTop: 28, padding: 16,
          background: 'rgba(255,213,79,0.04)',
          border: '1px solid rgba(255,213,79,0.2)',
          borderRadius: 8,
        }}>
          <h3 style={{ margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#ffd54f' }}>
            What Elite is — and isn't
          </h3>
          <p className="muted small" style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.6 }}>
            Elite is NOT a daily slate, NOT safest-picks, NOT volume betting. Each ticket
            must clear: different players, different games, no correlated stat-family
            stack, every leg ≥60% probability, ≥8pp edge, trap score ≤35, fragility ≤45,
            and at least one mandatory edge category (market disagreement, model
            disagreement, CLV opportunity, role expansion, public overreaction, matchup
            asymmetry, or historical archetype).
          </p>
          <p className="muted small" style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.6 }}>
            <strong>Tiers:</strong> 3-leg @ ≥6× combined fair payout (target).
            2-leg @ ≥3× (fallback when no 3-leg combination qualifies).
          </p>
          <p className="muted small" style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.6 }}>
            <Link to="/methodology" style={{ color: '#7aa2ff' }}>Read the methodology</Link>
            {' · '}
            <Link to="/clv" style={{ color: '#7aa2ff' }}>Check our truth-metric receipts</Link>
          </p>
        </section>
      </div>
    </div>
  );
}

function ViewTab({ active, onClick, children, accent }: { active: boolean; onClick: () => void; children: React.ReactNode; accent: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: '6px 14px',
        borderRadius: 4,
        border: `1px solid ${active ? accent : 'rgba(255,255,255,0.12)'}`,
        background: active ? `${accent}1a` : 'transparent',
        color: active ? accent : 'rgba(255,255,255,0.65)',
        fontWeight: 800,
        fontSize: 11,
        letterSpacing: '0.06em',
        cursor: 'pointer',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </button>
  );
}

function TicketCard({ ticket, date }: { ticket: EliteTicket | CrossSportEliteTicket; date?: string }) {
  const gradeColor = ticket.grade === 'A+' ? '#66bb6a' : ticket.grade === 'A' ? '#7aa2ff' : '#ffd54f';
  return (
    <section style={{
      padding: 20,
      background: 'linear-gradient(135deg, rgba(255,213,79,0.06) 0%, rgba(102,187,106,0.04) 100%)',
      border: `2px solid ${gradeColor}55`,
      borderRadius: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>Today's Elite Ticket {date ? `· ${date}` : ''}</span>
            <span style={{
              padding: '2px 7px',
              fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
              color: ticket.tier === '3-leg' ? '#ffd54f' : '#7aa2ff',
              background: ticket.tier === '3-leg' ? 'rgba(255,213,79,0.12)' : 'rgba(122,162,255,0.12)',
              border: `1px solid ${ticket.tier === '3-leg' ? 'rgba(255,213,79,0.4)' : 'rgba(122,162,255,0.4)'}`,
              borderRadius: 3,
            }}>
              {ticket.tier === '3-leg' ? '3-LEG' : '2-LEG · FALLBACK'}
            </span>
            {'sportsCovered' in ticket && ticket.sportsCovered.length > 1 && (
              <span style={{
                padding: '2px 7px',
                fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
                color: '#66bb6a',
                background: 'rgba(102,187,106,0.12)',
                border: '1px solid rgba(102,187,106,0.4)',
                borderRadius: 3,
              }}>
                CROSS-SPORT · {ticket.sportsCovered.map((s) => s.toUpperCase()).join(' + ')}
              </span>
            )}
            {'tierName' in ticket && ticket.tierName && (
              <span style={{
                padding: '2px 7px',
                fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
                color: 'rgba(255,255,255,0.6)',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 3,
              }}>
                {ticket.tierName}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginTop: 6 }}>
            <span style={{ fontSize: 42, fontWeight: 900, color: gradeColor, lineHeight: 1 }}>
              {ticket.grade}
            </span>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>
                {ticket.combinedFairPayout.toFixed(1)}× <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.55)' }}>fair payout</span>
              </div>
              <div className="muted small" style={{ fontSize: 11, marginTop: 4 }}>
                {ticket.combinedProbability.toFixed(1)}% combined hit · {ticket.combinedEdgePercent.toFixed(1)}pp avg edge · dislocation {ticket.dislocationScore.toFixed(1)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Legs */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ticket.legs.map((leg, i) => <LegCard key={`${leg.playerId}-${leg.statKey}`} leg={leg} index={i} />)}
      </div>

      {/* Why this ticket */}
      <div style={{ marginTop: 16, padding: 12, background: 'rgba(0,0,0,0.25)', borderRadius: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', marginBottom: 6 }}>
          Why this ticket
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6, color: 'rgba(255,255,255,0.85)' }}>
          {ticket.rationale.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      </div>
    </section>
  );
}

function LegCard({ leg, index }: { leg: EliteLeg; index: number }) {
  const dirColor = leg.direction === 'OVER' ? '#66bb6a' : '#ef5350';
  const sport = detectLegSport(leg);
  const sportColor = sport === 'mlb' ? '#66bb6a' : sport === 'mma' ? '#ef5350' : '#7aa2ff';

  // Click-through to the right player/fighter profile per sport.
  // NBA + MLB use numeric playerId; UFC uses ESPN athlete id.
  const profileLink = sport === 'mlb' ? `/mlb/player/${leg.playerId}`
    : sport === 'nba' ? `/nba/player/${leg.playerId}`
    : sport === 'mma' && leg.espnAthleteId ? `/mma/fighter/${leg.espnAthleteId}`
    : null;

  const Wrapper = profileLink
    ? ({ children }: { children: React.ReactNode }) => (
        <Link to={profileLink} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
          {children}
        </Link>
      )
    : ({ children }: { children: React.ReactNode }) => <>{children}</>;

  return (
    <Wrapper>
    <div style={{
      padding: 12,
      background: 'rgba(0,0,0,0.25)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderLeft: `3px solid ${dirColor}`,
      borderRadius: 6,
      cursor: profileLink ? 'pointer' : 'default',
      transition: 'background 120ms, border-color 120ms',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flexShrink: 0 }}>
          <LegAvatar leg={leg} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
            <div>
              <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', color: 'rgba(255,255,255,0.5)', marginRight: 6 }}>
                LEG {index + 1}
              </span>
              <span style={{
                fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
                color: sportColor, marginRight: 6,
              }}>
                {sport.toUpperCase()}
              </span>
              <span style={{ fontSize: 14, fontWeight: 800 }}>
                {leg.playerName}
              </span>
              {leg.team && <span className="muted small" style={{ fontSize: 11, marginLeft: 6 }}>{leg.team}</span>}
            </div>
            <span style={{
              fontSize: 13, fontWeight: 800,
              color: dirColor,
            }}>
              {leg.direction === 'OVER' ? '↑ OVER' : '↓ UNDER'} {leg.line}
            </span>
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>
            {STAT_LABEL[leg.statKey] ?? leg.statLabel}
          </div>
          <div className="muted small" style={{ fontSize: 11, marginTop: 6, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span><strong style={{ color: '#fff' }}>{leg.probability.toFixed(1)}%</strong> model</span>
            {leg.marketImpliedProb !== null && (
              <span>{Math.round(leg.marketImpliedProb)}% market</span>
            )}
            <span><strong style={{ color: '#66bb6a' }}>+{leg.edgePercent.toFixed(1)}pp</strong> edge</span>
            <span>trap {leg.trapScore} · fragility {leg.fragilityScore}</span>
            {leg.edgeDurability && (
              <span>durability <strong style={{ color: leg.edgeDurability === 'stable' ? '#66bb6a' : leg.edgeDurability === 'mixed' ? '#ffd54f' : '#ef5350' }}>{leg.edgeDurability}</strong></span>
            )}
          </div>
          <div style={{
            marginTop: 8, display: 'inline-block',
            fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
            padding: '2px 8px',
            background: 'rgba(122,162,255,0.1)',
            border: '1px solid rgba(122,162,255,0.3)',
            borderRadius: 3,
            color: '#7aa2ff',
            textTransform: 'uppercase',
          }}>
            {EDGE_LABEL[leg.qualifyingEdge]}
          </div>
        </div>
      </div>
    </div>
    </Wrapper>
  );
}

function NoTicketCard({ reason, candidates }: { reason: string; candidates: number }) {
  return (
    <section style={{
      padding: 24,
      background: 'rgba(0,0,0,0.25)',
      border: '1px dashed rgba(255,255,255,0.18)',
      borderRadius: 8,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,213,79,0.85)' }}>
        No Elite ticket today
      </div>
      <p style={{ margin: '10px 0 4px', fontSize: 14, color: 'rgba(255,255,255,0.85)' }}>
        {reason}
      </p>
      {candidates > 0 && (
        <p className="muted small" style={{ margin: 0, fontSize: 12 }}>
          {candidates} candidates scanned. Neither a 3-leg nor a 2-leg combination
          cleared the institutional filter.
        </p>
      )}
      <p className="muted small" style={{ margin: '12px 0 0', fontSize: 12, lineHeight: 1.5, maxWidth: 480, marginLeft: 'auto', marginRight: 'auto', fontStyle: 'italic' }}>
        Forcing a ticket on a no-edge day corrupts trust and burns long-term EV. The
        absence of a ticket today IS the product working as designed.
      </p>
    </section>
  );
}
