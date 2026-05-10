// Live Deck — surfaced at the top of the homepage when any NBA, MLB,
// UFC, or WNBA event is currently in progress. Bloomberg-Terminal
// framing: when markets are live, that's what users see first.
//
// Combines four sources (ESPN NBA scoreboard + statsapi MLB schedule
// + ESPN WNBA scoreboard + ESPN UFC scoreboard) into a single sport-
// tagged feed, sorted by sport then status detail. Renders nothing
// when no events are live so the homepage stays clean.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMlbToday,
  getTodayGames,
  getUfcScoreboard,
  getWnbaToday,
  type EspnScoreboardGame,
  type MlbTodayGame,
  type UfcEvent,
  type WnbaScoreboardGame,
} from './api';
import { useStarredProps } from './starredProps';

type LiveTile = {
  sport: 'NBA' | 'MLB' | 'WNBA' | 'UFC';
  href: string;
  awayAbbr: string;
  homeAbbr: string;
  awayScore: string;
  homeScore: string;
  statusDetail: string;
  // Team abbrs used for matching starred props to this live game so
  // we can surface "you have N starred props on this game" tags.
  awayTeam: string | null;
  homeTeam: string | null;
};

export function LiveDeck() {
  const [tiles, setTiles] = useState<LiveTile[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      getTodayGames(),
      getMlbToday(),
      getWnbaToday(),
      getUfcScoreboard(),
    ]).then((results) => {
      if (cancelled) return;
      const out: LiveTile[] = [];
      // NBA
      if (results[0].status === 'fulfilled') {
        const nba = results[0].value.games.filter((g): g is EspnScoreboardGame => g.status.state === 'in');
        for (const g of nba) {
          out.push({
            sport: 'NBA',
            href: `/espn-game/${g.id}`,
            awayAbbr: g.away.abbreviation,
            homeAbbr: g.home.abbreviation,
            awayScore: g.away.score || '0',
            homeScore: g.home.score || '0',
            statusDetail: g.status.detail,
            awayTeam: g.away.abbreviation,
            homeTeam: g.home.abbreviation,
          });
        }
      }
      // MLB
      if (results[1].status === 'fulfilled') {
        const mlb = results[1].value.games.filter((g: MlbTodayGame) => g.status.inProgress);
        for (const g of mlb) {
          out.push({
            sport: 'MLB',
            href: `/mlb/game/${g.gamePk}`,
            awayAbbr: g.away.abbreviation,
            homeAbbr: g.home.abbreviation,
            awayScore: g.away.score !== null ? String(g.away.score) : '0',
            homeScore: g.home.score !== null ? String(g.home.score) : '0',
            statusDetail: g.status.detailedState,
            awayTeam: g.away.abbreviation,
            homeTeam: g.home.abbreviation,
          });
        }
      }
      // WNBA
      if (results[2].status === 'fulfilled') {
        const wnba = results[2].value.games.filter((g: WnbaScoreboardGame) => g.status.state === 'in');
        for (const g of wnba) {
          out.push({
            sport: 'WNBA',
            href: `/wnba/game/${g.id}`,
            awayAbbr: g.away.abbreviation,
            homeAbbr: g.home.abbreviation,
            awayScore: g.away.score || '0',
            homeScore: g.home.score || '0',
            statusDetail: g.status.detail,
            awayTeam: g.away.abbreviation,
            homeTeam: g.home.abbreviation,
          });
        }
      }
      // UFC — events are nested differently. Flatten to "live fights"
      // by walking each event's fights[] for state === 'in'. Each
      // becomes its own tile with red/blue corners as away/home.
      if (results[3].status === 'fulfilled') {
        const events = (results[3].value.events ?? []) as UfcEvent[];
        for (const ev of events) {
          if (ev.state !== 'in') continue;
          for (const fight of ev.fights) {
            if (fight.state !== 'in') continue;
            const red = fight.fighters.red;
            const blue = fight.fighters.blue;
            if (!red || !blue) continue;
            out.push({
              sport: 'UFC',
              href: `/mma/event/${ev.id}/fight/${fight.id}`,
              awayAbbr: red.shortName || red.displayName.split(' ').slice(-1)[0] || red.displayName,
              homeAbbr: blue.shortName || blue.displayName.split(' ').slice(-1)[0] || blue.displayName,
              awayScore: '—',
              homeScore: '—',
              statusDetail: fight.weightClass ?? 'In progress',
              awayTeam: null,
              homeTeam: null,
            });
          }
        }
      }
      setTiles(out);
    });
    return () => { cancelled = true; };
  }, [tick]);

  // Auto-refresh every 60s when at least one game is live; otherwise
  // back off to 120s. Tab-hidden polling is paused.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, tiles.length > 0 ? 60_000 : 120_000);
    return () => window.clearInterval(interval);
  }, [tiles.length]);

  if (tiles.length === 0) return null;

  return (
    <section
      style={{
        position: 'relative',
        margin: '20px auto 28px',
        maxWidth: 1100,
        padding: '14px 18px',
        background: `
          radial-gradient(ellipse 50% 80% at 0% 0%, rgba(239,83,80,0.08) 0%, transparent 60%),
          radial-gradient(ellipse 50% 80% at 100% 100%, rgba(122,162,255,0.06) 0%, transparent 60%),
          linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
          var(--surface-1)
        `,
        border: '1px solid rgba(239,83,80,0.30)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        overflow: 'hidden',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(239,83,80,0.55), transparent)',
      }} />
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="live-pulse" style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: '#ef5350',
          }} />
          <span style={{ color: '#ef5350' }}>Live now</span>
          <span style={{ color: 'rgba(255,255,255,0.55)', fontWeight: 600 }}>
            · {tiles.length} {tiles.length === 1 ? 'game' : 'games'} in progress
          </span>
        </h2>
        <span className="muted small" style={{ fontSize: 11 }}>auto-refresh 60s</span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 10,
        }}
      >
        {tiles.map((t, i) => <LiveTileCard key={i} tile={t} />)}
      </div>
    </section>
  );
}

function LiveTileCard({ tile: t }: { tile: LiveTile }) {
  // Count how many of the user's starred props are riding on either
  // team in this live game. Surfaces "you have N picks live" so users
  // know whether to drill into the game right now.
  const { items: starred } = useStarredProps();
  const overlapCount = useMemo(() => {
    if (!t.awayTeam && !t.homeTeam) return 0;
    return starred.filter((p) =>
      p.team === t.awayTeam || p.team === t.homeTeam,
    ).length;
  }, [starred, t.awayTeam, t.homeTeam]);

  const sportColor =
    t.sport === 'NBA'  ? '#7aa2ff'
    : t.sport === 'MLB' ? '#66bb6a'
    : t.sport === 'UFC' ? '#ef5350'
    : '#b388ff';     // WNBA = purple per spec

  return (
    <Link
      to={t.href}
      className="live-deck-tile"
      style={{
        textDecoration: 'none',
        color: 'inherit',
        padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
        background: 'linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 30%), rgba(0,0,0,0.22)',
        border: '1px solid rgba(255,255,255,0.06)',
        display: 'block',
        position: 'relative',
        transition: 'transform 200ms cubic-bezier(0.4,0,0.2,1), background 200ms, border-color 200ms',
      }}
      title={`${t.sport}: ${t.awayAbbr} @ ${t.homeAbbr} — ${t.statusDetail}`}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: 6,
          gap: 6,
        }}
      >
        <span style={{ color: sportColor }}>{t.sport}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#ef5350' }}>
          <span className="live-pulse" style={{
            display: 'inline-block', width: 5, height: 5, borderRadius: 2.5, background: '#ef5350',
          }} />
          {t.statusDetail}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontVariantNumeric: 'tabular-nums', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
        <strong>{t.awayAbbr}</strong>
        <strong>{t.awayScore}</strong>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontVariantNumeric: 'tabular-nums', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
        <strong>{t.homeAbbr}</strong>
        <strong>{t.homeScore}</strong>
      </div>
      {overlapCount > 0 && (
        <div style={{
          marginTop: 8, paddingTop: 6, borderTop: '1px solid rgba(255,213,79,0.18)',
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
          color: '#ffd54f',
        }}>
          ★ {overlapCount} starred {overlapCount === 1 ? 'pick' : 'picks'} on this game
        </div>
      )}
    </Link>
  );
}
