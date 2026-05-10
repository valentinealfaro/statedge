// TodayAtAGlance — Phase 147, extended through iter 67.
//
// Bloomberg-style top-strip surfacing the four numbers that matter
// when a user lands on the site mid-day. Mounted across five
// institutional surfaces (Home, Dashboard, Best Bets, Elite,
// Starred) so the headline state is the same wherever the user is.
//   • Live games count (NBA + MLB + UFC, including in-progress fights)
//   • Active edges count (props with |edge| ≥ 5%, NBA + MLB + UFC)
//   • Today's Elite ticket verdict (if persisted)
//   • Tonight's combined CLV beat-rate (truth-metric pulse)
//
// Polls every 60s so values reflect the moment users glance at it.
// Self-hides on quiet days when nothing is moving — those pages stay
// clean rather than showing a row of zeros.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getClvTrustScore,
  getEliteLiveState,
  getMlbDailySlate,
  getMlbLiveToday,
  getNbaLiveToday,
  getTodaySlate,
  getUfcScoreboard,
  getUfcSlateProjections,
  type ClvTrustScoreResponse,
  type EliteLiveStateResponse,
  type MlbDailySlateResponse,
  type MlbLiveTodayResponse,
  type NbaLiveTodayResponse,
  type SlateResponse,
  type UfcEvent,
  type UfcSlateProjectionsResponse,
} from './api';

type Glance = {
  liveGames: number;
  // Per-sport split for the tooltip / sub-line.
  liveBySport: { nba: number; mlb: number; ufc: number };
  activeEdges: number;
  // Per-sport split of active edges (≥5%) by sport, for the
  // Active-edges cell sub-line. UFC entered the count in iter 67
  // once /api/mma/slate/projections shipped — heuristic engine output
  // satisfies the ≥5% bar without a fundamental fighter-stat model.
  edgesBySport: { nba: number; mlb: number; ufc: number };
  eliteVerdict: 'HIT' | 'MISS' | 'IN_FLIGHT' | null;
  eliteLegRollup: { hit: number; miss: number; inFlight: number } | null;
  beatRate30d: number | null;
  totalProps: number;
};

export function TodayAtAGlance() {
  const [glance, setGlance] = useState<Glance | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const [
        nbaSlateRes,
        mlbSlateRes,
        nbaLiveRes,
        mlbLiveRes,
        ufcRes,
        ufcProjRes,
        eliteRes,
        clvRes,
      ] = await Promise.allSettled([
        getTodaySlate('balanced').catch(() => null),
        getMlbDailySlate().catch(() => null),
        getNbaLiveToday().catch(() => null),
        getMlbLiveToday().catch(() => null),
        getUfcScoreboard().catch(() => null),
        getUfcSlateProjections().catch(() => null),
        getEliteLiveState().catch(() => null),
        getClvTrustScore().catch(() => null),
      ]);
      if (cancelled) return;

      const nbaSlate = nbaSlateRes.status === 'fulfilled' ? nbaSlateRes.value as SlateResponse | null : null;
      const mlbSlate = mlbSlateRes.status === 'fulfilled' ? mlbSlateRes.value as MlbDailySlateResponse | null : null;
      const nbaLive = nbaLiveRes.status === 'fulfilled' ? nbaLiveRes.value as NbaLiveTodayResponse | null : null;
      const mlbLive = mlbLiveRes.status === 'fulfilled' ? mlbLiveRes.value as MlbLiveTodayResponse | null : null;
      const ufcSb = ufcRes.status === 'fulfilled' ? ufcRes.value as { events: UfcEvent[] } | null : null;
      const ufcProj = ufcProjRes.status === 'fulfilled' ? ufcProjRes.value as UfcSlateProjectionsResponse | null : null;
      const elite = eliteRes.status === 'fulfilled' ? eliteRes.value as EliteLiveStateResponse | null : null;
      const clv = clvRes.status === 'fulfilled' ? clvRes.value as ClvTrustScoreResponse | null : null;

      let nbaLiveCount = 0;
      let mlbLiveCount = 0;
      let ufcLiveCount = 0;
      if (nbaLive) {
        for (const g of Object.values(nbaLive.byGame ?? {})) {
          if ((g as { state?: string }).state === 'live') nbaLiveCount++;
        }
      }
      if (mlbLive) {
        for (const g of Object.values(mlbLive.byGame ?? {})) {
          if ((g as { state?: string }).state === 'live') mlbLiveCount++;
        }
      }
      if (ufcSb?.events) {
        // UFC: count in-progress fights across in-progress events.
        for (const ev of ufcSb.events) {
          if (ev.state !== 'in') continue;
          for (const f of ev.fights) {
            if (f.state === 'in') ufcLiveCount++;
          }
        }
      }
      const liveGames = nbaLiveCount + mlbLiveCount + ufcLiveCount;

      // Active edges across published slates. NBA reads `resolved.lines`
      // with each line's projection.edge.score; MLB combos.legs each
      // carry edgePercent. UFC reads the moneyline-anchored projection
      // engine output (Phase 136 / iter 64) — same ≥5 threshold so the
      // total is honestly comparable across sports. We threshold ≥5
      // to count.
      let nbaEdgeCount = 0;
      let mlbEdgeCount = 0;
      let ufcEdgeCount = 0;
      let totalProps = 0;
      const nbaLines = nbaSlate?.lines ?? [];
      for (const l of nbaLines) {
        totalProps++;
        const edge = l.projection?.edge.score ?? 0;
        if (Math.abs(edge) >= 5) nbaEdgeCount++;
      }
      if (mlbSlate?.resolved) {
        const mlbLegs = new Set<string>();
        for (const slot of mlbSlate.resolved.combos) {
          if (!slot.combo) continue;
          for (const leg of slot.combo.legs) {
            const k = `${leg.playerId}::${leg.statKey}::${leg.line}::${leg.direction}`;
            if (mlbLegs.has(k)) continue;
            mlbLegs.add(k);
            totalProps++;
            if (Math.abs(leg.edgePercent) >= 5) mlbEdgeCount++;
          }
        }
      }
      for (const p of ufcProj?.projections ?? []) {
        totalProps++;
        if (Math.abs(p.edgePercent) >= 5) ufcEdgeCount++;
      }
      const activeEdges = nbaEdgeCount + mlbEdgeCount + ufcEdgeCount;

      let eliteVerdict: Glance['eliteVerdict'] = null;
      let eliteLegRollup: Glance['eliteLegRollup'] = null;
      if (elite?.rollup) {
        const r = elite.rollup;
        if (r.ticketVerdict === 'HIT') eliteVerdict = 'HIT';
        else if (r.ticketVerdict === 'MISS') eliteVerdict = 'MISS';
        else if (r.hit + r.miss + r.inFlight > 0) eliteVerdict = 'IN_FLIGHT';
        eliteLegRollup = { hit: r.hit, miss: r.miss, inFlight: r.inFlight };
      }

      const beatRate30d = clv?.window30d?.beatRate ?? null;

      setGlance({
        liveGames,
        liveBySport: { nba: nbaLiveCount, mlb: mlbLiveCount, ufc: ufcLiveCount },
        activeEdges,
        edgesBySport: { nba: nbaEdgeCount, mlb: mlbEdgeCount, ufc: ufcEdgeCount },
        eliteVerdict,
        eliteLegRollup,
        beatRate30d,
        totalProps,
      });
    };

    tick();
    const id = window.setInterval(tick, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  if (!glance) return null;

  // Self-hide when there's literally nothing live + no edges + no
  // grading data yet. Quiet day — keep home clean.
  const isQuiet =
    glance.liveGames === 0 &&
    glance.activeEdges === 0 &&
    glance.eliteVerdict === null &&
    glance.beatRate30d === null;
  if (isQuiet) return null;

  return (
    <section
      style={{
        position: 'relative',
        margin: '12px auto 16px',
        maxWidth: 1100,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 10,
        padding: 14,
        background: `
          linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
          var(--surface-1)
        `,
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        overflow: 'hidden',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.10), transparent)',
      }} />

      <Cell
        label="Live now"
        value={glance.liveGames > 0 ? String(glance.liveGames) : '—'}
        sub={
          glance.liveGames > 0
            ? perSportSub(glance.liveBySport)
            : 'no games live'
        }
        accent={glance.liveGames > 0 ? '#ef5350' : 'rgba(255,255,255,0.45)'}
        pulse={glance.liveGames > 0}
        href="/dashboard"
      />

      <Cell
        label="Active edges"
        value={String(glance.activeEdges)}
        sub={
          glance.activeEdges > 0
            ? edgesPerSportSub(glance.edgesBySport)
            : glance.totalProps > 0 ? `of ${glance.totalProps} props ≥ 5%` : 'no slate published'
        }
        accent={glance.activeEdges >= 10 ? '#66bb6a' : glance.activeEdges >= 3 ? '#7aa2ff' : 'rgba(255,255,255,0.45)'}
        href="/best-bets"
      />

      <Cell
        label="Elite ticket"
        value={
          glance.eliteVerdict === 'HIT' ? '✓ HIT'
          : glance.eliteVerdict === 'MISS' ? '✗ MISS'
          : glance.eliteVerdict === 'IN_FLIGHT' && glance.eliteLegRollup
            ? `${glance.eliteLegRollup.hit}/${glance.eliteLegRollup.hit + glance.eliteLegRollup.miss + glance.eliteLegRollup.inFlight}`
            : '—'
        }
        sub={
          glance.eliteVerdict === 'IN_FLIGHT' && glance.eliteLegRollup
            ? `${glance.eliteLegRollup.inFlight} live · ${glance.eliteLegRollup.miss} miss`
            : glance.eliteVerdict === null ? 'pending or quiet day' : 'today\'s ticket settled'
        }
        accent={
          glance.eliteVerdict === 'HIT' ? '#66bb6a'
          : glance.eliteVerdict === 'MISS' ? '#ef5350'
          : glance.eliteVerdict === 'IN_FLIGHT' ? '#ffd54f'
          : 'rgba(255,255,255,0.45)'
        }
        pulse={glance.eliteVerdict === 'IN_FLIGHT'}
        href="/elite"
      />

      <Cell
        label="CLV · 30d"
        value={glance.beatRate30d !== null ? `${glance.beatRate30d.toFixed(1)}%` : '—'}
        sub="props beating market close"
        accent={
          glance.beatRate30d === null ? 'rgba(255,255,255,0.45)'
          : glance.beatRate30d >= 55 ? '#66bb6a'
          : glance.beatRate30d >= 50 ? '#ffd54f'
          : '#ef5350'
        }
        href="/clv"
      />
    </section>
  );
}

function Cell({
  label, value, sub, accent, pulse, href,
}: {
  label: string;
  value: string;
  sub: string;
  accent: string;
  pulse?: boolean;
  href?: string;
}) {
  const inner = (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 10, fontWeight: 800, letterSpacing: '0.10em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
      }}>
        {pulse && (
          <span className="live-pulse" style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: accent,
          }} />
        )}
        {label}
      </div>
      <div style={{
        marginTop: 6,
        fontSize: 28, fontWeight: 900, lineHeight: 1,
        letterSpacing: '-0.04em',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontVariantNumeric: 'tabular-nums',
        color: accent,
        textShadow: pulse ? `0 0 18px ${accent}55` : 'none',
      }}>
        {value}
      </div>
      <div className="muted small" style={{ fontSize: 11, marginTop: 4, color: 'rgba(255,255,255,0.55)' }}>
        {sub}
      </div>
    </>
  );

  const wrapStyle: React.CSSProperties = {
    position: 'relative',
    display: 'block',
    padding: '12px 14px',
    background: 'rgba(0,0,0,0.20)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 'var(--radius-md)',
    textDecoration: 'none',
    color: 'inherit',
    transition: 'border-color 200ms, transform 200ms, background 200ms',
  };

  if (href) {
    return <Link to={href} className="glance-cell" style={wrapStyle}>{inner}</Link>;
  }
  return <div style={wrapStyle}>{inner}</div>;
}

// Compact per-sport split for the Live-now sub-line. Skips zeroes so
// "3 NBA · 1 UFC" reads tighter than "3 NBA · 0 MLB · 1 UFC". Falls
// back to "in progress" wording when somehow none of the per-sport
// counts are populated.
function perSportSub(s: { nba: number; mlb: number; ufc: number }): string {
  const parts: string[] = [];
  if (s.nba > 0) parts.push(`${s.nba} NBA`);
  if (s.mlb > 0) parts.push(`${s.mlb} MLB`);
  if (s.ufc > 0) parts.push(`${s.ufc} UFC`);
  if (parts.length === 0) return 'games in progress';
  return parts.join(' · ');
}

// Same shape, scoped to active-edges (NBA + MLB only — UFC slate
// doesn't expose a projection-engine edge yet).
function edgesPerSportSub(s: { nba: number; mlb: number; ufc: number }): string {
  const parts: string[] = [];
  if (s.nba > 0) parts.push(`${s.nba} NBA`);
  if (s.mlb > 0) parts.push(`${s.mlb} MLB`);
  if (s.ufc > 0) parts.push(`${s.ufc} UFC`);
  if (parts.length === 0) return 'props ≥ 5% edge';
  return `${parts.join(' · ')} ≥ 5%`;
}
