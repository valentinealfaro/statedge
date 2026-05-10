import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getSlateAuto,
  liveGradeLegs,
  type EliteLegLiveState,
  type SlateResolvedLine,
} from './api';
import { PlayerAvatar } from './Avatar';
import { edgeScore } from './edgeScore';
import { LiveVerdictPill } from './slateLiveState';
import { Skeleton } from './Skeleton';

// Top 6 best-edge picks from tonight's NBA slate, surfaced on Home
// so first-time visitors can find the killer feature without hunting
// for it. NBA-scoped because getSlateAuto() pulls the NBA auto-slate
// only; the cross-sport unified watchlist lives on /best-bets and is
// reachable via NavBar + the cross-link CTA below the teaser. Hidden
// when auto-pull fails so we don't show a dead section on Cloudflare-
// blocked days — /nba/slate itself has the upload fallback.
export function SlateTeaser() {
  const [lines, setLines] = useState<SlateResolvedLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [liveByKey, setLiveByKey] = useState<Map<string, EliteLegLiveState>>(new Map());

  useEffect(() => {
    getSlateAuto()
      .then((d) => {
        // Sort by composite edge score (confidence + line-gap +
        // vs-opp + trend - injury penalty), drop OUT players, top 6.
        const ranked = d.lines
          .filter((l) => l.injury?.status !== 'Out')
          .map((l) => ({ line: l, edge: edgeScore(l) }))
          .filter((r) => r.edge >= 65)
          .sort((a, b) => b.edge - a.edge)
          .slice(0, 6)
          .map((r) => r.line);
        if (ranked.length === 0) setHidden(true);
        else setLines(ranked);
      })
      .catch(() => setHidden(true))
      .finally(() => setLoading(false));
  }, []);

  // Phase 145 — poll live state for the visible top-6 every 60s. Same
  // shared endpoint as /slate, capped well under the 50-leg limit.
  const linesSig = lines.map((l) => `${l.playerId}-${l.statKey}-${l.line}`).join('|');
  useEffect(() => {
    if (lines.length === 0) { setLiveByKey(new Map()); return; }
    let cancelled = false;
    const tick = () => {
      const payload = lines.map((l) => ({
        playerId: l.playerId,
        playerName: l.playerName,
        statKey: l.statKey,
        direction: (l.hitProbability?.lean === 'UNDER' ? 'UNDER' : 'OVER') as 'OVER' | 'UNDER',
        line: l.line,
      }));
      liveGradeLegs(payload)
        .then((states) => {
          if (cancelled) return;
          const m = new Map<string, EliteLegLiveState>();
          for (let i = 0; i < states.length; i++) {
            const p = payload[i]!;
            m.set(`${p.playerId}-${p.statKey}-${p.line}-${p.direction}`, states[i]!);
          }
          setLiveByKey(m);
        })
        .catch(() => { /* silent */ });
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [linesSig]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (hidden) return null;

  return (
    <section className="trending">
      <h2>
        Tonight's NBA edges
        <Link to="/nba/slate" className="footer-link" style={{ marginLeft: 12, fontSize: 14 }}>
          Full slate →
        </Link>
        <Link to="/best-bets" className="footer-link" style={{ marginLeft: 8, fontSize: 14, color: '#ffd54f' }} title="Cross-sport unified watchlist — NBA + MLB + UFC ranked by EV">
          Cross-sport →
        </Link>
      </h2>
      <div className="trending-grid">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="trending-card">
                <Skeleton width={64} height={64} radius="50%" />
                <Skeleton width="80%" height={14} style={{ marginTop: 10 }} />
                <Skeleton width="60%" height={12} style={{ marginTop: 6 }} />
                <Skeleton width="100%" height={20} style={{ marginTop: 8 }} />
              </div>
            ))
          : lines.map((l) => {
              const hit = l.hitProbability;
              const lean = hit?.lean ?? 'OVER';
              const cls = lean === 'OVER' ? 'teaser-badge over' : 'teaser-badge under';
              const edge = edgeScore(l);
              const live = liveByKey.get(`${l.playerId}-${l.statKey}-${l.line}-${lean === 'UNDER' ? 'UNDER' : 'OVER'}`) ?? null;
              return (
                <Link
                  key={`${l.playerId}-${l.statKey}-${l.line}`}
                  className="trending-card"
                  to={`/slate?legs=${l.playerId}-${l.statKey}-${l.line}`}
                  title="Add this to a parlay on the slate page"
                >
                  <PlayerAvatar playerId={l.playerId} name={l.playerName} size="lg" />
                  <div className="trending-name">{l.playerName}</div>
                  <div className="trending-team">
                    {l.team ?? '—'} · {l.statLabel} {l.line}
                  </div>
                  <div className={cls}>
                    ⚡ {edge} · {lean}
                  </div>
                  {live && (
                    <div style={{ marginTop: 6 }}>
                      <LiveVerdictPill state={live} compact />
                    </div>
                  )}
                </Link>
              );
            })}
      </div>
    </section>
  );
}
