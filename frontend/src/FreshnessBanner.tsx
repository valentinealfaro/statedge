import { useEffect, useState } from 'react';
import { getDataFreshness, type DataFreshness } from './api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function FreshnessBanner() {
  const [data, setData] = useState<DataFreshness | null>(null);

  useEffect(() => {
    let alive = true;
    const refetch = () => {
      getDataFreshness()
        .then((d) => { if (alive) setData(d); })
        .catch(() => { if (alive) setData(null); });
    };
    refetch();
    // Re-check when the tab comes back into focus — covers the "left it
    // open overnight, came back after the 4am sync" case so users aren't
    // looking at stale freshness data.
    const onVisible = () => { if (document.visibilityState === 'visible') refetch(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!data || !data.lastGameDate) return null;
  const stale = (data.daysStale ?? 0) > 3;
  return (
    <div
      className={stale ? 'freshness stale' : 'freshness'}
      title={`Last NBA game in cache: ${data.lastGameDate}`}
    >
      Data current through {formatDate(data.lastGameDate)}
      {stale && ` · ${data.daysStale} days behind`}
    </div>
  );
}
