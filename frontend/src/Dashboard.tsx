// Cross-sport Command Center — Phase 100 institutional rebuild,
// extended through iter 70 (UFC inclusion in collectEdges) + iter 84
// (StrengthCard slate-path bug fix) + iter 85 (SportAvatar UFC
// branch) + iter 88 (espnAthleteId in live-poll payload).
//
// Mission shift (per Phase 100 spec): stop ranking by hit rate, start
// ranking by market dislocation. The dashboard is no longer a "best
// picks" feed — it's a live quantitative war room. Every entry must
// surface WHY this is mispriced, RISK signals, MARKET context, and
// honest confidence uncertainty.
//
// Composed entirely from existing slate + calibration endpoints; the
// "intelligence density" upgrade is in framing, not new data. Sports
// covered: NBA + MLB + UFC + WNBA (UFC enters via Phase 136 heuristic
// engine output through /api/mma/slate/projections; UFC's Phase-101
// market-intel fields are honestly null since the heuristic doesn't
// produce them).
//
// Page surface: TodayAtAGlance ticker, ActivityFeed, AnalystBanner
// (1-2 sentence narrative), SportFilterTabs, three card rails
// (Dislocations / Disagreements / Trap Watch), Slate Strength rail
// (per-sport leg counts + avg edge + high-edge concentration),
// Model Health (predicted-vs-observed gap), EnginePulseStrip,
// LatestNewsRail.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MlbPlayerAvatar, PlayerAvatar, UfcFighterAvatar, WnbaPlayerAvatar } from './Avatar';
import {
  getMlbCalibration,
  getMlbDailySlate,
  getTodaySlate,
  getUfcSlateProjections,
  getWnbaCalibration,
  getWnbaSlate,
  liveGradeLegs,
  type EliteLegLiveState,
  type MlbCalibrationReport,
  type MlbDailySlateResponse,
  type SlateResponse,
  type UfcSlateProjectionsResponse,
  type WnbaCalibrationReport,
  type WnbaSlateResponse,
} from './api';
import { LiveVerdictPill } from './slateLiveState';
import { ActivityFeed } from './ActivityFeed';
import { ClvTrustBanner } from './ClvTrustBanner';
import { TodayAtAGlance } from './TodayAtAGlance';
import { EnginePulseStrip } from './EnginePulseStrip';
import { EngineStatus } from './EngineStatus';
import { LatestNewsRail } from './LatestNewsRail';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

type Sport = 'nba' | 'mlb' | 'wnba' | 'mma';

const SPORT_COLOR: Record<Sport, string> = {
  nba:  '#7aa2ff',
  mlb:  '#66bb6a',
  wnba: '#b388ff',
  mma:  '#ef5350',
};

const SPORT_LABEL: Record<Sport, string> = {
  nba: 'NBA',
  mlb: 'MLB',
  wnba: 'WNBA',
  mma: 'UFC',
};

// UFC stat labels — same map BestBets / NavSearch trending use.
// Mirrors STAT_LABEL in MmaSlate / MmaFighterTonightSlate.
const UFC_STAT_LABEL: Record<string, string> = {
  sig_strikes:     'Sig Strikes',
  rd1_sig_strikes: 'R1 Sig Strikes',
  takedowns:       'Takedowns',
  rd1_takedowns:   'R1 Takedowns',
  knockdowns:      'Knockdowns',
  rounds:          'Rounds',
  fight_time:      'Fight Time',
  fantasy_score:   'Fantasy',
  control_time:    'Control Time',
};

// Unified leg shape across all 3 sports. Phase 100 expanded with the
// fields needed for the dislocation engine — reasonCodes drives the
// "WHY" bullets, fragility drives confidence bands + variance tier,
// momentum drives "why tonight."
type UnifiedEdge = {
  sport: Sport;
  playerId: string | number;
  // Optional alphanumeric ESPN athlete id, set on UFC edges so the
  // backend live grader can match by id instead of falling through
  // to display-name match. NBA + MLB edges leave it undefined.
  espnAthleteId?: string;
  playerName: string;
  team: string | null;
  statKey: string;       // canonical key, used for live-grade lookups
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  probability: number;
  edgePercent: number;
  trapScore: number;
  // Phase 100 fields:
  projection: number;
  reasonCodes: string[];
  fragilityScore: number | null;
  fragilityTier: string | null;
  momentumScore: number | null;
  riskScore: number | null;
  // Phase 101 — Market Intelligence Engine. Currently MLB-only on the
  // backend; NBA + WNBA fall back to derived/null values until wired.
  marketImpliedProb: number | null;
  lineInflationScore: number | null;
  publicBiasTags: string[];
  sharpnessScore: number | null;
  edgeDurability: 'stable' | 'mixed' | 'fragile' | null;
  whyMarketWrong: string | null;
  href: string;
};

export function Dashboard() {
  useTitle(['Command Center']);
  const [nba, setNba]   = useState<SlateResponse | null>(null);
  const [mlb, setMlb]   = useState<MlbDailySlateResponse | null>(null);
  const [wnba, setWnba] = useState<WnbaSlateResponse | null>(null);
  const [ufc, setUfc]   = useState<UfcSlateProjectionsResponse | null>(null);
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
        getUfcSlateProjections(),
        getMlbCalibration(7),
        getWnbaCalibration(30),
      ]);
      if (cancelled) return;
      const [nbaR, mlbR, wnbaR, ufcR, mlbCalR, wnbaCalR] = results;
      if (nbaR.status === 'fulfilled')   setNba(nbaR.value.resolved);
      if (mlbR.status === 'fulfilled')   setMlb(mlbR.value);
      if (wnbaR.status === 'fulfilled')  setWnba(wnbaR.value);
      // UFC failure is silent — don't let an Odds API blip blank the
      // dashboard when NBA + MLB still have data.
      if (ufcR.status === 'fulfilled')   setUfc(ufcR.value);
      if (mlbCalR.status === 'fulfilled') setMlbCal(mlbCalR.value);
      if (wnbaCalR.status === 'fulfilled') setWnbaCal(wnbaCalR.value);
      setLoading(false);
      setLastUpdated(new Date());
    }

    refresh();
    const interval = setInterval(refresh, 90_000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const allEdges = collectEdges(nba, mlb, wnba, ufc);
  const edges = sportFilter === 'all' ? allEdges : allEdges.filter((e) => e.sport === sportFilter);

  // Phase 145 — live verdict polling for the dashboard's visible edges.
  // Top dislocations + traps + disagreements = at most ~24 unique legs;
  // we cap at 30 to stay well under the server's 50-leg request limit.
  const [liveByKey, setLiveByKey] = useState<Map<string, EliteLegLiveState>>(new Map());
  // Build a deterministic signature so we don't re-poll on every render.
  const visibleEdges = [
    ...edges.filter((e) => e.edgePercent >= 5).slice(0, 12),
    ...edges.filter((e) => e.trapScore >= 60).slice(0, 8),
  ];
  // Dedupe by leg-id
  const dedupKey = (e: { sport: string; playerId: string | number; statLabel: string; line: number; direction: 'OVER' | 'UNDER' }) =>
    `${e.sport}::${e.playerId}::${e.statLabel}::${e.line}::${e.direction}`;
  const seen = new Set<string>();
  const uniqueVisible = visibleEdges.filter((e) => {
    const k = dedupKey(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 30);
  const visibleSig = uniqueVisible.map(dedupKey).join('|');

  useEffect(() => {
    if (uniqueVisible.length === 0) {
      setLiveByKey(new Map());
      return;
    }
    let cancelled = false;
    const tick = () => {
      // The live grader supports NBA + MLB + UFC (iter 44 wired UFC
      // via fightcenter for sig_strikes / takedowns / knockdowns /
      // control_time). WNBA is still deferred — skip those legs
      // honestly rather than fabricating verdicts.
      const payload = uniqueVisible
        .filter((e) => e.sport !== 'wnba')
        .map((e) => ({
          playerId: typeof e.playerId === 'number' ? e.playerId : Number(e.playerId),
          // UFC alphanumeric id passes through here so the grader
          // matches by id instead of name fallback.
          espnAthleteId: e.espnAthleteId,
          playerName: e.playerName,
          statKey: e.statKey,
          direction: e.direction,
          line: e.line,
        }))
        .filter((p) => Number.isFinite(p.playerId));
      if (payload.length === 0) return;
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
  }, [visibleSig]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Phase 100: rank by dislocation strength (market mispricing) NOT
  // raw hit probability. Spec directive: "stop prioritizing highest
  // hit rate, start prioritizing highest market inefficiency."
  const dislocations = edges
    .filter((e) => e.edgePercent >= 5)
    .sort((a, b) => dislocationScore(b) - dislocationScore(a));

  const traps = edges
    .filter((e) => e.trapScore >= 60)
    .sort((a, b) => b.trapScore - a.trapScore)
    .slice(0, 8);

  // Disagreements: where model probability is furthest from sportsbook
  // implied break-even. Same numeric driver as edge but framed as
  // divergence rather than "best picks." Top 8.
  const disagreements = edges
    .map((e) => ({ edge: e, divergence: Math.abs(e.edgePercent) }))
    .sort((a, b) => b.divergence - a.divergence)
    .slice(0, 8)
    .map((d) => d.edge);

  const slateStrength = computeSlateStrength(nba, mlb, wnba, ufc);
  const pressureSignals = computeMarketPressure(allEdges);
  const analystSummary = buildAnalystSummary(dislocations, traps, disagreements);

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
        <p className="muted small" style={{ marginTop: 0, marginBottom: 16 }}>
          Live quantitative war room. We rank by market dislocation, not hit rate. Every leg
          surfaces why it's mispriced, what could break it, and where the market disagrees.
        </p>

        {/* Today at a Glance — same Bloomberg ticker that pins above
            Home. Surfaces live games (per-sport split), active edges,
            today's Elite verdict, and the 30d CLV beat-rate. Self-hides
            on quiet days. Command-center users want this BEFORE the
            engine-pulse strip — it's the headline number, not the
            operational pulse. */}
        <TodayAtAGlance />

        {/* Compact engine pulse — Bloomberg-feel ticker pinned high
            so command-center users see live activity at a glance. */}
        <EnginePulseStrip />

        {/* Truth metric pinned above the war room — institutional users
            check the scoreboard before they trust the war plan. */}
        <ClvTrustBanner />

        {/* Activity feed — Elite legs + starred props that have
            settled or locked today. Same chronological 'what just
            happened to my picks' rail Home shows. Self-hides until
            something has resolved. */}
        <ActivityFeed />

        {/* AI Analyst Summary — 1-2 sentence narrative across the
            entire slate. Phase 100 spec directive #1. */}
        {!loading && analystSummary && (
          <AnalystBanner summary={analystSummary} />
        )}

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
              mma:  allEdges.filter((e) => e.sport === 'mma').length,
            }} />

            {/* SECTION 1 — Market Dislocations (was: Tonight's
                strongest edges). Card hierarchy: top 3 = HERO, next
                6 = MEDIUM, rest compact. */}
            <SectionHeader
              title="Market Dislocations"
              hint="Lines where the sportsbook's implied probability is furthest from our model's. Sorted by mispricing severity, not hit rate."
            />
            {dislocations.length === 0 ? (
              <EmptyCard text="No active dislocations detected. Slates may not be published or every line is fairly priced." />
            ) : (
              <>
                {/* Top 3 = hero treatment */}
                {dislocations.slice(0, 3).length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14, marginBottom: 16 }}>
                    {dislocations.slice(0, 3).map((e, i) => (
                      <DislocationHeroCard
                        key={`${e.sport}-${e.playerId}-${i}`}
                        edge={e}
                        rank={i + 1}
                        live={liveByKey.get(`${e.playerId}-${e.statKey}-${e.line}-${e.direction}`) ?? null}
                      />
                    ))}
                  </div>
                )}
                {/* Mid 6 = medium treatment */}
                {dislocations.slice(3, 9).length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 16 }}>
                    {dislocations.slice(3, 9).map((e, i) => (
                      <DislocationMediumCard
                        key={`${e.sport}-${e.playerId}-${i + 3}`}
                        edge={e}
                        live={liveByKey.get(`${e.playerId}-${e.statKey}-${e.line}-${e.direction}`) ?? null}
                      />
                    ))}
                  </div>
                )}
                {/* Rest = compact */}
                {dislocations.slice(9).length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginBottom: 32 }}>
                    {dislocations.slice(9, 18).map((e, i) => (
                      <DislocationCompactCard
                        key={`${e.sport}-${e.playerId}-${i + 9}`}
                        edge={e}
                        live={liveByKey.get(`${e.playerId}-${e.statKey}-${e.line}-${e.direction}`) ?? null}
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Model Disagreements — phase 100 new section. Where the
                book and our model see the world differently. */}
            <SectionHeader
              title="Model Disagreements"
              hint="Top legs where StatEdge's model probability diverges most from the sportsbook's implied break-even. Pure divergence, regardless of direction."
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 32 }}>
              {disagreements.map((e, i) => (
                <DisagreementCard
                  key={`d-${e.sport}-${e.playerId}-${i}`}
                  edge={e}
                  live={liveByKey.get(`${e.playerId}-${e.statKey}-${e.line}-${e.direction}`) ?? null}
                />
              ))}
            </div>

            {/* Market Pressure Radar — derived signals from across the
                slate. Reads like a trading-floor news feed. */}
            <SectionHeader
              title="Market Pressure Radar"
              hint="Aggregated pressure signals across tonight's slate. Derived from trap distribution, fragility clusters, and momentum spread."
            />
            {pressureSignals.length === 0 ? (
              <EmptyCard text="No active pressure signals. Tonight's board reads cleanly across model & market." />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 32 }}>
                {pressureSignals.map((s, i) => <PressureSignalCard key={i} signal={s} />)}
              </div>
            )}

            {/* Trap Watch — upgraded with model-vs-market framing. */}
            <SectionHeader
              title="Trap Watch"
              hint="Lines where recent surface stats triggered the trap detector. Each card shows our model probability vs the market's implied break-even — gaps in the WRONG direction are public-facing traps."
            />
            {traps.length === 0 ? (
              <EmptyCard text="No high-trap legs across tonight's slates. Clean board." />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 32 }}>
                {traps.map((t, i) => (
                  <TrapCard
                    key={`${t.sport}-${t.playerId}-${i}`}
                    edge={t}
                    live={liveByKey.get(`${t.playerId}-${t.statKey}-${t.line}-${t.direction}`) ?? null}
                  />
                ))}
              </div>
            )}

            <SectionHeader
              title="Slate Strength"
              hint="Per-sport leg count, average dislocation, and concentration of high-edge opportunities."
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 32 }}>
              <StrengthCard sport="nba"  data={slateStrength.nba} />
              <StrengthCard sport="mlb"  data={slateStrength.mlb} />
              <StrengthCard sport="mma"  data={slateStrength.mma} />
              <StrengthCard sport="wnba" data={slateStrength.wnba} />
            </div>

            <SectionHeader
              title="Model Health"
              hint="Predicted vs observed accuracy across the rolling window. Closer alignment = more trustworthy edge numbers."
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 32 }}>
              <HealthCard sport="mlb"  cal={mlbCal} />
              <HealthCard sport="wnba" cal={wnbaCal} />
              <NbaHealthCard nba={nba} />
            </div>
          </>
        )}

        {/* Operational pulse — counters showing the engine is
            actively running. Institutional command-center context. */}
        <EngineStatus />

        {/* Cross-sport latest articles — closes the Command Center
            with auto-content surfaced where the institutional user
            ends a session. Same pattern as Home, no sport filter. */}
        <LatestNewsRail limit={4} heading="Latest from the Engine" />
      </div>
    </div>
  );
}

// ---------- Data layer ----------

function collectEdges(
  nba: SlateResponse | null,
  mlb: MlbDailySlateResponse | null,
  wnba: WnbaSlateResponse | null,
  ufc: UfcSlateProjectionsResponse | null,
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
          statKey: l.statKey,
          statLabel: l.statLabel,
          line: l.line,
          direction: l.direction,
          probability: l.probability,
          edgePercent: l.edgePercent ?? 0,
          trapScore: l.trapScore ?? 0,
          projection: l.projection,
          reasonCodes: [],
          fragilityScore: l.fragilityScore ?? null,
          fragilityTier: l.fragilityTier ?? null,
          momentumScore: null,
          riskScore: l.risk ?? null,
          // NBA — Phase 101b wired through slateCombos. Legacy snapshots
          // pre-dating this layer fall back to null.
          marketImpliedProb: l.marketImpliedProb ?? null,
          lineInflationScore: l.lineInflationScore ?? null,
          publicBiasTags: l.publicBiasTags ?? [],
          sharpnessScore: l.sharpnessScore ?? null,
          edgeDurability: l.edgeDurability ?? null,
          whyMarketWrong: l.whyMarketWrong ?? null,
          href: `/nba/compare?m=last10&pid=${l.playerId}`,
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
          statKey: l.statKey,
          statLabel: l.statLabel,
          line: l.line,
          direction: l.direction,
          probability: l.probability,
          edgePercent: l.edgePercent,
          trapScore: l.trapScore,
          projection: l.projection,
          reasonCodes: l.reasonCodes ?? [],
          fragilityScore: l.fragilityScore ?? null,
          fragilityTier: l.fragilityTier ?? null,
          momentumScore: l.momentumExpansionScore ?? null,
          riskScore: l.riskScore ?? null,
          // MLB — Phase 101 fields wired. Fall back to null for legacy
          // snapshots that pre-date the marketIntel layer.
          marketImpliedProb: l.marketImpliedProb ?? null,
          lineInflationScore: l.lineInflationScore ?? null,
          publicBiasTags: l.publicBiasTags ?? [],
          sharpnessScore: l.sharpnessScore ?? null,
          edgeDurability: l.edgeDurability ?? null,
          whyMarketWrong: l.whyMarketWrong ?? null,
          href: `/mlb/player/${l.playerId}`,
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
        statKey: l.statKey,
        statLabel: l.statLabel,
        line: l.line,
        direction: l.direction,
        probability: l.probability,
        edgePercent: l.edgePercent,
        trapScore: l.trapScore,
        projection: l.projection,
        reasonCodes: l.reasonCodes ?? [],
        fragilityScore: l.fragilityScore ?? null,
        fragilityTier: null,
        momentumScore: l.momentumScore ?? null,
        riskScore: null,
        // WNBA — Phase 101c wired through projection.ts. Legacy
        // snapshots pre-dating this layer fall back to null.
        marketImpliedProb: l.marketImpliedProb ?? null,
        lineInflationScore: l.lineInflationScore ?? null,
        publicBiasTags: l.publicBiasTags ?? [],
        sharpnessScore: l.sharpnessScore ?? null,
        edgeDurability: l.edgeDurability ?? null,
        whyMarketWrong: l.whyMarketWrong ?? null,
        href: `/wnba/compare?aid=${encodeURIComponent(l.athleteId)}`,
      });
    }
  }

  // UFC — moneyline-anchored heuristic engine output (Phase 136 /
  // iter 64). The dislocation engine ranks across all sports on the
  // same edgePercent + probability scale, so UFC rows are eligible
  // for the dislocation / disagreement / trap surfaces just like
  // NBA + MLB. Honest about its limits: many Phase-101 fields stay
  // null because the heuristic engine doesn't produce them yet
  // (lineInflationScore, sharpnessScore, edgeDurability, etc.).
  if (ufc?.projections) {
    const seen = new Set<string>();
    for (const p of ufc.projections) {
      const key = `${p.fighterName}::${p.statKey}::${p.line}::${p.modelDirection}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        sport: 'mma',
        playerId: p.espnAthleteId ?? 0,
        espnAthleteId: p.espnAthleteId ?? undefined,
        playerName: p.fighterName,
        team: p.opponentName ? `vs ${p.opponentName}` : null,
        statKey: p.statKey,
        statLabel: UFC_STAT_LABEL[p.statKey] ?? p.statKey,
        line: p.line,
        direction: p.modelDirection,
        probability: p.probability,
        edgePercent: p.edgePercent,
        trapScore: p.trapScore,
        projection: p.projectionValue,
        reasonCodes: p.rationale ?? [],
        fragilityScore: p.fragilityScore,
        fragilityTier: null,
        momentumScore: null,
        riskScore: null,
        // Heuristic engine derives implied prob from the de-vigged
        // moneyline; surface it so the dislocation math compares
        // honestly against NBA + MLB rows.
        marketImpliedProb: p.fairProbability !== null ? p.fairProbability * 100 : null,
        lineInflationScore: null,
        publicBiasTags: [],
        sharpnessScore: null,
        edgeDurability: null,
        whyMarketWrong: null,
        href: p.espnAthleteId ? `/mma/fighter/${p.espnAthleteId}` : '/mma/slate',
      });
    }
  }

  return out;
}

// ---------- Quant helpers ----------

// Dislocation strength = how mispriced is this line, weighted by
// distance from coin-flip. Edge alone isn't enough — a +25% edge on a
// 51% pick is real but small relative to a +20% edge on a 70% pick
// where conviction is higher and the line is bookable.
function dislocationScore(e: UnifiedEdge): number {
  const distanceFromCoinflip = Math.abs(e.probability - 50) / 50;  // 0-1
  const edgeStrength = Math.abs(e.edgePercent) / 30;               // 0-1+ at +30%
  return edgeStrength * 0.7 + distanceFromCoinflip * 0.3;
}

// Sportsbook implied break-even. Phase 101: prefer the backend's
// computed marketImpliedProb (which is the same math but authoritative);
// fall back to the local derivation for legacy snapshots and sports
// not yet wired through marketIntel.ts.
function marketImplied(e: UnifiedEdge): number {
  if (e.marketImpliedProb !== null && e.marketImpliedProb !== undefined) {
    return e.marketImpliedProb;
  }
  const raw = e.probability - e.edgePercent;
  return Math.max(1, Math.min(99, raw));
}

// Confidence band: surface honest uncertainty as a ± range. We don't
// have a true posterior so we synthesize a band from fragility.
// Fragile legs get wider bands (±10), solid legs get tight bands (±3).
// Mission directive: "reduce fake perfectness."
function confidenceBand(e: UnifiedEdge): { low: number; high: number; width: number } {
  const f = e.fragilityScore ?? 50;
  const halfWidth = Math.max(2.5, Math.min(11, f / 10 + 2));
  return {
    low: Math.max(1, e.probability - halfWidth),
    high: Math.min(99, e.probability + halfWidth),
    width: halfWidth,
  };
}

// Variance label from fragility. Mirrors the Phase 100 spec
// directive: "real institutional models show variance."
function varianceLabel(e: UnifiedEdge): { label: string; color: string } {
  const f = e.fragilityScore ?? 50;
  if (f <= 30) return { label: 'LOW VARIANCE',  color: '#66bb6a' };
  if (f <= 55) return { label: 'MED VARIANCE',  color: '#7aa2ff' };
  if (f <= 75) return { label: 'HIGH VARIANCE', color: '#ffb74d' };
  return         { label: 'EXTREME VARIANCE',   color: '#ef5350' };
}

// Data quality tags. Phase 101: when the backend marketIntel layer
// emitted explicit publicBiasTags, those WIN over derived ones (more
// authoritative). Falls back to derivation for sports not yet wired.
function qualityTags(e: UnifiedEdge): string[] {
  const tags: string[] = [];

  // Backend-emitted bias tags — render verbatim. These are
  // authoritative and humanized (STAR_TAX → "STAR TAX").
  for (const t of e.publicBiasTags) {
    tags.push(t.replace(/_/g, ' '));
  }

  // Edge durability — surface explicitly when present.
  if (e.edgeDurability === 'stable')   tags.push('STABLE EDGE');
  if (e.edgeDurability === 'fragile')  tags.push('FRAGILE EDGE');

  // Fallback heuristics for legs without backend tags (NBA + WNBA).
  if (e.publicBiasTags.length === 0) {
    if ((e.momentumScore ?? 0) >= 70)              tags.push('MOMENTUM DRIVEN');
    if ((e.fragilityScore ?? 50) >= 60)            tags.push('VOLATILE ROLE');
    if (e.trapScore >= 60)                          tags.push('PUBLIC HEAVY');
    if (Math.abs(e.edgePercent) >= 20)              tags.push('MARKET DIVERGENT');
    if (e.reasonCodes.some((r) => /matchup|opponent|park|weather/i.test(r))) tags.push('MATCHUP DRIVEN');
    if (e.reasonCodes.some((r) => /thin sample|low.*conf/i.test(r))) tags.push('LOW SAMPLE');
  }
  return tags;
}

// "Why this edge exists" — humanized signals. Pulls from reasonCodes
// when present, falls back to derived signals from numeric fields.
function buildEdgeReasons(e: UnifiedEdge): string[] {
  const reasons: string[] = [];
  // Use up to 5 model-generated reasonCodes if available.
  for (const rc of e.reasonCodes.slice(0, 5)) reasons.push(rc);
  if (reasons.length >= 3) return reasons.slice(0, 5);

  // Synthesized fallbacks when reasonCodes are sparse:
  const projGap = e.projection - e.line;
  if (e.direction === 'OVER' && projGap > 0) {
    reasons.push(`Projection ${e.projection.toFixed(1)} vs line ${e.line} — ${projGap.toFixed(1)} above the line.`);
  } else if (e.direction === 'UNDER' && projGap < 0) {
    reasons.push(`Projection ${e.projection.toFixed(1)} vs line ${e.line} — ${Math.abs(projGap).toFixed(1)} below the line.`);
  }
  if (Math.abs(e.edgePercent) >= 15) {
    reasons.push(`Market implied ${marketImplied(e).toFixed(0)}% — model says ${e.probability.toFixed(0)}%. ${e.edgePercent >= 0 ? 'Underpriced' : 'Overpriced'} by ${Math.abs(e.edgePercent).toFixed(0)}%.`);
  }
  if ((e.momentumScore ?? 0) >= 65) {
    reasons.push(`Momentum signal: recent form well above season baseline.`);
  }
  return reasons.slice(0, 5);
}

// "Why this might fail" — risk side honest surfacing.
function buildRiskReasons(e: UnifiedEdge): string[] {
  const out: string[] = [];
  if (e.trapScore >= 60) {
    out.push(`Trap score ${Math.round(e.trapScore)} — recent spike + line inflation pattern.`);
  }
  if ((e.fragilityScore ?? 0) >= 60) {
    out.push(`High variance: fragility ${Math.round(e.fragilityScore ?? 0)} — projection is volatile.`);
  }
  if ((e.riskScore ?? 0) >= 65) {
    out.push(`Composite risk score ${Math.round(e.riskScore ?? 0)} — multiple risk factors stacked.`);
  }
  if (e.probability < 55 && e.probability > 45) {
    out.push(`Coin-flip exposure: ${Math.round(e.probability)}% — single outcome carries meaningful downside.`);
  }
  return out;
}

// AI Analyst summary — 1-2 sentence narrative across the entire slate.
// Synthesized from the strongest dislocations + traps + disagreement
// patterns. Reads like a trading-desk morning brief.
function buildAnalystSummary(
  dislocations: UnifiedEdge[],
  traps: UnifiedEdge[],
  disagreements: UnifiedEdge[],
): string | null {
  if (dislocations.length === 0 && traps.length === 0) return null;
  const parts: string[] = [];

  if (dislocations.length > 0) {
    const top = dislocations[0]!;
    const bySportCount = new Map<Sport, number>();
    for (const e of dislocations.slice(0, 10)) bySportCount.set(e.sport, (bySportCount.get(e.sport) ?? 0) + 1);
    const sportEntries = [...bySportCount.entries()].sort((a, b) => b[1] - a[1]);
    const dominantSport = sportEntries[0]?.[0];
    parts.push(
      `Tonight's strongest dislocation: ${top.playerName} ${top.statLabel} ${top.line} ${top.direction === 'OVER' ? '↑' : '↓'} (${SPORT_LABEL[top.sport]}) — model ${Math.round(top.probability)}% vs market ${Math.round(marketImplied(top))}%, +${Math.abs(top.edgePercent).toFixed(0)}% mispricing.`,
    );
    if (sportEntries.length > 1 && dominantSport) {
      parts.push(
        `${SPORT_LABEL[dominantSport]} concentration: ${sportEntries[0]![1]} of top 10 dislocations sit in ${SPORT_LABEL[dominantSport]}.`,
      );
    }
  }

  if (traps.length > 0) {
    const trapTop = traps[0]!;
    parts.push(
      `Trap watch: ${trapTop.playerName} ${trapTop.statLabel} ${trapTop.line} flagging score ${Math.round(trapTop.trapScore)} — public-facing inflation pattern, treat with caution.`,
    );
  }

  // High-divergence callout when the disagreement leader isn't already
  // surfaced as the dislocation leader.
  if (disagreements.length > 0 && dislocations.length > 0) {
    const leader = disagreements[0]!;
    const dislocLeader = dislocations[0]!;
    if (leader.playerId !== dislocLeader.playerId) {
      parts.push(
        `Highest market disagreement on the board: ${leader.playerName} (${SPORT_LABEL[leader.sport]}) — ${Math.abs(leader.edgePercent).toFixed(0)}% gap vs market.`,
      );
    }
  }

  return parts.join(' ');
}

// Market pressure signals derived from the slate distribution. These
// are NOT line-history signals (we don't have a market feed) — they're
// inferences from how our model output clusters relative to baselines.
type PressureSignal = {
  level: 'critical' | 'elevated' | 'note';
  title: string;
  detail: string;
};

function computeMarketPressure(edges: UnifiedEdge[]): PressureSignal[] {
  const out: PressureSignal[] = [];
  if (edges.length === 0) return out;

  const heavyTraps = edges.filter((e) => e.trapScore >= 70).length;
  if (heavyTraps >= 3) {
    out.push({
      level: 'critical',
      title: 'Trap inflation cluster',
      detail: `${heavyTraps} legs flagging trap score ≥70 — public-facing recency-spike pattern. Sportsbook is leaning into a narrative the model doesn't agree with.`,
    });
  }

  const bigDivergence = edges.filter((e) => Math.abs(e.edgePercent) >= 20).length;
  if (bigDivergence >= 3) {
    out.push({
      level: 'elevated',
      title: 'Wide model-vs-market gap',
      detail: `${bigDivergence} legs with ≥20% divergence. Tonight's lines are pricing scenarios the model assigns much lower or higher probability to.`,
    });
  }

  const fragileCluster = edges.filter((e) => (e.fragilityScore ?? 0) >= 65).length;
  if (fragileCluster >= 5) {
    out.push({
      level: 'note',
      title: 'Volatile player pool',
      detail: `${fragileCluster} legs sit in fragile/volatile-role tier. Variance dominates conviction tonight; size cards smaller.`,
    });
  }

  const momentum = edges.filter((e) => (e.momentumScore ?? 0) >= 70).length;
  if (momentum >= 4) {
    out.push({
      level: 'note',
      title: 'Momentum cluster',
      detail: `${momentum} legs riding strong recent-form expansion. Watch for trap risk if any of these crossed into "public hammer" territory.`,
    });
  }

  return out;
}

type StrengthData = {
  legs: number;
  avgEdge: number;
  highEdgeCount: number;
};

function computeSlateStrength(
  nba: SlateResponse | null,
  mlb: MlbDailySlateResponse | null,
  wnba: WnbaSlateResponse | null,
  ufc: UfcSlateProjectionsResponse | null,
): { nba: StrengthData; mlb: StrengthData; wnba: StrengthData; mma: StrengthData } {
  function rollup(edges: UnifiedEdge[]): StrengthData {
    if (edges.length === 0) return { legs: 0, avgEdge: 0, highEdgeCount: 0 };
    const sumEdge = edges.reduce((s, e) => s + e.edgePercent, 0);
    return {
      legs: edges.length,
      avgEdge: sumEdge / edges.length,
      highEdgeCount: edges.filter((e) => e.edgePercent >= 10).length,
    };
  }
  const all = collectEdges(nba, mlb, wnba, ufc);
  return {
    nba:  rollup(all.filter((e) => e.sport === 'nba')),
    mlb:  rollup(all.filter((e) => e.sport === 'mlb')),
    wnba: rollup(all.filter((e) => e.sport === 'wnba')),
    mma:  rollup(all.filter((e) => e.sport === 'mma')),
  };
}

// ---------- UI components ----------

function AnalystBanner({ summary }: { summary: string }) {
  return (
    <div
      style={{
        margin: '12px 0 20px',
        padding: '12px 14px',
        background: 'linear-gradient(135deg, rgba(122, 162, 255, 0.08) 0%, rgba(102, 187, 106, 0.06) 50%, rgba(179, 136, 255, 0.08) 100%)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderLeft: '3px solid #ffd54f',
        borderRadius: 6,
        display: 'flex',
        gap: 10,
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.08em',
          color: '#ffd54f',
          padding: '2px 6px',
          background: 'rgba(255, 213, 79, 0.12)',
          borderRadius: 3,
          height: 'fit-content',
          flexShrink: 0,
        }}
      >
        ANALYST
      </span>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>{summary}</p>
    </div>
  );
}

function SportFilterTabs({
  value,
  onChange,
  counts,
}: {
  value: Sport | 'all';
  onChange: (v: Sport | 'all') => void;
  counts: { all: number; nba: number; mlb: number; wnba: number; mma: number };
}) {
  // Tab order matches the 2026-05-09 sport-priorities decision —
  // focus sports (NBA, MLB, UFC) lead and WNBA sits last on
  // maintenance.
  const TABS: Array<{ key: Sport | 'all'; label: string; color: string }> = [
    { key: 'all',  label: 'All',  color: '#cccccc' },
    { key: 'nba',  label: 'NBA',  color: SPORT_COLOR.nba },
    { key: 'mlb',  label: 'MLB',  color: SPORT_COLOR.mlb },
    { key: 'mma',  label: 'UFC',  color: SPORT_COLOR.mma },
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

// ---------- Dislocation cards ----------

function DislocationHeroCard({ edge, rank, live }: { edge: UnifiedEdge; rank: number; live: EliteLegLiveState | null }) {
  const color = SPORT_COLOR[edge.sport];
  const band = confidenceBand(edge);
  const variance = varianceLabel(edge);
  const tags = qualityTags(edge);
  const reasons = buildEdgeReasons(edge);
  const risks = buildRiskReasons(edge);
  const implied = marketImplied(edge);

  return (
    <Link
      to={edge.href}
      style={{
        display: 'block',
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${color}55`,
        borderLeft: `4px solid ${color}`,
        borderRadius: 8,
        padding: '14px 16px',
        textDecoration: 'none',
        color: 'inherit',
        position: 'relative',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 10,
          right: 12,
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.08em',
          color: 'rgba(255,255,255,0.4)',
        }}
      >
        #{rank} DISLOCATION
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <SportAvatar edge={edge} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>{edge.playerName}</div>
          <div className="muted small" style={{ fontSize: 11 }}>
            <span style={{ color, fontWeight: 700 }}>{SPORT_LABEL[edge.sport]}</span>
            {edge.team && <span> · {edge.team}</span>}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 10, fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>{edge.statLabel} {edge.line} {edge.direction === 'OVER' ? '↑' : '↓'}</span>
        <LiveVerdictPill state={live} compact />
      </div>

      {/* Model vs market */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
          padding: '8px 10px',
          background: 'rgba(0,0,0,0.2)',
          borderRadius: 4,
          marginBottom: 10,
        }}
      >
        <div>
          <div className="muted small" style={{ fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Model</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#66bb6a' }}>{Math.round(edge.probability)}%</div>
          <div className="muted small" style={{ fontSize: 10 }}>
            band {band.low.toFixed(0)}–{band.high.toFixed(0)}%
          </div>
        </div>
        <div>
          <div className="muted small" style={{ fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Market implied</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'rgba(255,255,255,0.65)' }}>{Math.round(implied)}%</div>
          <div className="muted small" style={{ fontSize: 10, color: edge.edgePercent >= 0 ? '#66bb6a' : '#ef5350' }}>
            {edge.edgePercent >= 0 ? '+' : ''}{edge.edgePercent.toFixed(0)}% mispricing
          </div>
        </div>
      </div>

      {/* "Why the market may be wrong" — Phase 101 moat narrative.
          Backend-generated single sentence that explains the
          structural read on this edge. Renders ABOVE the engine
          reasons because it's the highest-signal layer. */}
      {edge.whyMarketWrong && (
        <div
          style={{
            marginBottom: 10,
            padding: '8px 10px',
            background: 'rgba(255, 213, 79, 0.06)',
            border: '1px solid rgba(255, 213, 79, 0.2)',
            borderLeft: '2px solid #ffd54f',
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', color: '#ffd54f', marginRight: 6 }}>
            WHY MARKET MAY BE WRONG
          </span>
          <span style={{ color: 'rgba(255,255,255,0.9)' }}>{edge.whyMarketWrong}</span>
        </div>
      )}

      {/* WHY THIS EDGE EXISTS */}
      {reasons.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color, marginBottom: 4 }}>
            WHY
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.5, color: 'rgba(255,255,255,0.85)' }}>
            {reasons.map((r, i) => <li key={i} style={{ marginBottom: 2 }}>{r}</li>)}
          </ul>
        </div>
      )}

      {/* RISK */}
      {risks.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color: '#ef5350', marginBottom: 4 }}>
            RISK
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.5, color: 'rgba(255,255,255,0.7)' }}>
            {risks.map((r, i) => <li key={i} style={{ marginBottom: 2 }}>{r}</li>)}
          </ul>
        </div>
      )}

      {/* Tag row */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.06em',
            padding: '2px 6px',
            background: `${variance.color}1a`,
            color: variance.color,
            border: `1px solid ${variance.color}33`,
            borderRadius: 3,
          }}
        >
          {variance.label}
        </span>
        {/* Sharpness — Phase 101. Sharpness ≥ 65 = institutional-grade
            edge robustness; ≤ 35 = thin support, watch for fragility. */}
        {edge.sharpnessScore !== null && (
          <span
            title="Sharpness 0-100. Composite of low fragility, low trap, reason-code richness, and conviction distance from coin-flip. Higher = edge has stronger underlying support."
            style={{
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: '0.06em',
              padding: '2px 6px',
              background: edge.sharpnessScore >= 65 ? 'rgba(102,187,106,0.12)'
                : edge.sharpnessScore >= 45 ? 'rgba(122,162,255,0.12)'
                : 'rgba(255,183,77,0.12)',
              color: edge.sharpnessScore >= 65 ? '#66bb6a'
                : edge.sharpnessScore >= 45 ? '#7aa2ff'
                : '#ffb74d',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 3,
            }}
          >
            SHARP {edge.sharpnessScore}
          </span>
        )}
        {tags.map((t, i) => (
          <span
            key={i}
            style={{
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: '0.06em',
              padding: '2px 6px',
              background: 'rgba(255,255,255,0.05)',
              color: 'rgba(255,255,255,0.6)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 3,
            }}
          >
            {t}
          </span>
        ))}
      </div>
    </Link>
  );
}

function DislocationMediumCard({ edge, live }: { edge: UnifiedEdge; live: EliteLegLiveState | null }) {
  const color = SPORT_COLOR[edge.sport];
  const band = confidenceBand(edge);
  const variance = varianceLabel(edge);
  const reasons = buildEdgeReasons(edge).slice(0, 3);
  const implied = marketImplied(edge);

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
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

      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span>{edge.statLabel} {edge.line} {edge.direction === 'OVER' ? '↑' : '↓'}</span>
        <LiveVerdictPill state={live} compact />
      </div>

      <div
        style={{
          fontSize: 11,
          color: 'rgba(255,255,255,0.7)',
          marginBottom: 6,
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
        }}
      >
        Model {Math.round(edge.probability)}% (±{band.width.toFixed(0)}) vs Market {Math.round(implied)}%
        <span style={{ color: edge.edgePercent >= 0 ? '#66bb6a' : '#ef5350', marginLeft: 6, fontWeight: 700 }}>
          {edge.edgePercent >= 0 ? '+' : ''}{edge.edgePercent.toFixed(0)}%
        </span>
      </div>

      {reasons.length > 0 && (
        <ul style={{ margin: '6px 0 8px', paddingLeft: 16, fontSize: 11, lineHeight: 1.45, color: 'rgba(255,255,255,0.7)' }}>
          {reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}

      <span
        style={{
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.06em',
          padding: '2px 6px',
          background: `${variance.color}1a`,
          color: variance.color,
          border: `1px solid ${variance.color}33`,
          borderRadius: 3,
        }}
      >
        {variance.label}
      </span>
    </Link>
  );
}

function DislocationCompactCard({ edge, live }: { edge: UnifiedEdge; live: EliteLegLiveState | null }) {
  const color = SPORT_COLOR[edge.sport];
  return (
    <Link
      to={edge.href}
      style={{
        display: 'block',
        background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${color}22`,
        borderLeft: `2px solid ${color}`,
        borderRadius: 4,
        padding: 8,
        textDecoration: 'none',
        color: 'inherit',
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {edge.playerName}
        </span>
        <span style={{ color: edge.edgePercent >= 0 ? '#66bb6a' : '#ef5350', fontWeight: 800 }}>
          {edge.edgePercent >= 0 ? '+' : ''}{edge.edgePercent.toFixed(0)}%
        </span>
      </div>
      <div className="muted small" style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span>{edge.statLabel} {edge.line} {edge.direction === 'OVER' ? '↑' : '↓'} · {SPORT_LABEL[edge.sport]}</span>
        <LiveVerdictPill state={live} compact />
      </div>
    </Link>
  );
}

// ---------- Disagreement cards ----------

function DisagreementCard({ edge, live }: { edge: UnifiedEdge; live: EliteLegLiveState | null }) {
  const color = SPORT_COLOR[edge.sport];
  const implied = marketImplied(edge);
  const variance = varianceLabel(edge);
  return (
    <Link
      to={edge.href}
      style={{
        display: 'block',
        background: 'rgba(255,213,79,0.04)',
        border: '1px solid rgba(255,213,79,0.2)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: 12,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
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
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span>{edge.statLabel} {edge.line} {edge.direction === 'OVER' ? '↑' : '↓'}</span>
        <LiveVerdictPill state={live} compact />
      </div>
      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: 8,
          background: 'rgba(0,0,0,0.2)',
          borderRadius: 4,
          marginBottom: 6,
        }}
      >
        <div style={{ flex: 1 }}>
          <div className="muted small" style={{ fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase' }}>StatEdge</div>
          <strong style={{ fontSize: 14, color: '#66bb6a' }}>{Math.round(edge.probability)}%</strong>
        </div>
        <div style={{ flex: 1 }}>
          <div className="muted small" style={{ fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Market</div>
          <strong style={{ fontSize: 14, color: 'rgba(255,255,255,0.65)' }}>{Math.round(implied)}%</strong>
        </div>
        <div style={{ flex: 1 }}>
          <div className="muted small" style={{ fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Δ</div>
          <strong style={{ fontSize: 14, color: edge.edgePercent >= 0 ? '#66bb6a' : '#ef5350' }}>
            {edge.edgePercent >= 0 ? '+' : ''}{edge.edgePercent.toFixed(0)}%
          </strong>
        </div>
      </div>
      <span
        style={{
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.06em',
          padding: '2px 6px',
          background: `${variance.color}1a`,
          color: variance.color,
          border: `1px solid ${variance.color}33`,
          borderRadius: 3,
        }}
      >
        {variance.label}
      </span>
    </Link>
  );
}

// ---------- Trap card (institutional rebuild) ----------

function TrapCard({ edge, live }: { edge: UnifiedEdge; live: EliteLegLiveState | null }) {
  const color = SPORT_COLOR[edge.sport];
  const implied = marketImplied(edge);
  const reasons = buildRiskReasons(edge);
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <SportAvatar edge={edge} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{edge.playerName}</div>
          <div className="muted small" style={{ fontSize: 11 }}>
            <span style={{ color, fontWeight: 700 }}>{SPORT_LABEL[edge.sport]}</span>
            {edge.team && <span> · {edge.team}</span>}
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
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

      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span>{edge.statLabel} {edge.line} {edge.direction === 'OVER' ? '↑' : '↓'}</span>
        <LiveVerdictPill state={live} compact />
      </div>

      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: 8,
          background: 'rgba(0,0,0,0.2)',
          borderRadius: 4,
          marginBottom: 8,
        }}
      >
        <div>
          <div className="muted small" style={{ fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Model</div>
          <strong style={{ fontSize: 14, color: '#66bb6a' }}>{Math.round(edge.probability)}%</strong>
        </div>
        <div>
          <div className="muted small" style={{ fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Market</div>
          <strong style={{ fontSize: 14, color: '#ffb74d' }}>{Math.round(implied)}%</strong>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <div className="muted small" style={{ fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Read</div>
          <strong style={{ fontSize: 12, color: implied > edge.probability ? '#ef5350' : '#66bb6a' }}>
            {implied > edge.probability ? 'Inflated' : 'Suppressed'}
          </strong>
        </div>
      </div>

      {reasons.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, lineHeight: 1.45, color: 'rgba(255,255,255,0.65)' }}>
          {reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
    </Link>
  );
}

// ---------- Pressure signal card ----------

function PressureSignalCard({ signal }: { signal: PressureSignal }) {
  const color = signal.level === 'critical' ? '#ef5350'
    : signal.level === 'elevated' ? '#ffb74d'
    : '#7aa2ff';
  const label = signal.level === 'critical' ? 'CRITICAL' : signal.level === 'elevated' ? 'ELEVATED' : 'NOTE';
  return (
    <div
      style={{
        background: `${color}0d`,
        border: `1px solid ${color}33`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', color }}>{label}</span>
        <strong style={{ fontSize: 13 }}>{signal.title}</strong>
      </div>
      <p className="muted small" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
        {signal.detail}
      </p>
    </div>
  );
}

// ---------- Avatars + strength + health (carry-over) ----------

function SportAvatar({ edge }: { edge: UnifiedEdge }) {
  if (edge.sport === 'mlb' && typeof edge.playerId === 'number') {
    return <MlbPlayerAvatar playerId={edge.playerId} name={edge.playerName} size="md" />;
  }
  if (edge.sport === 'nba' && typeof edge.playerId === 'number') {
    return <PlayerAvatar playerId={edge.playerId} name={edge.playerName} size="md" />;
  }
  if (edge.sport === 'mma') {
    // UFC fighter ESPN id stored as string in playerId (or 0 when
    // unresolved). UfcFighterAvatar handles the missing-id fallback
    // to initials internally — no need to gate here.
    return <UfcFighterAvatar athleteId={String(edge.playerId)} name={edge.playerName} size="md" />;
  }
  return <WnbaPlayerAvatar playerId={String(edge.playerId)} name={edge.playerName} size="md" />;
}

function StrengthCard({ sport, data }: { sport: Sport; data: StrengthData }) {
  const color = SPORT_COLOR[sport];
  const tier = data.legs === 0 ? 'No slate'
    : data.avgEdge >= 8 ? 'Strong'
    : data.avgEdge >= 4 ? 'Moderate'
    : 'Light';
  const slatePath =
    sport === 'nba'  ? '/nba/slate'
    : sport === 'mlb' ? '/mlb/slate'
    : sport === 'mma' ? '/mma/slate'
    : '/wnba/slate';
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
      to="/nba/calibration"
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
        Open the calibration page for full predicted-vs-observed buckets.
      </p>
    </Link>
  );
}
