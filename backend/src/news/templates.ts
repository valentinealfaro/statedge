// Article templates — Phase 104.
//
// Pure-function generators. Each takes the data it needs and returns
// an ArticleDraft. NO DB writes, NO network. Caller persists the
// drafts via store.ts upsertArticle.
//
// Why pure: trivially testable + composable. The cron orchestrator
// fetches data once, runs every relevant template against it, then
// upserts the batch. Keeps article-shape iteration cheap.

import { mlbPlayerHeadshotUrl } from './images.js';
import type { ArticleDraft } from './types.js';
import { articleSlug, slugify } from './types.js';

// Shape of a unified leg, as collected by the Dashboard's collectEdges
// or the slate engine. Templates accept this shape directly to keep
// callers from having to massage data.
export type EdgeLeg = {
  sport: 'mlb' | 'nba' | 'wnba';
  playerId: number | string;
  playerName: string;
  team: string | null;
  statLabel: string;
  line: number;
  direction: 'OVER' | 'UNDER';
  probability: number;
  edgePercent: number;
  trapScore: number;
  projection: number;
  // Phase 101 market intel fields. Optional — older snapshots don't
  // have them; templates handle null gracefully.
  marketImpliedProb?: number | null;
  publicBiasTags?: string[];
  sharpnessScore?: number | null;
  edgeDurability?: 'stable' | 'mixed' | 'fragile' | null;
  whyMarketWrong?: string | null;
  reasonCodes?: string[];
};

// ---------- Tonight's Top Mispricings (cross-sport) ----------
//
// Top 5 dislocations across all sports tonight, with model-vs-market
// and bias tags. Ranks by abs(edgePercent) — pure mispricing strength.

export function generateTopMispricings(opts: {
  edges: EdgeLeg[];
  date: string;            // YYYY-MM-DD ET
}): ArticleDraft | null {
  const top = [...opts.edges]
    .filter((e) => Math.abs(e.edgePercent) >= 8)
    .sort((a, b) => Math.abs(b.edgePercent) - Math.abs(a.edgePercent))
    .slice(0, 5);

  if (top.length === 0) return null;

  const slug = articleSlug({ kind: 'top_mispricings', date: opts.date });
  const summary = `${top.length} of tonight's biggest market dislocations across MLB, NBA, and WNBA — where our model says the line is most mispriced.`;

  const lines: string[] = [];
  lines.push(`# Tonight's ${top.length} Biggest Market Dislocations`);
  lines.push('');
  lines.push(`*${humanDate(opts.date)} — Updated at slate publish.*`);
  lines.push('');
  lines.push(summary);
  lines.push('');
  lines.push('Each pick below includes the StatEdge model probability, the sportsbook\'s implied probability, the mispricing magnitude, and our market-intelligence read. The market may correct these lines before tipoff — sharper edges decay fastest.');
  lines.push('');

  top.forEach((e, i) => {
    const implied = e.marketImpliedProb ?? Math.max(1, Math.min(99, e.probability - e.edgePercent));
    const arrow = e.direction === 'OVER' ? '↑' : '↓';
    const tags = (e.publicBiasTags ?? []).map((t) => t.replace(/_/g, ' ')).join(' · ');
    lines.push(`## ${i + 1}. ${e.playerName} ${arrow} ${e.statLabel} ${e.line}`);
    lines.push('');
    lines.push(`**${e.sport.toUpperCase()}**${e.team ? ` · ${e.team}` : ''}`);
    lines.push('');
    lines.push(`| | StatEdge | Market | Mispricing |`);
    lines.push(`|---|---|---|---|`);
    lines.push(`| Probability | ${Math.round(e.probability)}% | ${Math.round(implied)}% | ${e.edgePercent >= 0 ? '+' : ''}${e.edgePercent.toFixed(1)}% |`);
    lines.push(`| Projection | ${e.projection.toFixed(1)} | line ${e.line} | gap ${(e.projection - e.line).toFixed(1)} |`);
    lines.push('');
    if (e.whyMarketWrong) {
      lines.push(`**Why the market may be wrong:** ${e.whyMarketWrong}`);
      lines.push('');
    }
    if (tags) {
      lines.push(`*Tags: ${tags}*`);
      lines.push('');
    }
    if (e.sharpnessScore !== null && e.sharpnessScore !== undefined) {
      lines.push(`*Sharpness ${e.sharpnessScore}/100${e.edgeDurability ? ` · ${e.edgeDurability.toUpperCase()} edge` : ''}.*`);
      lines.push('');
    }
  });

  lines.push('---');
  lines.push('');
  lines.push('*StatEdge ranks props by market dislocation, not hit rate. A 70% pick at a 70% line is a coin flip; a 60% pick at a 50% line is +10% edge. Lines move; check the live dashboard before sizing.*');

  // Hero image: top dislocation's player headshot (most attention-grabbing).
  const heroImage = pickHeroImage(top[0]!);

  return {
    slug,
    kind: 'top_mispricings',
    sport: 'cross',
    title: `Tonight's ${top.length} Biggest Market Dislocations · ${humanDate(opts.date)}`,
    summary,
    bodyMd: lines.join('\n'),
    heroImageUrl: heroImage,
    videoYoutubeId: null,
    relatedPlayerId: String(top[0]!.playerId),
    relatedGameKey: null,
    expiresAt: endOfDayIso(opts.date),
  };
}

// ---------- Trap Watch (per sport) ----------
//
// Top trap-flagged props for one sport tonight. Different framing
// than Top Mispricings — these are picks the public is hammering
// where our model says "fade." Useful audience: bettors looking
// for under-the-radar fades.

export function generateTrapWatch(opts: {
  edges: EdgeLeg[];
  sport: 'mlb' | 'nba' | 'wnba';
  date: string;
}): ArticleDraft | null {
  const traps = opts.edges
    .filter((e) => e.sport === opts.sport && e.trapScore >= 60)
    .sort((a, b) => b.trapScore - a.trapScore)
    .slice(0, 5);
  if (traps.length === 0) return null;

  const slug = articleSlug({ kind: 'trap_watch', date: opts.date, sport: opts.sport });
  const sportLabel = opts.sport.toUpperCase();
  const summary = `${traps.length} ${sportLabel} props flagged with trap-score ≥60 — public-facing lines our model says are mispriced for the wrong side.`;

  const lines: string[] = [];
  lines.push(`# ${sportLabel} Trap Watch · ${humanDate(opts.date)}`);
  lines.push('');
  lines.push(summary);
  lines.push('');
  lines.push('A "trap" line is one where surface stats — recent streaks, viral games, narrative momentum — have walked the line into territory our model can\'t support. Public action piles on; the line inflates further; the prop ends up priced for the public, not the underlying distribution.');
  lines.push('');

  traps.forEach((e, i) => {
    const implied = e.marketImpliedProb ?? Math.max(1, Math.min(99, e.probability - e.edgePercent));
    const arrow = e.direction === 'OVER' ? '↑' : '↓';
    lines.push(`## ${i + 1}. ${e.playerName} — ${e.statLabel} ${e.line} ${arrow}`);
    lines.push('');
    lines.push(`**Trap score: ${Math.round(e.trapScore)}/100${e.team ? ` · ${e.team}` : ''}**`);
    lines.push('');
    lines.push(`Model says: ${Math.round(e.probability)}% · Market implies: ${Math.round(implied)}%${e.edgePercent !== 0 ? ` · ${e.edgePercent >= 0 ? '+' : ''}${e.edgePercent.toFixed(0)}% disagreement` : ''}.`);
    lines.push('');
    if (e.whyMarketWrong) lines.push(`> ${e.whyMarketWrong}`);
    if (e.publicBiasTags && e.publicBiasTags.length > 0) {
      lines.push('');
      lines.push(`*Public bias tags: ${e.publicBiasTags.map((t) => t.replace(/_/g, ' ')).join(' · ')}*`);
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('*Trap-flagged lines are not automatic fades — they\'re lines to scrutinize. Pair this list with the model\'s sharpness score before sizing.*');

  const heroImage = pickHeroImage(traps[0]!);
  return {
    slug,
    kind: 'trap_watch',
    sport: opts.sport,
    title: `${sportLabel} Trap Watch · ${humanDate(opts.date)}`,
    summary,
    bodyMd: lines.join('\n'),
    heroImageUrl: heroImage,
    videoYoutubeId: null,
    relatedPlayerId: String(traps[0]!.playerId),
    relatedGameKey: null,
    expiresAt: endOfDayIso(opts.date),
  };
}

// ---------- Why The Market Is Wrong (per top dislocation) ----------
//
// Single-player deep-dive. One article per top-3 dislocation per
// night. Player-name in slug = great for SEO (long-tail searches
// like "Aaron Judge HR prop tonight").

export function generateWhyMarketWrong(opts: {
  edge: EdgeLeg;
  date: string;
}): ArticleDraft | null {
  const e = opts.edge;
  if (Math.abs(e.edgePercent) < 8) return null;     // not enough disagreement to write about
  const slug = articleSlug({
    kind: 'why_market_wrong',
    date: opts.date,
    sport: e.sport,
    subject: `${e.playerName}-${e.statLabel}`,
  });

  const implied = e.marketImpliedProb ?? Math.max(1, Math.min(99, e.probability - e.edgePercent));
  const arrow = e.direction === 'OVER' ? 'over' : 'under';
  const summary = `Why StatEdge's model says the ${e.statLabel.toLowerCase()} ${arrow} ${e.line} is mispriced — and what the market may be missing.`;

  const lines: string[] = [];
  lines.push(`# Why the Market May Be Wrong on ${e.playerName} ${e.statLabel} Tonight`);
  lines.push('');
  lines.push(`*${humanDate(opts.date)} · ${e.sport.toUpperCase()}${e.team ? ` · ${e.team}` : ''}*`);
  lines.push('');
  lines.push(summary);
  lines.push('');

  lines.push('## The mispricing');
  lines.push('');
  lines.push(`| | StatEdge | Market |`);
  lines.push(`|---|---|---|`);
  lines.push(`| Probability ${e.direction === 'OVER' ? 'over' : 'under'} | ${Math.round(e.probability)}% | ${Math.round(implied)}% |`);
  lines.push(`| Implied break-even | ${e.line} | ${e.line} |`);
  lines.push(`| Projection | ${e.projection.toFixed(1)} | line ${e.line} |`);
  lines.push(`| Disagreement | | ${e.edgePercent >= 0 ? '+' : ''}${e.edgePercent.toFixed(1)}% |`);
  lines.push('');

  if (e.whyMarketWrong) {
    lines.push('## Our read');
    lines.push('');
    lines.push(`> ${e.whyMarketWrong}`);
    lines.push('');
  }

  if (e.reasonCodes && e.reasonCodes.length > 0) {
    lines.push('## Supporting signals');
    lines.push('');
    e.reasonCodes.slice(0, 5).forEach((rc) => lines.push(`- ${rc}`));
    lines.push('');
  }

  if (e.publicBiasTags && e.publicBiasTags.length > 0) {
    lines.push('## Market context tags');
    lines.push('');
    e.publicBiasTags.forEach((t) => lines.push(`- **${t.replace(/_/g, ' ')}**`));
    lines.push('');
  }

  if (e.sharpnessScore !== null && e.sharpnessScore !== undefined) {
    const sharpVerdict = e.sharpnessScore >= 65 ? 'institutional-quality'
      : e.sharpnessScore >= 50 ? 'solid'
      : 'thin';
    lines.push('## Edge quality');
    lines.push('');
    lines.push(`Sharpness score: **${e.sharpnessScore}/100** (${sharpVerdict}).${e.edgeDurability ? ` Edge durability: **${e.edgeDurability}**.` : ''} ${e.trapScore >= 60 ? `Trap score elevated at ${Math.round(e.trapScore)} — read the disagreement carefully.` : ''}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`*This is a model output, not a betting recommendation. Lines move; the model recomputes; check the live dashboard before sizing.*`);

  const heroImage = pickHeroImage(e);
  return {
    slug,
    kind: 'why_market_wrong',
    sport: e.sport,
    title: `Why the Market May Be Wrong on ${e.playerName} ${e.statLabel} Tonight`,
    summary,
    bodyMd: lines.join('\n'),
    heroImageUrl: heroImage,
    videoYoutubeId: null,
    relatedPlayerId: String(e.playerId),
    relatedGameKey: null,
    expiresAt: endOfDayIso(opts.date),
  };
}

// ---------- Daily Edge Preview (per sport) ----------
//
// Morning content — "Today's [sport] edge preview." Lighter framing
// than the per-night Top Mispricings: explains what the model is
// watching, not just the top picks.

export function generateEdgePreview(opts: {
  edges: EdgeLeg[];
  sport: 'mlb' | 'nba' | 'wnba';
  date: string;
}): ArticleDraft | null {
  const sportEdges = opts.edges.filter((e) => e.sport === opts.sport);
  if (sportEdges.length === 0) return null;

  const top = sportEdges
    .sort((a, b) => Math.abs(b.edgePercent) - Math.abs(a.edgePercent))
    .slice(0, 3);
  const trapCount = sportEdges.filter((e) => e.trapScore >= 60).length;
  const structuralCount = sportEdges.filter((e) => (e.publicBiasTags ?? []).includes('STRUCTURAL_EDGE')).length;
  const stableCount = sportEdges.filter((e) => e.edgeDurability === 'stable').length;

  const slug = articleSlug({ kind: 'edge_preview', date: opts.date, sport: opts.sport });
  const sportLabel = opts.sport.toUpperCase();
  const summary = `Where the StatEdge model sees mispricing on tonight's ${sportLabel} board — top dislocations, trap warnings, and structural-edge plays.`;

  const lines: string[] = [];
  lines.push(`# ${sportLabel} Edge Preview · ${humanDate(opts.date)}`);
  lines.push('');
  lines.push(summary);
  lines.push('');
  lines.push(`Tonight's ${sportLabel} board has **${sportEdges.length} props** the model has graded. Of those:`);
  lines.push('');
  lines.push(`- ${stableCount} carry a **stable edge** (matchup / role / structural signals)`);
  lines.push(`- ${structuralCount} flagged as STRUCTURAL_EDGE`);
  lines.push(`- ${trapCount} flagged as trap risk (trap score ≥60)`);
  lines.push('');

  lines.push('## Top 3 dislocations');
  lines.push('');
  top.forEach((e, i) => {
    const arrow = e.direction === 'OVER' ? '↑' : '↓';
    lines.push(`### ${i + 1}. ${e.playerName} ${arrow} ${e.statLabel} ${e.line}`);
    lines.push('');
    lines.push(`Model: ${Math.round(e.probability)}% · Mispricing: ${e.edgePercent >= 0 ? '+' : ''}${e.edgePercent.toFixed(1)}%${e.team ? ` · ${e.team}` : ''}.`);
    if (e.whyMarketWrong) {
      lines.push('');
      lines.push(`*${e.whyMarketWrong}*`);
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('*Lines move throughout the day. The model recomputes on every snapshot pull. Numbers above are at publish time.*');

  const heroImage = pickHeroImage(top[0]!);
  return {
    slug,
    kind: 'edge_preview',
    sport: opts.sport,
    title: `${sportLabel} Edge Preview · ${humanDate(opts.date)}`,
    summary,
    bodyMd: lines.join('\n'),
    heroImageUrl: heroImage,
    videoYoutubeId: null,
    relatedPlayerId: String(top[0]!.playerId),
    relatedGameKey: null,
    expiresAt: endOfDayIso(opts.date),
  };
}

// ---------- CLV Recap (yesterday's results) ----------
//
// Daily morning post: how did our published lines fare against the
// market's eventual close? Builds trust + ranks for "[sport] CLV
// report" search.

export function generateClvRecap(opts: {
  sport: 'mlb' | 'nba' | 'wnba';
  date: string;          // the DAY the recap covers (yesterday)
  beatRate: number | null;
  beatCount: number;
  lostCount: number;
  withClosing: number;
  averageBeat: number | null;
  topBeats?: Array<{ playerName: string; statLabel: string; line: number; lineDelta: number }>;
}): ArticleDraft | null {
  if (opts.withClosing === 0) return null;     // nothing graded yet
  const slug = articleSlug({ kind: 'clv_recap', date: opts.date, sport: opts.sport });
  const sportLabel = opts.sport.toUpperCase();
  const beatPct = opts.beatRate?.toFixed(1) ?? '—';
  const summary = `${beatPct}% of StatEdge's published ${sportLabel} props beat the market's closing line yesterday — the institutional truth metric.`;

  const lines: string[] = [];
  lines.push(`# ${sportLabel} Closing Line Value Recap · ${humanDate(opts.date)}`);
  lines.push('');
  lines.push(summary);
  lines.push('');
  lines.push('Closing line value (CLV) measures whether we beat the market\'s eventual close — independent of game-outcome variance. A great pick can lose; a terrible pick can win. CLV separates good process from short-term luck.');
  lines.push('');
  lines.push('## Yesterday\'s scoreboard');
  lines.push('');
  lines.push(`| | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Props with closing-line movement | ${opts.withClosing} |`);
  lines.push(`| Beat the market | ${opts.beatCount} |`);
  lines.push(`| Lost to the market | ${opts.lostCount} |`);
  lines.push(`| **Beat rate** | **${beatPct}%** |`);
  if (opts.averageBeat !== null) {
    lines.push(`| Average line beat | ${opts.averageBeat >= 0 ? '+' : ''}${opts.averageBeat.toFixed(2)} units |`);
  }
  lines.push('');

  if (opts.topBeats && opts.topBeats.length > 0) {
    lines.push('## Biggest beats');
    lines.push('');
    opts.topBeats.slice(0, 5).forEach((b, i) => {
      lines.push(`${i + 1}. **${b.playerName}** ${b.statLabel} ${b.line} — line moved ${b.lineDelta >= 0 ? '+' : ''}${b.lineDelta.toFixed(2)} units away from us.`);
    });
    lines.push('');
  }

  lines.push('---');
  lines.push(`*The CLV truth metric: did we get a better number than the market eventually settled on? Long-term ≥55% beat rate = real edge.*`);

  return {
    slug,
    kind: 'clv_recap',
    sport: opts.sport,
    title: `${sportLabel} Closing Line Value Recap · ${humanDate(opts.date)}`,
    summary,
    bodyMd: lines.join('\n'),
    heroImageUrl: null,            // CLV recaps are data-focused; no obvious hero player
    videoYoutubeId: null,
    relatedPlayerId: null,
    relatedGameKey: null,
    expiresAt: null,               // evergreen
  };
}

// ---------- Big Game recap ----------
//
// Auto-generates when a player crosses a "big game" stat threshold.
// Highest SEO opportunity per article — long-tail searches like
// "wembanyama stats tonight" are constant. Includes optional
// YouTube highlight embed.

export type BigGameStat = {
  label: string;             // 'Points', 'Rebounds', 'Hits', etc.
  actual: number;
  seasonAvg: number | null;
  delta: number | null;      // actual - seasonAvg, signed
};

export function generateBigGame(opts: {
  player: {
    id: number | string;
    name: string;
    team: string | null;
    sport: 'mlb' | 'nba' | 'wnba' | 'mma';
  };
  game: {
    date: string;             // YYYY-MM-DD
    awayTeam: string | null;
    homeTeam: string | null;
    awayScore: number | null;
    homeScore: number | null;
    finalState: string;       // 'final' / etc.
  };
  // Headline stat + supporting stats (e.g. 39 points, 15 rebounds)
  headlineStat: BigGameStat;
  supportingStats: BigGameStat[];
  // Optional: did StatEdge project this? Did we beat the line?
  projection?: { value: number; line: number; direction: 'OVER' | 'UNDER' } | null;
  // Optional: YouTube highlight to embed
  highlight?: { videoId: string; title: string; channelTitle: string } | null;
}): ArticleDraft {
  const p = opts.player;
  const g = opts.game;
  const headline = `${p.name} ${prettyStatLine(opts.headlineStat, opts.supportingStats)}`;

  const slug = articleSlug({
    kind: 'big_game',
    date: g.date,
    sport: p.sport,
    subject: p.name,
  });

  const lines: string[] = [];
  lines.push(`# ${headline}`);
  lines.push('');
  lines.push(`*${humanDate(g.date)} · ${p.sport.toUpperCase()}${p.team ? ` · ${p.team}` : ''}*`);
  lines.push('');

  const oppLabel = formatOpponent(p.team, g);
  if (oppLabel) {
    lines.push(`${p.name} ${oppLabel}.`);
    lines.push('');
  }

  // Headline + delta callout
  if (opts.headlineStat.delta !== null && opts.headlineStat.seasonAvg !== null) {
    const dir = opts.headlineStat.delta >= 0 ? 'above' : 'below';
    lines.push(`That's **${Math.abs(opts.headlineStat.delta).toFixed(1)} ${dir}** their season average of ${opts.headlineStat.seasonAvg.toFixed(1)} ${opts.headlineStat.label.toLowerCase()}.`);
    lines.push('');
  }

  // YouTube embed
  if (opts.highlight) {
    lines.push(`## Highlight reel`);
    lines.push('');
    lines.push(`[![Highlight: ${opts.highlight.title}](https://img.youtube.com/vi/${opts.highlight.videoId}/maxresdefault.jpg)](https://www.youtube.com/watch?v=${opts.highlight.videoId})`);
    lines.push('');
    lines.push(`*Via ${opts.highlight.channelTitle}.*`);
    lines.push('');
  }

  // Stat line table
  lines.push(`## How it stacks up`);
  lines.push('');
  lines.push(`| Stat | Tonight | Season avg | Δ |`);
  lines.push(`|---|---|---|---|`);
  const allStats = [opts.headlineStat, ...opts.supportingStats];
  for (const s of allStats) {
    const delta = s.delta !== null ? `${s.delta >= 0 ? '+' : ''}${s.delta.toFixed(1)}` : '—';
    lines.push(`| ${s.label} | ${s.actual} | ${s.seasonAvg !== null ? s.seasonAvg.toFixed(1) : '—'} | ${delta} |`);
  }
  lines.push('');

  // StatEdge projection comparison
  if (opts.projection) {
    const proj = opts.projection;
    const projDelta = opts.headlineStat.actual - proj.value;
    lines.push(`## What StatEdge projected`);
    lines.push('');
    lines.push(`Our model had ${p.name} at **${proj.value.toFixed(1)} ${opts.headlineStat.label.toLowerCase()}** (line was ${proj.line}, model leaned ${proj.direction.toLowerCase()}). Actual: **${opts.headlineStat.actual}** — ${projDelta >= 0 ? `over by ${projDelta.toFixed(1)}` : `under by ${Math.abs(projDelta).toFixed(1)}`}.`);
    lines.push('');
    if (proj.direction === 'OVER' && opts.headlineStat.actual > proj.line) {
      lines.push(`Direction correct. Model's read on the over carried.`);
    } else if (proj.direction === 'UNDER' && opts.headlineStat.actual < proj.line) {
      lines.push(`Direction correct. Model's read on the under carried.`);
    } else {
      lines.push(`Direction wrong. The line ${opts.headlineStat.actual > proj.line ? 'cleared' : 'missed'} despite the model's ${proj.direction.toLowerCase()} lean.`);
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push('');
  lines.push(`*Tomorrow's line will likely walk after a performance like this — watch for trap-inflation flags. Check the live ${p.sport.toUpperCase()} dashboard for tonight's projections.*`);

  return {
    slug,
    kind: 'big_game',
    sport: p.sport === 'mma' ? 'mma' : p.sport,
    title: headline,
    summary: `${p.name} went off for ${prettyStatLine(opts.headlineStat, opts.supportingStats)} — what StatEdge projected and what the market saw.`,
    bodyMd: lines.join('\n'),
    heroImageUrl: pickPlayerImage(p),
    videoYoutubeId: opts.highlight?.videoId ?? null,
    relatedPlayerId: String(p.id),
    relatedGameKey: gameKeyFromGame(g),
    expiresAt: null,                       // evergreen
  };
}

// ---------- Power Rankings (Phase 115) ----------
//
// Weekly auto-generated per-sport ranking. Pure power ranking by
// season win% + last-10 form, with a "trending" tag derived from
// the gap between the two (hot teams are over-performing recent
// form vs season; cold teams are the opposite). Not a forecast,
// not a prediction — just an honest snapshot of where each team
// stands right now.
//
// Cron fires Sunday morning ET so the article is published when
// users wake up to plan their week.

export type PowerRankingTeam = {
  abbreviation: string;
  fullName: string;
  wins: number;
  losses: number;
  winPct: number;
  l10Wins: number;
  l10Losses: number;
  // Optional: per-game scoring (NBA = ppg, MLB = runsScored)
  pointRate?: number | null;
  // Free-form note that the template can attach to the row
  // (e.g., "longest win streak in NBA"). Optional.
  note?: string;
};

export function generatePowerRankings(opts: {
  sport: 'mlb' | 'nba' | 'wnba';
  date: string;
  teams: PowerRankingTeam[];
}): ArticleDraft | null {
  if (opts.teams.length === 0) return null;

  // Rank by season win% primary, last-10 win% as tiebreaker. Last-10
  // record DOES matter — Bloomberg-style "current state of the team"
  // pulls form into the visible ranking, but doesn't override season
  // sample size.
  const ranked = [...opts.teams].sort((a, b) => {
    if (b.winPct !== a.winPct) return b.winPct - a.winPct;
    const aL10 = a.l10Wins + a.l10Losses === 0 ? 0 : a.l10Wins / (a.l10Wins + a.l10Losses);
    const bL10 = b.l10Wins + b.l10Losses === 0 ? 0 : b.l10Wins / (b.l10Wins + b.l10Losses);
    if (bL10 !== aL10) return bL10 - aL10;
    return a.fullName.localeCompare(b.fullName);
  });

  const sportLabel = opts.sport.toUpperCase();
  const slug = articleSlug({ kind: 'power_rankings', date: opts.date, sport: opts.sport });
  const summary = `${sportLabel} power rankings for the week of ${humanDate(opts.date)} — every team ranked by season win% with last-10 form, hot/cold tags, and the trend signal that matters.`;

  const lines: string[] = [];
  lines.push(`# ${sportLabel} Power Rankings · Week of ${humanDate(opts.date)}`);
  lines.push('');
  lines.push(summary);
  lines.push('');
  lines.push(`Rankings are season win% primary, last-10 form as tiebreaker. The "Trend" column shows whether a team's recent record is above (↑) or below (↓) their season pace — that's the leading indicator for how the next week plays out.`);
  lines.push('');

  // Top 5 deep-dive callout
  const top5 = ranked.slice(0, 5);
  if (top5.length > 0) {
    lines.push(`## Top of the league`);
    lines.push('');
    top5.forEach((t, i) => {
      lines.push(`**${i + 1}. ${t.fullName}** (${t.wins}-${t.losses}, ${(t.winPct * 100).toFixed(1)}%) — last 10: ${t.l10Wins}-${t.l10Losses}${trendEmoji(t)}.${t.note ? ` ${t.note}` : ''}`);
    });
    lines.push('');
  }

  // Full table — every team, scrollable on mobile
  lines.push(`## Full rankings`);
  lines.push('');
  lines.push(`| Rank | Team | Record | Win% | Last 10 | Trend |`);
  lines.push(`|---|---|---|---|---|---|`);
  ranked.forEach((t, i) => {
    const trend = trendForTeam(t);
    lines.push(`| ${i + 1} | ${t.fullName} | ${t.wins}-${t.losses} | ${(t.winPct * 100).toFixed(1)}% | ${t.l10Wins}-${t.l10Losses} | ${trend} |`);
  });
  lines.push('');

  // Hot / cold callouts
  const hot = ranked.filter((t) => isHot(t));
  const cold = ranked.filter((t) => isCold(t));
  if (hot.length > 0 || cold.length > 0) {
    lines.push(`## Trending`);
    lines.push('');
    if (hot.length > 0) {
      const names = hot.map((t) => `**${t.fullName}** (${t.l10Wins}-${t.l10Losses} L10)`).join(', ');
      lines.push(`**🔥 Heating up:** ${names}.`);
      lines.push('');
    }
    if (cold.length > 0) {
      const names = cold.map((t) => `**${t.fullName}** (${t.l10Wins}-${t.l10Losses} L10)`).join(', ');
      lines.push(`**🧊 Cooling down:** ${names}.`);
      lines.push('');
    }
  }

  lines.push(`---`);
  lines.push('');
  lines.push(`*Power rankings update every Sunday morning ET, after the prior week's games settle. They're a snapshot, not a forecast — the StatEdge model uses much more than win% (matchup, recent variance, lineup, park, weather). For tonight's projections, see the slate.*`);

  return {
    slug,
    kind: 'power_rankings',
    sport: opts.sport,
    title: `${sportLabel} Power Rankings · Week of ${humanDate(opts.date)}`,
    summary,
    bodyMd: lines.join('\n'),
    heroImageUrl: null,
    videoYoutubeId: null,
    relatedPlayerId: null,
    relatedGameKey: null,
    expiresAt: null,
  };
}

function trendEmoji(t: PowerRankingTeam): string {
  if (isHot(t))  return ' 🔥';
  if (isCold(t)) return ' 🧊';
  return '';
}

function trendForTeam(t: PowerRankingTeam): string {
  const total = t.l10Wins + t.l10Losses;
  if (total === 0) return '—';
  const l10 = t.l10Wins / total;
  // Compare last-10 vs season win%. ≥10 percentage points either way
  // is the threshold for hot/cold flag.
  const delta = (l10 - t.winPct) * 100;
  if (delta >= 10) return `↑ +${delta.toFixed(0)}pp`;
  if (delta <= -10) return `↓ ${delta.toFixed(0)}pp`;
  return '— flat';
}

function isHot(t: PowerRankingTeam): boolean {
  const total = t.l10Wins + t.l10Losses;
  if (total === 0) return false;
  const l10 = t.l10Wins / total;
  return (l10 - t.winPct) * 100 >= 15 && t.l10Wins >= 7;
}

function isCold(t: PowerRankingTeam): boolean {
  const total = t.l10Wins + t.l10Losses;
  if (total === 0) return false;
  const l10 = t.l10Wins / total;
  return (l10 - t.winPct) * 100 <= -15 && t.l10Losses >= 7;
}

// ---------- Line Steam (Phase 109c) ----------
//
// Daily afternoon-ET cron: surfaces the day's biggest line moves
// across the slate. Sharp money + injury news + lineup changes all
// manifest as line movement; the article doesn't try to attribute
// (we don't have provenance data), it just reports what moved and
// by how much. Sorted by absolute line delta.

export type LineSteamMover = {
  sport: 'mlb' | 'nba' | 'wnba';
  playerName: string;
  team: string | null;
  statLabel: string;
  firstLine: number;
  latestLine: number;
  lineDelta: number;
  firstImplied: number | null;     // 0-1
  latestImplied: number | null;    // 0-1
  snapshotCount: number;
};

export function generateLineSteamArticle(opts: {
  sport: 'mlb' | 'nba' | 'wnba';
  date: string;
  movers: LineSteamMover[];
}): ArticleDraft | null {
  const movers = opts.movers.filter((m) => m.sport === opts.sport);
  if (movers.length === 0) return null;

  const top = movers.slice(0, 8);
  const slug = articleSlug({ kind: 'line_steam', date: opts.date, sport: opts.sport });
  const sportLabel = opts.sport.toUpperCase();
  const summary = `${top.length} ${sportLabel} props moved sharply on the day's market — sharp action, injury news, and lineup changes show up here first.`;

  const lines: string[] = [];
  lines.push(`# ${sportLabel} Line Steam · ${humanDate(opts.date)}`);
  lines.push('');
  lines.push(summary);
  lines.push('');
  lines.push(`The market is information aggregating in real time. When a line moves more than 0.5 stat units or 5 percentage points of implied probability between morning and afternoon, that's the consensus reacting to something specific. We don't always know what — but we know it matters.`);
  lines.push('');

  lines.push(`| Player | Stat | Line move | Implied move | Snapshots |`);
  lines.push(`|---|---|---|---|---|`);
  for (const m of top) {
    const arrow = m.lineDelta > 0 ? '↑' : m.lineDelta < 0 ? '↓' : '→';
    const lineMove = `${m.firstLine.toFixed(1)} → ${m.latestLine.toFixed(1)} (${m.lineDelta >= 0 ? '+' : ''}${m.lineDelta.toFixed(1)} ${arrow})`;
    const impliedMove = m.firstImplied !== null && m.latestImplied !== null
      ? `${Math.round(m.firstImplied * 100)}% → ${Math.round(m.latestImplied * 100)}%`
      : '—';
    const teamSuffix = m.team ? ` (${m.team})` : '';
    lines.push(`| ${m.playerName}${teamSuffix} | ${m.statLabel} | ${lineMove} | ${impliedMove} | ${m.snapshotCount} |`);
  }
  lines.push('');

  lines.push(`---`);
  lines.push('');
  lines.push(`*Lines that move late = lines worth a second look. The model recomputes on every snapshot pull; checking the Compare page for a player whose line just moved is the highest-leverage habit on this site.*`);

  return {
    slug,
    kind: 'line_steam',
    sport: opts.sport,
    title: `${sportLabel} Line Steam · ${humanDate(opts.date)}`,
    summary,
    bodyMd: lines.join('\n'),
    heroImageUrl: null,
    videoYoutubeId: null,
    relatedPlayerId: null,
    relatedGameKey: null,
    expiresAt: endOfDayIso(opts.date),
  };
}

// ---------- Fight Night recap (Phase 107e) ----------
//
// UFC card recap. Triggered when a card completes with at least one
// "newsworthy" fight: main event, title fight, finish in any round
// (KO/TKO/Submission), or a championship interim. We summarize the
// whole card with extra space for the headline fight. Hero image
// pulls the winner's headshot from ESPN; YouTube highlight (if found)
// embeds with the trusted-channel whitelist (UFC official channel,
// ESPN MMA, etc.).

export type FightNightFightLine = {
  fightId: string;
  red: { id: string; name: string; record: string | null; headshot: string | null };
  blue: { id: string; name: string; record: string | null; headshot: string | null };
  winnerId: string | null;
  winnerName: string | null;
  loserName: string | null;
  method: string | null;            // "KO/TKO", "Submission", "Decision - Unanimous"
  round: number | null;
  time: string | null;              // "MM:SS"
  weightClass: string | null;
  isMain: boolean;
  isTitle: boolean;
};

export function generateFightNight(opts: {
  eventId: string;
  eventName: string;
  eventShortName: string;
  date: string;                  // YYYY-MM-DD ET
  venue: { fullName: string; city: string | null; country: string | null } | null;
  fights: FightNightFightLine[];
  highlight?: { videoId: string; title: string; channelTitle: string } | null;
}): ArticleDraft | null {
  if (opts.fights.length === 0) return null;

  // Surface the headline fight — main event preferred, else first
  // title fight, else first finish, else first listed fight.
  const main =
    opts.fights.find((f) => f.isMain) ??
    opts.fights.find((f) => f.isTitle) ??
    opts.fights.find((f) => f.method && !/decision/i.test(f.method)) ??
    opts.fights[0]!;

  const headline = main.winnerName && main.loserName
    ? `${main.winnerName} def. ${main.loserName}${main.method ? ` via ${shortenMethod(main.method)}` : ''}`
    : `${opts.eventShortName} card recap`;

  const slug = articleSlug({
    kind: 'fight_night',
    date: opts.date,
    sport: 'mma',
    subject: opts.eventShortName || opts.eventId,
  });

  const lines: string[] = [];
  lines.push(`# ${opts.eventName}`);
  lines.push('');
  lines.push(`*${humanDate(opts.date)} · UFC${opts.venue ? ` · ${opts.venue.fullName}${opts.venue.city ? `, ${opts.venue.city}` : ''}` : ''}*`);
  lines.push('');
  lines.push(headline + '.');
  lines.push('');

  // Highlight embed for the main event
  if (opts.highlight) {
    lines.push(`## Main event highlight`);
    lines.push('');
    lines.push(`[![${opts.highlight.title}](https://img.youtube.com/vi/${opts.highlight.videoId}/maxresdefault.jpg)](https://www.youtube.com/watch?v=${opts.highlight.videoId})`);
    lines.push('');
    lines.push(`*Via ${opts.highlight.channelTitle}.*`);
    lines.push('');
  }

  // Main event detail
  lines.push(`## Main Event`);
  lines.push('');
  lines.push(renderFightDetail(main));
  lines.push('');

  // Full card table
  lines.push(`## Full Card Results`);
  lines.push('');
  lines.push(`| Fight | Result | Method | Round |`);
  lines.push(`|---|---|---|---|`);
  for (const f of opts.fights) {
    const matchup = `${f.red.name} vs. ${f.blue.name}${f.isTitle ? ' 🏆' : ''}${f.isMain ? ' (Main)' : ''}`;
    const result = f.winnerName ? f.winnerName : '—';
    const method = f.method ?? '—';
    const round = f.round ? `${f.round}${f.time ? ` (${f.time})` : ''}` : '—';
    lines.push(`| ${matchup} | ${result} | ${method} | ${round} |`);
  }
  lines.push('');

  // Card-wide stats
  const finishes = opts.fights.filter((f) => f.method && !/decision/i.test(f.method)).length;
  const decisions = opts.fights.length - finishes;
  lines.push(`## Card at a glance`);
  lines.push('');
  lines.push(`- **${opts.fights.length}** fights on the card`);
  lines.push(`- **${finishes}** finishes (KO/TKO/Submission)`);
  lines.push(`- **${decisions}** decisions`);
  if (opts.fights.some((f) => f.isTitle)) {
    lines.push(`- **${opts.fights.filter((f) => f.isTitle).length}** title fight${opts.fights.filter((f) => f.isTitle).length > 1 ? 's' : ''}`);
  }
  lines.push('');

  lines.push(`---`);
  lines.push('');
  lines.push(`*Lines and futures will move sharply after a card like this — winners get inflated, losers get oversold. Watch for trap-inflation flags on next-card props.*`);

  const heroImage = main.red.id === main.winnerId ? main.red.headshot : main.blue.headshot;
  const summary = main.winnerName && main.loserName
    ? `${main.winnerName} took the headline over ${main.loserName}${main.method ? ` via ${shortenMethod(main.method)}` : ''} — full ${opts.eventShortName} card recap.`
    : `Full ${opts.eventShortName} card recap with results, method-of-victory, and round breakdowns.`;

  return {
    slug,
    kind: 'fight_night',
    sport: 'mma',
    title: `${opts.eventShortName}: ${headline}`,
    summary,
    bodyMd: lines.join('\n'),
    heroImageUrl: heroImage ?? null,
    videoYoutubeId: opts.highlight?.videoId ?? null,
    relatedPlayerId: main.winnerId,
    relatedGameKey: opts.eventId,
    expiresAt: null,
  };
}

function renderFightDetail(f: FightNightFightLine): string {
  if (!f.winnerName) {
    return `${f.red.name} vs. ${f.blue.name}${f.weightClass ? ` (${f.weightClass})` : ''} — result not yet posted.`;
  }
  const parts: string[] = [];
  parts.push(`**${f.winnerName}** def. ${f.loserName}`);
  if (f.method) parts.push(`via ${f.method}`);
  if (f.round) parts.push(`Round ${f.round}${f.time ? ` (${f.time})` : ''}`);
  if (f.weightClass) parts.push(`${f.weightClass}${f.isTitle ? ' Championship' : ''}`);
  return parts.join(' · ') + '.';
}

function shortenMethod(method: string): string {
  // "Decision - Unanimous" → "UD"; KO/TKO stays as is; "Submission" stays.
  if (/unanimous/i.test(method)) return 'UD';
  if (/split/i.test(method)) return 'SD';
  if (/majority/i.test(method)) return 'MD';
  if (/submission/i.test(method)) return 'submission';
  if (/ko\/tko|knockout/i.test(method)) return 'KO/TKO';
  return method;
}

function prettyStatLine(headline: BigGameStat, supporting: BigGameStat[]): string {
  const parts = [headline, ...supporting.slice(0, 2)];
  return parts.map((s) => `${s.actual} ${shortLabel(s.label)}`).join(', ');
}

function shortLabel(label: string): string {
  const map: Record<string, string> = {
    'Points':       'pts',
    'Rebounds':     'reb',
    'Assists':      'ast',
    'Three-Pointers Made': '3PM',
    'Steals':       'stl',
    'Blocks':       'blk',
    'Hits':         'hits',
    'Home Runs':    'HR',
    'RBIs':         'RBI',
    'Strikeouts':   'K',
    'Total Bases':  'TB',
    'Stolen Bases': 'SB',
  };
  return map[label] ?? label.toLowerCase();
}

function formatOpponent(team: string | null, g: { awayTeam: string | null; homeTeam: string | null; awayScore: number | null; homeScore: number | null }): string | null {
  if (!team || !g.awayTeam || !g.homeTeam) return null;
  const isHome = team === g.homeTeam;
  const opponent = isHome ? g.awayTeam : g.homeTeam;
  const myScore = isHome ? g.homeScore : g.awayScore;
  const oppScore = isHome ? g.awayScore : g.homeScore;
  if (myScore === null || oppScore === null) {
    return `${isHome ? 'hosted' : 'visited'} ${opponent}`;
  }
  const verb = myScore > oppScore ? 'led' : myScore < oppScore ? 'fell short to' : 'tied';
  return `${verb} ${opponent} ${myScore}-${oppScore}`;
}

function gameKeyFromGame(g: { awayTeam: string | null; homeTeam: string | null }): string | null {
  if (!g.awayTeam || !g.homeTeam) return null;
  return [g.awayTeam, g.homeTeam].sort().join('-');
}

function pickPlayerImage(p: { id: number | string; sport: 'mlb' | 'nba' | 'wnba' | 'mma' }): string | null {
  if (p.sport === 'mlb' && typeof p.id === 'number') {
    return mlbPlayerHeadshotUrl(p.id);
  }
  if (p.sport === 'nba' && typeof p.id === 'number') {
    return `https://cdn.nba.com/headshots/nba/latest/1040x760/${p.id}.png`;
  }
  if (p.sport === 'wnba') {
    return `https://a.espncdn.com/i/headshots/wnba/players/full/${p.id}.png`;
  }
  // MMA — no canonical headshot CDN; leave null. Phase 105 fix.
  return null;
}

// ---------- helpers ----------

function pickHeroImage(leg: EdgeLeg): string | null {
  if (leg.sport === 'mlb' && typeof leg.playerId === 'number') {
    return mlbPlayerHeadshotUrl(leg.playerId);
  }
  if (leg.sport === 'nba' && typeof leg.playerId === 'number') {
    return `https://cdn.nba.com/headshots/nba/latest/1040x760/${leg.playerId}.png`;
  }
  if (leg.sport === 'wnba') {
    return `https://a.espncdn.com/i/headshots/wnba/players/full/${leg.playerId}.png`;
  }
  return null;
}

// ET date → "May 9, 2026"
function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[(m ?? 1) - 1]} ${d}, ${y}`;
}

// 23:59:59 of the slate date in ET, ISO. Used to mark articles like
// "tonight's mispricings" as expired after the games settle. Index
// pages can hide expired evergreen content.
function endOfDayIso(date: string): string {
  // ET = UTC-5 during DST (May), UTC-6 otherwise. Approximate as
  // UTC-5; off by 1 hour twice a year is acceptable.
  return `${date}T23:59:59-05:00`;
}

// Used by templates that need to dedup by slug subject. e.g. "trap
// watch" generates one article per sport per night.
export { slugify };
