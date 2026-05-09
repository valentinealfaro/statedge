// Cross-sport command center — Phase 81. The "Bloomberg Terminal"
// homepage that aggregates tonight's strongest edges across NBA + MLB
// + WNBA, plus market trap radar, slate strength, and model health.
//
// Mission alignment: this is the institutional view — one screen that
// tells a quant operator "where is the edge tonight?" across every
// sport on the platform. No new endpoints; everything reuses existing
// slate + calibration aggregations.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MlbPlayerAvatar, PlayerAvatar, WnbaPlayerAvatar } from './Avatar';
import {
  getMlbCalibration,
  getMlbDailySlate,
  getTodaySlate,
  getWnbaCalibration,
  getWnbaSlate,
  type MlbCalibrationReport,
  type MlbDailySlateResponse,
  type SlateResponse,
  type WnbaCalibrationReport,
  type WnbaSlateResponse,
} from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

type Sport = 'nba' | 'mlb' | 'wnba';

const SPORT_COLOR: Record<Sport, string> = {
  nba:  '#7aa2ff',
  mlb:  '#66bb6a',
  wnba: '#b388ff',
};

const SPORT_LABEL: Record<Sport, string> = {
  nba: 'NBA',
  mlb: 'MLB',
  wnba: 'WNBA',
};

type UnifiedEdge = {
  sport: Sport;
  playerId: string | number;
  playerName: string;
  team: string | null;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  probability: number;
  edgePercent: number;
  trapScore: number;
  href: string;
};

export function Dashboard() {
  useTitle(['Dashboard']);
  const [nba, setNba]   = useState<SlateResponse | null>(null);
  const [mlb, setMlb]   = useState<MlbDailySlateResponse | null>(null);
  const [wnba, setWnba] = useState<WnbaSlateResponse | null>(null);
  const [mlbCal, setMlbCal] = useState<MlbCalibrationReport | null>(null);
  const [wnbaCal, setWnbaCal] = useState<WnbaCalibrationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [sportFilter, setSportFilter] = useState<Sport | 'all'>('all');

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const results = await Promise.allSettled([
        getTodaySlate('balanced'),
        getMlbDailySlate(),
        getWnbaSlate(),
        getMlbCalibration(7),
        getWnbaCalibration(30),
      ]);
      if (cancelled) return;
      const [nbaR, mlbR, wnbaR, mlbCalR, wnbaCalR] = results;
      if (nbaR.status === 'fulfilled')   setNba(nbaR.value.resolved);
      if (mlbR.status === 'fulfilled')   setMlb(mlbR.value);
      if (wnbaR.status === 'fulfilled')  setWnba(wnbaR.value);
      if (mlbCalR.status === 'fulfilled') setMlbCal(mlbCalR.value);
      if (wnbaCalR.status === 'fulfilled') setWnbaCal(wnbaCalR.value);
      setLoading(false);
      setLastUpdated(new Date());
    }

    refresh();
    // Auto-refresh every 90s. Server-side caches absorb the load
    // (12-25s slate cache, 5min cal cache) so multiple users tabbing
    // the dashboard don't multiply backend pressure.
    const interval = setInterval(refresh, 90_000);
    // Refresh on tab-focus too — Bloomberg vibe: always-fresh data.
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const allEdges = collectEdges(nba, mlb, wnba);
  const edges = sportFilter === 'all' ? allEdges : allEdges.filter((e) => e.sport === sportFilter);
  const traps = edges
    .filter((e) => e.trapScore >= 60)
    .sort((a, b) => b.trapScore - a.trapScore)
    .slice(0, 8);
  const topEdges = edges
    .filter((e) => e.edgePercent >= 5)
    .sort((a, b) => b.edgePercent - a.edgePercent)
    .slice(0, 12);

  const slateStrength = computeSlateStrength(nba, mlb, wnba);

  return (
    <div className="app">
      <NavBar />

      <div className="mlb-compare-shell">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ marginBottom: 4 }}>Command Center</h1>
          {lastUpdated && (
            <span
              className="muted small"
              style={{ fontSize: 11 }}
              title={`Last refresh: ${lastUpdated.toISOString()}. Auto-refreshes every 90s + on tab focus.`}
            >
              ● live · updated {lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 24 }}>
          Cross-sport quantitative intelligence. Tonight's strongest edges,
          trap radar, slate strength, and model health — one screen.
        </p>

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Skeleton width="100%" height={28} />
            <Skeleton width="80%" height={120} />
            <Skeleton width="100%" height={120} />
          </div>
        ) : (
          <>
            <SportFilterTabs value={sportFilter} onChange={setSportFilter} counts={{
              all:  allEdges.length,
              nba:  allEdges.filter((e) => e.sport === 'nba').length,
              mlb:  allEdges.filter((e) => e.sport === 'mlb').length,
              wnba: allEdges.filter((e) => e.sport === 'wnba').length,
            }} />

            <SectionHeader
              title="Tonight's strongest edges"
              hint="Top legs by model edge across every sport. Edge = our model probability − sportsbook implied probability."
            />
            {topEdges.length === 0 ? (
              <EmptyCard text="No high-edge legs detected yet — slates may not be published." />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 32 }}>
                {topEdges.map((e, i) => <EdgeCard key={`${e.sport}-${e.playerId}-${i}`} edge={e} />)}
              </div>
            )}

            <SectionHeader
              title="Slate strength"
              hint="Average edge × leg count across each sport's published slate. Higher = more institutional opportunity available tonight."
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 32 }}>
              <StrengthCard sport="nba"  data={slateStrength.nba} />
              <StrengthCard sport="mlb"  data={slateStrength.mlb} />
              <StrengthCard sport="wnba" data={slateStrength.wnba} />
            </div>

            <SectionHeader
              title="Trap watch"
              hint="Legs where the line just spiked vs season baseline — possible public-facing trap. Trap score ≥60. Trade carefully."
            />
            {traps.length === 0 ? (
              <EmptyCard text="No high-trap legs across tonight's slates. Clean board." />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 32 }}>
                {traps.map((t, i) => <TrapCard key={`${t.sport}-${t.playerId}-${i}`} edge={t} />)}
              </div>
            )}

            <SectionHeader
              title="Model health"
              hint="How well our probability buckets actually graded out vs predicted. Closer alignment = more trustworthy edge numbers."
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 32 }}>
              <HealthCard sport="mlb"  cal={mlbCal} />
              <HealthCard sport="wnba" cal={wnbaCal} />
              <NbaHealthCard nba={nba} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- helpers ----------

function collectEdges(
  nba: SlateResponse | null,
  mlb: MlbDailySlateResponse | null,
  wnba: WnbaSlateResponse | null,
): UnifiedEdge[] {
  const out: UnifiedEdge[] = [];

  if (nba) {
    const seen = new Set<string>();
    for (const c of nba.combos) {
      for (const l of c.legs) {
        const key = `${l.playerId}::${l.statKey}::${l.line}::${l.direction}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          sport: 'nba',
          playerId: l.playerId,
          playerName: l.playerName,
          team: l.team,
          statLabel: l.statLabel,
          line: l.line,
          direction: l.direction,
          probability: l.probability,
          edgePercent: l.edgePercent ?? 0,
          trapScore: l.trapScore ?? 0,
          href: '/nba/slate',
        });
      }
    }
  }

  if (mlb?.resolved) {
    const seen = new Set<string>();
    for (const slot of mlb.resolved.combos) {
      if (!slot.combo) continue;
      for (const l of slot.combo.legs) {
        const key = `${l.playerId}::${l.statKey}::${l.line}::${l.direction}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          sport: 'mlb',
          playerId: l.playerId,
          playerName: l.playerName,
          team: l.team,
          statLabel: l.statLabel,
          line: l.line,
          direction: l.direction,
          probability: l.probability,
          edgePercent: l.edgePercent,
          trapScore: l.trapScore,
          href: '/mlb/slate',
        });
      }
    }
  }

  if (wnba?.resolved) {
    const seen = new Set<string>();
    for (const l of wnba.resolved.lines) {
      const key = `${l.athleteId}::${l.statKey}::${l.line}::${l.direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        sport: 'wnba',
        playerId: l.athleteId,
        playerName: l.playerName,
        team: l.team,
        statLabel: l.statLabel,
        line: l.line,
        direction: l.direction,
        probability: l.probability,
        edgePercent: l.edgePercent,
        trapScore: l.trapScore,
        href: '/wnba/slate',
      });
    }
  }

  return out;
}

type StrengthData = {
  legs: number;
  avgEdge: number;
  highEdgeCount: number;  // legs with edge ≥ 10%
};

function computeSlateStrength(
  nba: SlateResponse | null,
  mlb: MlbDailySlateResponse | null,
  wnba: WnbaSlateResponse | null,
): { nba: StrengthData; mlb: StrengthData; wnba: StrengthData } {
  function rollup(edges: UnifiedEdge[]): StrengthData {
    if (edges.length === 0) return { legs: 0, avgEdge: 0, highEdgeCount: 0 };
    const sumEdge = edges.reduce((s, e) => s + e.edgePercent, 0);
    return {
      legs: edges.length,
      avgEdge: sumEdge / edges.length,
      highEdgeCount: edges.filter((e) => e.edgePercent >= 10).length,
    };
  }
  const all = collectEdges(nba, mlb, wnba);
  return {
    nba:  rollup(all.filter((e) => e.sport === 'nba')),
    mlb:  rollup(all.filter((e) => e.sport === 'mlb')),
    wnba: rollup(all.filter((e) => e.sport === 'wnba')),
  };
}

// ---------- components ----------

function SportFilterTabs({
  value,
  onChange,
  counts,
}: {
  value: Sport | 'all';
  onChange: (v: Sport | 'all') => void;
  counts: { all: number; nba: number; mlb: number; wnba: number };
}) {
  const TABS: Array<{ key: Sport | 'all'; label: string; color: string }> = [
    { key: 'all',  label: 'All',  color: '#cccccc' },
    { key: 'nba',  label: 'NBA',  color: SPORT_COLOR.nba },
    { key: 'mlb',  label: 'MLB',  color: SPORT_COLOR.mlb },
    { key: 'wnba', label: 'WNBA', color: SPORT_COLOR.wnba },
  ];
  return (
    <div role="tablist" style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
      {TABS.map((t) => {
        const active = value === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            style={{
              padding: '6px 12px',
              borderRadius: 4,
              border: `1px solid ${active ? t.color : 'rgba(255,255,255,0.1)'}`,
              background: active ? `${t.color}1a` : 'transparent',
              color: active ? t.color : 'rgba(255,255,255,0.65)',
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: '0.04em',
              cursor: 'pointer',
            }}
          >
            {t.label}
            <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 500 }}>{counts[t.key]}</span>
          </button>
        );
      })}
    </div>
  );
}

function SectionHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div style={{ marginBottom: 12, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: '0.02em' }}>{title}</h2>
      <span className="muted small" style={{ flex: 1 }}>{hint}</span>
    </div>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: '24px 16px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px dashed rgba(255,255,255,0.1)',
        borderRadius: 6,
        textAlign: 'center',
        marginBottom: 32,
      }}
      className="muted small"
    >
      {text}
    </div>
  );
}

function EdgeCard({ edge }: { edge: UnifiedEdge }) {
  const color = SPORT_COLOR[edge.sport];
  return (
    <Link
      to={edge.href}
      style={{
        display: 'block',
        background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${color}33`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: 12,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <SportAvatar edge={edge} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {edge.playerName}
          </div>
          <div className="muted small" style={{ fontSize: 11 }}>
            <span style={{ color, fontWeight: 700 }}>{SPORT_LABEL[edge.sport]}</span>
            {edge.team && <span> · {edge.team}</span>}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          {edge.statLabel} {edge.line}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: edge.direction === 'OVER' ? '#66bb6a' : '#ef5350' }}>
          {edge.direction === 'OVER' ? '↑' : '↓'} {Math.round(edge.probability)}%
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 16,
            fontWeight: 800,
            color: edge.edgePercent >= 0 ? '#66bb6a' : '#ef5350',
          }}
        >
          {edge.edgePercent >= 0 ? '+' : ''}{edge.edgePercent.toFixed(0)}%
        </span>
      </div>
    </Link>
  );
}

function TrapCard({ edge }: { edge: UnifiedEdge }) {
  const color = SPORT_COLOR[edge.sport];
  return (
    <Link
      to={edge.href}
      style={{
        display: 'block',
        background: 'rgba(239,83,80,0.05)',
        border: '1px solid rgba(239,83,80,0.25)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: 12,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <SportAvatar edge={edge} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {edge.playerName}
          </div>
          <div className="muted small" style={{ fontSize: 11 }}>
            <span style={{ color, fontWeight: 700 }}>{SPORT_LABEL[edge.sport]}</span>
            {edge.team && <span> · {edge.team}</span>}
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: '#ef5350',
            background: 'rgba(239,83,80,0.15)',
            padding: '3px 6px',
            borderRadius: 3,
          }}
        >
          ⚠ TRAP {Math.round(edge.trapScore)}
        </span>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600 }}>
        {edge.statLabel} {edge.line}
        <span style={{ marginLeft: 8, color: edge.direction === 'OVER' ? '#66bb6a' : '#ef5350' }}>
          {edge.direction === 'OVER' ? '↑' : '↓'} {Math.round(edge.probability)}%
        </span>
      </div>
    </Link>
  );
}

function SportAvatar({ edge }: { edge: UnifiedEdge }) {
  if (edge.sport === 'mlb' && typeof edge.playerId === 'number') {
    return <MlbPlayerAvatar playerId={edge.playerId} name={edge.playerName} size="md" />;
  }
  if (edge.sport === 'nba' && typeof edge.playerId === 'number') {
    return <PlayerAvatar playerId={edge.playerId} name={edge.playerName} size="md" />;
  }
  return <WnbaPlayerAvatar playerId={String(edge.playerId)} name={edge.playerName} size="md" />;
}

function StrengthCard({ sport, data }: { sport: Sport; data: StrengthData }) {
  const color = SPORT_COLOR[sport];
  const tier = data.legs === 0 ? 'No slate'
    : data.avgEdge >= 8 ? 'Strong'
    : data.avgEdge >= 4 ? 'Moderate'
    : 'Light';
  const slatePath = sport === 'nba' ? '/nba/slate' : sport === 'mlb' ? '/mlb/slate' : '/wnba/slate';
  return (
    <Link
      to={slatePath}
      style={{
        display: 'block',
        background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${color}33`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: 12,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ color, letterSpacing: '0.04em' }}>{SPORT_LABEL[sport]}</strong>
        <span className="muted small">{tier}</span>
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 16 }}>
        <div>
          <div className="muted small" style={{ fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Legs</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{data.legs}</div>
        </div>
        <div>
          <div className="muted small" style={{ fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Avg edge</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: data.avgEdge >= 5 ? '#66bb6a' : undefined }}>
            {data.avgEdge >= 0 ? '+' : ''}{data.avgEdge.toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="muted small" style={{ fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>≥10% edge</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{data.highEdgeCount}</div>
        </div>
      </div>
    </Link>
  );
}

function HealthCard({ sport, cal }: { sport: 'mlb' | 'wnba'; cal: MlbCalibrationReport | WnbaCalibrationReport | null }) {
  const color = SPORT_COLOR[sport];
  const calPath = sport === 'mlb' ? '/mlb/calibration' : '/wnba/calibration';
  if (!cal || cal.totalGraded === 0) {
    return (
      <Link
        to={calPath}
        style={{
          display: 'block',
          background: 'rgba(255,255,255,0.02)',
          border: `1px solid ${color}33`,
          borderLeft: `3px solid ${color}`,
          borderRadius: 6,
          padding: 12,
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        <strong style={{ color, letterSpacing: '0.04em' }}>{SPORT_LABEL[sport]}</strong>
        <p className="muted small" style={{ marginTop: 6, marginBottom: 0 }}>
          No graded picks yet. Calibration data accrues as games settle.
        </p>
      </Link>
    );
  }
  const overallHitRate = cal.overallHitRate * 100;
  const calGap = cal.calibrationGap * 100;
  return (
    <Link
      to={calPath}
      style={{
        display: 'block',
        background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${color}33`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: 12,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ color, letterSpacing: '0.04em' }}>{SPORT_LABEL[sport]}</strong>
        <span className="muted small">{cal.totalGraded} graded</span>
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 16 }}>
        <div>
          <div className="muted small" style={{ fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Hit rate</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: overallHitRate >= 55 ? '#66bb6a' : overallHitRate <= 45 ? '#ef5350' : undefined }}>
            {overallHitRate.toFixed(1)}%
          </div>
        </div>
        <div title="Predicted minus observed. Closer to 0 = better calibrated.">
          <div className="muted small" style={{ fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Cal gap</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: Math.abs(calGap) <= 3 ? '#66bb6a' : Math.abs(calGap) >= 8 ? '#ef5350' : undefined }}>
            {calGap >= 0 ? '+' : ''}{calGap.toFixed(1)}%
          </div>
        </div>
      </div>
    </Link>
  );
}

function NbaHealthCard({ nba }: { nba: SlateResponse | null }) {
  const color = SPORT_COLOR.nba;
  return (
    <Link
      to="/nba/slate"
      style={{
        display: 'block',
        background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${color}33`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: 12,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ color, letterSpacing: '0.04em' }}>NBA</strong>
        <span className="muted small">{nba?.combos.length ?? 0} cards</span>
      </div>
      <p className="muted small" style={{ marginTop: 6, marginBottom: 0 }}>
        Calibration view embedded in /nba/slate. Click to open.
      </p>
    </Link>
  );
}
