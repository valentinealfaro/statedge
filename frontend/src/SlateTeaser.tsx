import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSlateAuto, type SlateResolvedLine } from './api';
import { PlayerAvatar } from './Avatar';
import { edgeScore } from './edgeScore';
import { Skeleton } from './Skeleton';

// Top 6 best-edge picks from tonight's PrizePicks slate, surfaced on
// Home so first-time visitors can find the killer feature without
// hunting for it. Hidden when auto-pull fails so we don't show a
// dead section on Cloudflare-blocked days — /slate itself has the
// upload fallback.
export function SlateTeaser() {
  const [lines, setLines] = useState<SlateResolvedLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);

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

  if (hidden) return null;

  return (
    <section className="trending">
      <h2>
        Tonight's best edges
        <Link to="/slate" className="footer-link" style={{ marginLeft: 12, fontSize: 14 }}>
          Full slate →
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
                </Link>
              );
            })}
      </div>
    </section>
  );
}
