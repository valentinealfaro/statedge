// /elite — StatEdge Elite institutional 3-leg service. Phase 131.
//
// Per the Elite product spec: low-volume, high-conviction. The page
// shows ONE ticket OR an honest "no qualifying edge today" message.
// We never force a ticket — that's a feature, not a bug. Discipline
// builds trust.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getMlbEliteToday, getNbaEliteToday, type EliteEdgeReason, type EliteLeg, type EliteResponse, type EliteTicket } from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

type EliteSport = 'mlb' | 'nba';

const SPORT_COLOR: Record<EliteSport, string> = {
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
  const [sport, setSport] = useState<EliteSport>('mlb');
  const [data, setData] = useState<EliteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    const fetcher = sport === 'nba' ? getNbaEliteToday : getMlbEliteToday;
    fetcher()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [sport]);

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
            Low-volume, high-conviction. Spec target is a 3-leg ticket at 6× minimum
            payout. When no 3-leg combination clears the bar, the engine falls back to
            the strongest 2-leg pair at 3× payout rather than publish nothing — but
            only if a pair clears the same per-leg quality gate (60%+ probability,
            8pp+ edge, sub-35 trap, sub-45 fragility, mandatory edge category).
          </p>
        </header>

        {/* Sport selector — same Elite engine, different slate */}
        <div role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {(['mlb', 'nba'] as const).map((s) => {
            const active = sport === s;
            const color = SPORT_COLOR[s];
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSport(s)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 4,
                  border: `1px solid ${active ? color : 'rgba(255,255,255,0.12)'}`,
                  background: active ? `${color}1a` : 'transparent',
                  color: active ? color : 'rgba(255,255,255,0.65)',
                  fontWeight: 800,
                  fontSize: 11,
                  letterSpacing: '0.06em',
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                }}
              >
                {s.toUpperCase()}
              </button>
            );
          })}
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
            <p className="muted small" style={{ marginTop: 10, marginBottom: 0, fontSize: 12, lineHeight: 1.5, maxWidth: 460, marginLeft: 'auto', marginRight: 'auto' }}>
              Resolving today's slate, projecting every leg, scoring every 3-leg
              combination against the institutional filter. First load can take 10–20s
              on a cold backend; subsequent loads are instant.
            </p>
            <Skeleton width="100%" height={140} style={{ marginTop: 16 }} />
            <style>{`@keyframes pulse { 0%,100% { opacity: 1; transform: scale(1) } 50% { opacity: 0.4; transform: scale(0.85) } }`}</style>
          </div>
        )}

        {data && data.ticket && <TicketCard ticket={data.ticket} date={data.date} />}
        {data && !data.ticket && (
          <NoTicketCard reason={data.reason ?? 'no qualifying edge today'} candidates={data.candidatesScanned ?? 0} />
        )}

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

function TicketCard({ ticket, date }: { ticket: EliteTicket; date?: string }) {
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
  return (
    <div style={{
      padding: 12,
      background: 'rgba(0,0,0,0.25)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderLeft: `3px solid ${dirColor}`,
      borderRadius: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        <div>
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', color: 'rgba(255,255,255,0.5)', marginRight: 6 }}>
            LEG {index + 1}
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
