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
    getDataFreshness().then(setData).catch(() => setData(null));
  }, []);

  if (!data || !data.lastGameDate) return null;
  const stale = (data.daysStale ?? 0) > 3;
  return (
    <div className={stale ? 'freshness stale' : 'freshness'}>
      Data current through {formatDate(data.lastGameDate)}
      {stale && ` · ${data.daysStale} days behind`}
    </div>
  );
}
