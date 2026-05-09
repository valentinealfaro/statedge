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
    setData(null);
    setError(null);
    getUfcScoreboard()
      .then(setData)
      .catch((err: Error) => setError(err.message));
    // Moneylines are fetched in parallel — they're cached server-side
    // for 12h so this is cheap on every page load. Failure here is
    // non-fatal; the scoreboard renders without odds.
    getUfcMoneylines()
      .then((r) => setMoneylines(r.events))
      .catch(() => setMoneylines([]));
  }, []);

  // Build a fast lookup: fighter name (lowercased, normalized) →
  // moneyline outcome for that fighter. We index by individual fighter
  // since each Odds API event has both, and ESPN cards may slot
  // them differently in red/blue.
  const moneylineByFighter = useMemo(() => {
    const out = new Map<string, { american: number; implied: number; bookmaker: string | null }>();
    for (const ev of moneylines) {
      for (const f of [ev.fighterA, ev.fighterB]) {
        out.set(normalizeName(f.fighterName), {
          american: f.americanOdds,
          implied: f.impliedProbability,
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

type MoneylineLookup = Map<string, { american: number; implied: number; bookmaker: string | null }>;

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

  return (
    <div
      style={{
        padding: 14,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(239,83,80,0.2)',
        borderLeft: `3px solid ${MMA_ACCENT}`,
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{event.name}</h3>
        <span className="muted small" style={{ fontSize: 11 }}>{dateLabel}</span>
      </div>

      {event.venue && (
        <div className="muted small" style={{ fontSize: 11, marginTop: 4 }}>
          {event.venue.fullName}
          {event.venue.city ? ` · ${event.venue.city}` : ''}
          {event.venue.country ? `, ${event.venue.country}` : ''}
        </div>
      )}

      {main && <FightRow fight={main} primary moneylineByFighter={moneylineByFighter} />}

      {event.fights.length > 1 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>
            Full card · {event.fights.length} fights
          </summary>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {event.fights.filter((f) => f !== main).map((f) => <FightRow key={f.id} fight={f} primary={false} moneylineByFighter={moneylineByFighter} />)}
          </div>
        </details>
      )}
    </div>
  );
}

function FightRow({ fight, primary, moneylineByFighter }: { fight: UfcFight; primary: boolean; moneylineByFighter: MoneylineLookup }) {
  const red = fight.fighters.red;
  const blue = fight.fighters.blue;
  const redMl = red ? moneylineByFighter.get(normalizeName(red.displayName)) : undefined;
  const blueMl = blue ? moneylineByFighter.get(normalizeName(blue.displayName)) : undefined;
  const fontSize = primary ? 14 : 12;
  return (
    <div style={{ marginTop: primary ? 10 : 0, padding: primary ? '10px 12px' : '6px 8px', background: primary ? 'rgba(239,83,80,0.05)' : 'transparent', borderRadius: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize }}>
        <FighterCell f={red} winner={fight.result?.winnerId === red?.id} primary={primary} moneyline={redMl} />
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.45)' }}>VS</span>
        <FighterCell f={blue} winner={fight.result?.winnerId === blue?.id} primary={primary} alignRight moneyline={blueMl} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase' }}>
        <span>
          {fight.weightClass ?? ''}
          {fight.isTitle && <span style={{ marginLeft: 6, color: '#ffd54f' }}>· TITLE</span>}
        </span>
        {fight.result && (
          <span>
            {fight.result.method ?? '—'}
            {fight.result.round ? ` · R${fight.result.round}` : ''}
            {fight.result.time ? ` · ${fight.result.time}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function FighterCell({ f, winner, primary, alignRight, moneyline }: { f: { id: string; displayName: string; record: string | null; headshot: string | null } | null; winner: boolean; primary: boolean; alignRight?: boolean; moneyline?: { american: number; implied: number; bookmaker: string | null } }) {
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
      {primary && f.headshot && (
        <Link to={`/mma/fighter/${f.id}`} style={{ flexShrink: 0 }}>
          <img
            src={f.headshot}
            alt=""
            loading="lazy"
            style={{ width: 32, height: 32, borderRadius: 16, objectFit: 'cover', background: 'rgba(255,255,255,0.05)', display: 'block' }}
          />
        </Link>
      )}
      <div style={{ minWidth: 0, overflow: 'hidden' }}>
        <Link
          to={`/mma/fighter/${f.id}`}
          style={{ fontWeight: winner ? 800 : 600, color: nameColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: 'none', display: 'block' }}
        >
          {f.displayName}
        </Link>
        <div className="muted small" style={{ fontSize: 10, display: 'flex', gap: 6, justifyContent: alignRight ? 'flex-end' : 'flex-start', flexWrap: 'wrap' }}>
          {f.record && <span>{f.record}</span>}
          {moneyline && (
            <span style={{
              fontWeight: 700,
              color: moneyline.american < 0 ? '#7aa2ff' : '#ffd54f',
              padding: '1px 4px',
              borderRadius: 3,
              background: 'rgba(255,255,255,0.06)',
            }}>
              {moneyline.american > 0 ? `+${moneyline.american}` : moneyline.american} · {Math.round(moneyline.implied * 100)}%
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
