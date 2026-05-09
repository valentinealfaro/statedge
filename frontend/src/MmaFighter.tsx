// /mma/fighter/:id — UFC fighter profile, Phase 107c.
//
// Bio + record + recent fight history + StatEdge articles +
// Google News headlines + social search links. Mirrors the NBA /
// MLB player log structure so muscle memory carries across sports.
//
// Recent fight history is derived from the same UFC scoreboard the
// /mma index uses — we filter for fights this fighter participated
// in. No new endpoint needed.

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getUfcMoneylines,
  getUfcScoreboard,
  type UfcEvent,
  type UfcFight,
  type UfcMoneylineEvent,
  type UfcScoreboardResponse,
} from './api';
import { NavBar } from './NavBar';
import { PlayerNewsSection } from './PlayerNewsSection';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

type FightWithEvent = UfcFight & { event: UfcEvent; isRed: boolean };

export function MmaFighter() {
  const { fighterId } = useParams<{ fighterId: string }>();
  const [scoreboard, setScoreboard] = useState<UfcScoreboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moneylines, setMoneylines] = useState<UfcMoneylineEvent[]>([]);

  useEffect(() => {
    if (!fighterId) return;
    setScoreboard(null);
    setError(null);
    getUfcScoreboard()
      .then(setScoreboard)
      .catch((err: Error) => setError(err.message));
    getUfcMoneylines()
      .then((r) => setMoneylines(r.events))
      .catch(() => setMoneylines([]));
  }, [fighterId]);

  // Pull every fight from the scoreboard where this fighter appears.
  // Newest first. Each entry remembers which corner (red/blue) the
  // fighter is in so we can highlight wins/losses correctly.
  const fights = useMemo<FightWithEvent[]>(() => {
    if (!scoreboard || !fighterId) return [];
    const out: FightWithEvent[] = [];
    for (const ev of scoreboard.events) {
      for (const f of ev.fights) {
        if (f.fighters.red?.id === fighterId) {
          out.push({ ...f, event: ev, isRed: true });
        } else if (f.fighters.blue?.id === fighterId) {
          out.push({ ...f, event: ev, isRed: false });
        }
      }
    }
    return out.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [scoreboard, fighterId]);

  // Identity comes from the most recent fight's record.
  const fighter = useMemo(() => {
    for (const f of fights) {
      const me = f.isRed ? f.fighters.red : f.fighters.blue;
      if (me) return me;
    }
    return null;
  }, [fights]);

  useTitle(fighter ? [fighter.displayName, 'UFC'] : ['UFC Fighter']);

  // Lookup table for moneylines by fighter id (we resolve by name
  // since The Odds API doesn't share ESPN ids).
  const moneylineByFighterName = useMemo(() => {
    const out = new Map<string, { american: number; implied: number }>();
    for (const ev of moneylines) {
      out.set(normalizeName(ev.fighterA.fighterName), { american: ev.fighterA.americanOdds, implied: ev.fighterA.impliedProbability });
      out.set(normalizeName(ev.fighterB.fighterName), { american: ev.fighterB.americanOdds, implied: ev.fighterB.impliedProbability });
    }
    return out;
  }, [moneylines]);

  const upcoming = fights.find((f) => f.state !== 'post');
  const completed = fights.filter((f) => f.state === 'post');

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ marginBottom: 12 }}>
          <Link to="/mma/scoreboard" className="muted small">← Back to UFC</Link>
        </div>

        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        {!scoreboard && !error && <Skeleton width="60%" height={32} />}

        {fighter && (
          <header style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16 }}>
            {fighter.headshot && (
              <img
                src={fighter.headshot}
                alt=""
                loading="lazy"
                style={{ width: 96, height: 96, borderRadius: 48, objectFit: 'cover', background: 'rgba(255,255,255,0.05)', flexShrink: 0 }}
              />
            )}
            <div>
              <h1 style={{ margin: 0 }}>{fighter.displayName}</h1>
              <div className="muted small" style={{ marginTop: 4, display: 'flex', gap: 12 }}>
                {fighter.record && <span>Record: <strong>{fighter.record}</strong></span>}
              </div>
            </div>
          </header>
        )}

        {scoreboard && fights.length === 0 && (
          <div className="muted small" style={{ padding: '24px 12px', fontStyle: 'italic' }}>
            No fights for this fighter in the past 7 days or next 60 days.
          </div>
        )}

        {upcoming && (
          <section style={{ marginBottom: 18 }}>
            <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', margin: '0 0 8px' }}>
              Next Fight
            </h2>
            <FightSummary fight={upcoming} fighterId={fighterId!} moneylineByFighterName={moneylineByFighterName} />
          </section>
        )}

        {completed.length > 0 && (
          <section style={{ marginBottom: 18 }}>
            <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', margin: '0 0 8px' }}>
              Recent Fights
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {completed.map((f) => (
                <FightSummary key={f.id} fight={f} fighterId={fighterId!} moneylineByFighterName={moneylineByFighterName} />
              ))}
            </div>
          </section>
        )}

        {fighter && fighterId && (
          <PlayerNewsSection
            sport="mma"
            playerId={fighterId}
            playerName={fighter.displayName}
          />
        )}
      </div>
    </div>
  );
}

function FightSummary({ fight, fighterId, moneylineByFighterName }: { fight: FightWithEvent; fighterId: string; moneylineByFighterName: Map<string, { american: number; implied: number }> }) {
  const me = fight.isRed ? fight.fighters.red : fight.fighters.blue;
  const opp = fight.isRed ? fight.fighters.blue : fight.fighters.red;
  const won = fight.result?.winnerId === fighterId;
  const lost = fight.state === 'post' && fight.result?.winnerId && fight.result.winnerId !== fighterId;
  const verdict = won ? 'W' : lost ? 'L' : null;
  const verdictColor = won ? '#66bb6a' : lost ? '#ef5350' : 'rgba(255,255,255,0.4)';

  const dateLabel = new Date(fight.date).toLocaleString([], {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  const myMl = me ? moneylineByFighterName.get(normalizeName(me.displayName)) : undefined;

  return (
    <div style={{
      padding: 12,
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderLeft: `3px solid ${verdictColor}`,
      borderRadius: 6,
      display: 'flex',
      gap: 12,
      alignItems: 'center',
      flexWrap: 'wrap',
    }}>
      {verdict && (
        <span style={{
          width: 28, height: 28, borderRadius: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 800, color: '#fff', background: verdictColor, flexShrink: 0,
        }}>
          {verdict}
        </span>
      )}
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          vs. {opp ? opp.displayName : 'TBD'}
          {fight.isTitle && <span style={{ marginLeft: 8, color: '#ffd54f', fontSize: 10, fontWeight: 800, letterSpacing: '0.06em' }}>· TITLE</span>}
        </div>
        <div className="muted small" style={{ fontSize: 11, marginTop: 2 }}>
          {fight.event.shortName ?? fight.event.name} · {dateLabel}
          {fight.weightClass ? ` · ${fight.weightClass}` : ''}
        </div>
        {fight.result && (
          <div className="muted small" style={{ fontSize: 11, marginTop: 2 }}>
            {fight.result.method ?? '—'}
            {fight.result.round ? ` · R${fight.result.round}` : ''}
            {fight.result.time ? ` · ${fight.result.time}` : ''}
          </div>
        )}
      </div>
      {myMl && fight.state !== 'post' && (
        <div style={{
          padding: '4px 10px',
          background: 'rgba(255,255,255,0.06)',
          borderRadius: 4,
          fontSize: 12,
          fontWeight: 700,
          color: myMl.american < 0 ? '#7aa2ff' : '#ffd54f',
        }}>
          {myMl.american > 0 ? `+${myMl.american}` : myMl.american} · {Math.round(myMl.implied * 100)}%
        </div>
      )}
    </div>
  );
}

function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').replace(/\s+/g, ' ').trim();
}
