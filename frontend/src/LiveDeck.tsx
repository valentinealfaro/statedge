// Live Deck — surfaced at the top of the homepage when ANY NBA or MLB
// game is currently in progress. Bloomberg-Terminal framing: when
// markets are live, that's what users see first.
//
// Combines two sources (ESPN NBA scoreboard + statsapi MLB schedule)
// into a single sport-tagged feed, sorted by sport then status detail.
// Renders nothing when no games are live so the homepage stays clean.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMlbToday,
  getTodayGames,
  getWnbaToday,
  type EspnScoreboardGame,
  type MlbTodayGame,
  type WnbaScoreboardGame,
} from './api';

type LiveTile = {
  sport: 'NBA' | 'MLB' | 'WNBA';
  href: string;
  awayAbbr: string;
  homeAbbr: string;
  awayScore: string;
  homeScore: string;
  statusDetail: string;
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
          });
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
        margin: '20px auto 28px',
        maxWidth: 1100,
        padding: '12px 16px',
        background: 'linear-gradient(135deg, rgba(239, 83, 80, 0.06), rgba(122, 162, 255, 0.05))',
        border: '1px solid rgba(239, 83, 80, 0.25)',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, letterSpacing: '0.02em' }}>
          <span style={{ color: '#ef5350' }}>● LIVE NOW</span>
          <span className="muted small" style={{ marginLeft: 8, fontWeight: 400 }}>
            · {tiles.length} game{tiles.length === 1 ? '' : 's'} in progress
          </span>
        </h2>
        <span className="muted small">auto-refresh 60s</span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 10,
        }}
      >
        {tiles.map((t, i) => (
          <Link
            key={i}
            to={t.href}
            style={{
              textDecoration: 'none',
              color: 'inherit',
              padding: '10px 12px',
              borderRadius: 6,
              background: 'rgba(0,0,0,0.18)',
              border: '1px solid rgba(255,255,255,0.06)',
              display: 'block',
              transition: 'background 120ms',
            }}
            title={`${t.sport}: ${t.awayAbbr} @ ${t.homeAbbr} — ${t.statusDetail}`}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                marginBottom: 6,
              }}
            >
              <span style={{
                color:
                  t.sport === 'NBA'  ? '#7aa2ff'
                  : t.sport === 'MLB' ? '#66bb6a'
                  : '#b388ff',     // WNBA = purple per spec
              }}>{t.sport}</span>
              <span style={{ color: '#ef5350' }}>● {t.statusDetail}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
              <strong>{t.awayAbbr}</strong>
              <strong>{t.awayScore}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
              <strong>{t.homeAbbr}</strong>
              <strong>{t.homeScore}</strong>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
