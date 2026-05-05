import type { AdvancedStats } from './api';
import { STAT_LABELS } from './StatPicker';

type Props = { advanced: AdvancedStats };

export function AdvancedCards({ advanced: a }: Props) {
  const statLabel = STAT_LABELS[a.selectedStat];
  const t = a.trend;
  const p = a.performanceVsTeam;
  const h = a.homeAway;

  return (
    <div className="adv-grid">
      <div className="adv-card">
        <div className="adv-k">Double-Double Rate</div>
        <div className="adv-v">{a.doubleDouble.rate}%</div>
        <div className="adv-sub">
          {a.doubleDouble.count} of {a.gamesAnalyzed} games
        </div>
      </div>

      <div className="adv-card">
        <div className="adv-k">Triple-Double Rate</div>
        <div className="adv-v">{a.tripleDouble.rate}%</div>
        <div className="adv-sub">
          {a.tripleDouble.count} of {a.gamesAnalyzed} games
        </div>
      </div>

      <div className="adv-card">
        <div className="adv-k">Consistency · {statLabel}</div>
        <div className="adv-v">{a.consistency.score}<span className="adv-unit">/100</span></div>
        <div className="adv-sub">{a.consistency.label}</div>
      </div>

      <div className="adv-card">
        <div className="adv-k">Trend · {statLabel}</div>
        {t.label === 'Not Enough Data' ? (
          <>
            <div className="adv-v adv-small">—</div>
            <div className="adv-sub">Not enough games (need 5+)</div>
          </>
        ) : (
          <>
            <div className="adv-v adv-small">
              {t.last5Avg.toFixed(1)} <span className="adv-arrow">→</span> Last 10: {t.last10Avg.toFixed(1)}
            </div>
            <div className={`adv-sub ${trendClass(t.label)}`}>
              {t.label} ({t.percentChange >= 0 ? '+' : ''}{t.percentChange.toFixed(1)}%)
            </div>
          </>
        )}
      </div>

      <div className="adv-card">
        <div className="adv-k">Performance vs Team · {statLabel}</div>
        {p.label === 'Not Enough Data' ? (
          <>
            <div className="adv-v adv-small">—</div>
            <div className="adv-sub">Not enough games</div>
          </>
        ) : (
          <>
            <div className="adv-v adv-small">
              {p.vsTeamAvg.toFixed(1)} <span className="adv-vs">vs season</span> {p.seasonAvg.toFixed(1)}
            </div>
            <div className={`adv-sub ${perfClass(p.label)}`}>
              {p.label} ({p.percentChange >= 0 ? '+' : ''}{p.percentChange.toFixed(1)}%)
            </div>
          </>
        )}
      </div>

      <div className="adv-card">
        <div className="adv-k">Home vs Away · {statLabel}</div>
        <div className="adv-v adv-small">
          H {h.homeAvg.toFixed(1)} <span className="adv-vs">·</span> A {h.awayAvg.toFixed(1)}
        </div>
        <div className="adv-sub">
          Better: {h.betterLocation}
          {h.betterLocation !== 'Even' && (
            <> · diff {h.difference >= 0 ? '+' : ''}{h.difference.toFixed(1)}</>
          )}
        </div>
      </div>
    </div>
  );
}

function trendClass(label: string): string {
  if (label === 'Trending Up') return 'pos';
  if (label === 'Trending Down') return 'neg';
  return '';
}

function perfClass(label: string): string {
  if (label === 'Better vs Team') return 'pos';
  if (label === 'Worse vs Team') return 'neg';
  return '';
}
