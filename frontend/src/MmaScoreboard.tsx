// /mma — UFC scoreboard, Phase 107a foundation.
//
// Lists upcoming + recent UFC events (PPV + Fight Nights) with each
// card's main matchups. Click an event → ESPN page in new tab for
// now; deeper fight detail / odds integration lands in subsequent
// phases.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getUfcMoneylines,
  getUfcScoreboard,
  type UfcEvent,
  type UfcFight,
  type UfcMoneylineEvent,
  type UfcScoreboardResponse,
} from './api';
import { UfcFighterAvatar } from './Avatar';
import { mmaFightDetailPath } from './MmaFightDetail';
import { ClvTrustBanner } from './ClvTrustBanner';
import { LatestNewsRail } from './LatestNewsRail';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

const MMA_ACCENT = '#ef5350';

export function MmaScoreboard() {
  useTitle(['UFC', 'MMA']);
  const [data, setData] = useState<UfcScoreboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'upcoming' | 'completed'>('upcoming');
  const [moneylines, setMoneylines] = useState<UfcMoneylineEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      getUfcScoreboard()
        .then((d) => { if (!cancelled) { setData(d); setError(null); } })
        .catch((err: Error) => { if (!cancelled) setError(err.message); });
    };
    tick();
    // Moneylines are fetched once on mount — they're cached server-side
    // for 12h so this is cheap. Failure here is non-fatal; the
    // scoreboard renders without odds.
    getUfcMoneylines()
      .then((r) => { if (!cancelled) setMoneylines(r.events); })
      .catch(() => { /* silent */ });
    // Re-poll the scoreboard every 60s so live cards (state === 'in')
    // tick fresh round/result data into view. Quieter than polling
    // every 30s — UFC fights resolve slowly, a one-minute beat is
    // tight enough.
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // Build a fast lookup: fighter name (lowercased, normalized) →
  // moneyline outcome for that fighter. We index by individual fighter
  // since each Odds API event has both, and ESPN cards may slot
  // them differently in red/blue.
  const moneylineByFighter = useMemo(() => {
    const out = new Map<string, { american: number; implied: number; fair: number; bookmaker: string | null }>();
    for (const ev of moneylines) {
      for (const f of [ev.fighterA, ev.fighterB]) {
        out.set(normalizeName(f.fighterName), {
          american: f.americanOdds,
          implied: f.impliedProbability,
          fair: f.fairProbability,
          bookmaker: ev.bookmaker,
        });
      }
    }
    return out;
  }, [moneylines]);

  const events = useMemo(() => {
    if (!data) return [];
    if (tab === 'upcoming') {
      return data.events.filter((e) => e.state !== 'post')
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }
    return data.events.filter((e) => e.state === 'post')
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [data, tab]);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>UFC</h1>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 16 }}>
          Upcoming and recent UFC cards. Fighter profiles, moneylines, and
          method-of-victory edge analysis land in subsequent phases.
        </p>

        {/* Truth metric — UFC-scoped. Self-hides until UFC projection
            volume accumulates; banner pattern stays consistent across
            all three sports. */}
        <ClvTrustBanner sport="mma" />

        <div role="tablist" style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          <TabButton active={tab === 'upcoming'} onClick={() => setTab('upcoming')}>
            Upcoming {data ? `(${data.upcoming + data.live})` : ''}
          </TabButton>
          <TabButton active={tab === 'completed'} onClick={() => setTab('completed')}>
            Recent {data ? `(${data.completed})` : ''}
          </TabButton>
        </div>

        {error && <div className="mlb-info-banner mlb-info-error">UFC scoreboard failed: {error}</div>}

        {!data && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Skeleton width="100%" height={140} />
            <Skeleton width="100%" height={140} />
          </div>
        )}

        {data && events.length === 0 && (
          <div className="muted small" style={{ padding: '24px 12px', fontStyle: 'italic' }}>
            {tab === 'upcoming' ? 'No upcoming UFC cards in the next 60 days.' : 'No recent UFC cards in the past 7 days.'}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {events.map((e) => <EventCard key={e.id} event={e} moneylineByFighter={moneylineByFighter} />)}
        </div>

        <LatestNewsRail sport="mma" limit={4} heading="UFC News & Recaps" />
      </div>
    </div>
  );
}

type MoneylineLookup = Map<string, { american: number; implied: number; fair: number; bookmaker: string | null }>;

function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: '6px 12px',
        borderRadius: 4,
        border: `1px solid ${active ? MMA_ACCENT : 'rgba(255,255,255,0.1)'}`,
        background: active ? `${MMA_ACCENT}1a` : 'transparent',
        color: active ? MMA_ACCENT : 'rgba(255,255,255,0.65)',
        fontWeight: 700,
        fontSize: 12,
        letterSpacing: '0.04em',
        cursor: 'pointer',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </button>
  );
}

function EventCard({ event, moneylineByFighter }: { event: UfcEvent; moneylineByFighter: MoneylineLookup }) {
  const main = event.fights.find((f) => f.isMain) ?? event.fights[0];
  const dateLabel = new Date(event.date).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  const isLive = event.state === 'in';
  const isFinal = event.state === 'post';

  return (
    <div
      className="fade-up"
      style={{
        position: 'relative',
        padding: 16,
        background: `
          radial-gradient(ellipse 50% 80% at 0% 0%, rgba(239,83,80,0.08) 0%, transparent 60%),
          linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
          var(--surface-1)
        `,
        border: `1px solid ${isLive ? 'rgba(239,83,80,0.45)' : 'rgba(239,83,80,0.20)'}`,
        borderLeft: `3px solid ${MMA_ACCENT}`,
        borderRadius: 'var(--radius-lg)',
        boxShadow: isLive
          ? '0 1px 0 rgba(255,255,255,0.05) inset, 0 8px 24px rgba(239,83,80,0.18), 0 2px 6px rgba(0,0,0,0.30)'
          : 'var(--shadow-card)',
        overflow: 'hidden',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(239,83,80,0.50), transparent)',
      }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900, letterSpacing: '-0.2px' }}>{event.name}</h3>
          {isLive && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 10, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase',
              color: '#ef5350',
              padding: '2px 8px', borderRadius: 3,
              background: 'rgba(239,83,80,0.16)',
              border: '1px solid rgba(239,83,80,0.45)',
            }}>
              <span className="live-pulse" style={{
                display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: '#ef5350',
              }} />
              Live
            </span>
          )}
          {isFinal && (
            <span style={{
              fontSize: 10, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.55)',
              padding: '2px 8px', borderRadius: 3,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
            }}>
              Final
            </span>
          )}
        </div>
        <span className="muted small" style={{ fontSize: 11 }}>{dateLabel}</span>
      </div>

      {event.venue && (
        <div className="muted small" style={{ fontSize: 11, marginTop: 4 }}>
          {event.venue.fullName}
          {event.venue.city ? ` · ${event.venue.city}` : ''}
          {event.venue.country ? `, ${event.venue.country}` : ''}
        </div>
      )}

      {main && <FightRow fight={main} eventId={event.id} primary moneylineByFighter={moneylineByFighter} />}

      {event.fights.length > 1 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>
            Full card · {event.fights.length} fights
          </summary>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {event.fights.filter((f) => f !== main).map((f) => <FightRow key={f.id} fight={f} eventId={event.id} primary={false} moneylineByFighter={moneylineByFighter} />)}
          </div>
        </details>
      )}
    </div>
  );
}

function FightRow({ fight, eventId, primary, moneylineByFighter }: { fight: UfcFight; eventId: string; primary: boolean; moneylineByFighter: MoneylineLookup }) {
  const red = fight.fighters.red;
  const blue = fight.fighters.blue;
  const redMl = red ? moneylineByFighter.get(normalizeName(red.displayName)) : undefined;
  const blueMl = blue ? moneylineByFighter.get(normalizeName(blue.displayName)) : undefined;
  const fontSize = primary ? 14 : 12;
  return (
    <Link
      to={mmaFightDetailPath(eventId, fight.id)}
      className="mma-fight-row"
      style={{
        display: 'block',
        textDecoration: 'none',
        color: 'inherit',
        marginTop: primary ? 10 : 0,
        padding: primary ? '10px 12px' : '6px 8px',
        background: primary ? 'rgba(239,83,80,0.05)' : 'transparent',
        borderRadius: 4,
        transition: 'background 200ms cubic-bezier(0.4,0,0.2,1), transform 200ms',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize }}>
        <FighterCell f={red} winner={fight.result?.winnerId === red?.id} primary={primary} moneyline={redMl} />
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.45)' }}>VS</span>
        <FighterCell f={blue} winner={fight.result?.winnerId === blue?.id} primary={primary} alignRight moneyline={blueMl} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', gap: 8, flexWrap: 'wrap' }}>
        <span>
          {fight.weightClass ?? ''}
          {fight.isMain && <span style={{ marginLeft: 6, color: '#ffd54f' }}>· MAIN</span>}
          {fight.isTitle && <span style={{ marginLeft: 6, color: '#ffd54f' }}>· TITLE</span>}
        </span>
        {fight.state === 'in' && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            color: '#ef5350', fontWeight: 800,
            padding: '1px 7px', borderRadius: 3,
            background: 'rgba(239,83,80,0.14)',
            border: '1px solid rgba(239,83,80,0.40)',
          }}>
            <span className="live-pulse" style={{
              display: 'inline-block', width: 5, height: 5, borderRadius: 2.5, background: '#ef5350',
            }} />
            Live
          </span>
        )}
        {fight.result && (
          <span>
            {fight.result.method ?? '—'}
            {fight.result.round ? ` · R${fight.result.round}` : ''}
            {fight.result.time ? ` · ${fight.result.time}` : ''}
          </span>
        )}
      </div>
    </Link>
  );
}

function FighterCell({ f, winner, primary, alignRight, moneyline }: { f: { id: string; displayName: string; record: string | null; headshot: string | null } | null; winner: boolean; primary: boolean; alignRight?: boolean; moneyline?: { american: number; implied: number; fair: number; bookmaker: string | null } }) {
  if (!f) return <span style={{ flex: 1, color: 'rgba(255,255,255,0.4)' }}>TBD</span>;
  const nameColor = winner ? '#66bb6a' : 'rgba(255,255,255,0.92)';
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexDirection: alignRight ? 'row-reverse' : 'row',
      textAlign: alignRight ? 'right' : 'left',
    }}>
      {primary && (
        <span style={{ flexShrink: 0 }}>
          <UfcFighterAvatar athleteId={f.id} name={f.displayName} size="sm" />
        </span>
      )}
      <div style={{ minWidth: 0, overflow: 'hidden' }}>
        <span
          style={{ fontWeight: winner ? 800 : 600, color: nameColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}
        >
          {f.displayName}
        </span>
        <div className="muted small" style={{ fontSize: 10, display: 'flex', gap: 6, justifyContent: alignRight ? 'flex-end' : 'flex-start', flexWrap: 'wrap' }}>
          {f.record && <span>{f.record}</span>}
          {moneyline && (
            <span
              title={`Book: ${Math.round(moneyline.implied * 100)}% · Fair (de-vigged): ${Math.round(moneyline.fair * 100)}%`}
              style={{
                fontWeight: 700,
                color: moneyline.american < 0 ? '#7aa2ff' : '#ffd54f',
                padding: '1px 4px',
                borderRadius: 3,
                background: 'rgba(255,255,255,0.06)',
              }}>
              {moneyline.american > 0 ? `+${moneyline.american}` : moneyline.american} · <strong>{Math.round(moneyline.fair * 100)}%</strong> fair
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
