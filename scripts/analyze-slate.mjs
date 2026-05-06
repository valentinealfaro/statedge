// One-shot slate analyzer. Reads pipe-delimited prop rows from a file
// path passed on argv, posts them to the deployed backend, prints
// strongest edges + suggested parlay. Used when the user pastes a
// full prop sheet in the chat and wants the model's verdict back.
//
// Usage: node scripts/analyze-slate.mjs scripts/slate-input.txt

import fs from 'node:fs';

const STAT_TO_LABEL = {
  points: 'Points', pts: 'Points',
  rebounds: 'Rebounds', reb: 'Rebounds',
  assists: 'Assists', ast: 'Assists',
  three_pt_made: '3-PT Made', '3pm': '3-PT Made',
  fg_made: 'FG Made', fgm: 'FG Made',
  fg_attempted: 'FG Attempted', fga: 'FG Attempted',
  ft_made: 'Free Throws Made', ftm: 'Free Throws Made',
  ft_attempted: 'Free Throws Attempted', fta: 'Free Throws Attempted',
  personal_fouls: 'Personal Fouls', pf: 'Personal Fouls',
  steals: 'Steals', stl: 'Steals',
  blocks: 'Blocked Shots', blk: 'Blocked Shots',
  turnovers: 'Turnovers', tov: 'Turnovers',
  offensive_rebounds: 'Offensive Rebounds', oreb: 'Offensive Rebounds',
  defensive_rebounds: 'Defensive Rebounds', dreb: 'Defensive Rebounds',
  pra: 'Pts+Rebs+Asts',
  pr: 'Pts+Rebs',
  pa: 'Pts+Asts',
  ra: 'Rebs+Asts',
  stocks: 'Blks+Stls',
  double_double: 'Double-Double', dd: 'Double-Double',
};

const path = process.argv[2];
if (!path) {
  console.error('Usage: node analyze-slate.mjs <input-file>');
  process.exit(1);
}

const text = fs.readFileSync(path, 'utf-8');
const rows = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

const parsed = [];
const skipped = [];
const teams = new Set();
for (const row of rows) {
  const f = row.split(/[|\t]/).map((x) => x.trim());
  if (f.length < 4) { skipped.push({ row, reason: '<4 fields' }); continue; }
  const [name, team, statKey, lineStr, dir] = f;
  const statLabel = STAT_TO_LABEL[statKey.toLowerCase()];
  if (!statLabel) { skipped.push({ row, reason: `unknown stat ${statKey}` }); continue; }
  const line = parseFloat(lineStr);
  if (!Number.isFinite(line)) { skipped.push({ row, reason: `bad line ${lineStr}` }); continue; }
  parsed.push({ playerName: name, team, statLabel, line, direction: dir ?? 'both' });
  teams.add(team);
}

// Auto-pair opponents if exactly two teams.
const teamArr = [...teams];
const opponentByTeam = teamArr.length === 2
  ? { [teamArr[0]]: teamArr[1], [teamArr[1]]: teamArr[0] }
  : {};

const raw = parsed.map((p) => ({
  playerName: p.playerName,
  statLabel: p.statLabel,
  line: p.line,
  team: p.team,
  opponentAbbr: opponentByTeam[p.team] ?? null,
}));

console.error(`Parsed ${parsed.length} lines (${skipped.length} skipped) across ${teamArr.length} teams: ${teamArr.join(', ')}`);

const res = await fetch('https://statedge-backend.vercel.app/api/slate/parse', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ raw, source: 'manual' }),
});
if (!res.ok) {
  console.error(`HTTP ${res.status}`, await res.text());
  process.exit(1);
}
const data = await res.json();

// Re-attach the user's stated direction so we can flag agreement / disagreement.
const directionByKey = new Map();
for (const p of parsed) {
  directionByKey.set(`${p.playerName}|${p.statLabel}|${p.line}`, p.direction);
}

const lines = data.lines ?? [];

// ---- Strongest plays — sort by projection.edge.score desc ----
const ranked = lines
  .filter((l) => l.projection && !l.projection.noProjection)
  .map((l) => {
    const userDir = directionByKey.get(`${l.ppPlayerName}|${l.statLabel}|${l.line}`) ?? 'both';
    return { ...l, userDir };
  })
  .sort((a, b) => (b.projection.edge.score ?? 0) - (a.projection.edge.score ?? 0));

function fmtRow(l) {
  const p = l.projection;
  const lean = p.edge.lean.replace(' Lean', '');
  const lineStr = l.line.toFixed(l.line % 1 === 0 ? 0 : 1);
  const proj = p.projection.final.toFixed(1);
  const range = `${p.projection.rangeLow.toFixed(1)}-${p.projection.rangeHigh.toFixed(1)}`;
  const probStr = lean.includes('Over') ? `${p.probability.over}% O` : `${p.probability.under}% U`;
  const userOk = l.userDir === 'both'
    || (l.userDir === 'over' && lean.includes('Over'))
    || (l.userDir === 'under' && lean.includes('Under'));
  const userTag = l.userDir === 'both' ? '' : l.userDir === (lean.includes('Over') ? 'over' : 'under') ? ' ✓' : ' ✗';
  return `  edge ${String(p.edge.score).padStart(2)} · ${lean.padEnd(13)} ${probStr.padEnd(7)} · conf ${p.confidence.score} risk ${p.risk.score} | ${l.playerName} ${l.statLabel} ${lineStr} (proj ${proj}, range ${range})${userTag}`;
}

console.log('\n========== STAT EDGE — STRONGEST PLAYS ==========\n');
console.log(`Slate: ${parsed.length} lines parsed, ${lines.length} resolved, ${data.unresolved.length} unresolved.\n`);

// Strong leans only (≥ 60 edge score)
const strong = ranked.filter((l) => l.projection.edge.score >= 60);
const moderate = ranked.filter((l) => l.projection.edge.score >= 40 && l.projection.edge.score < 60);

console.log(`---- STRONG EDGE (${strong.length}) ----`);
strong.slice(0, 25).forEach((l) => console.log(fmtRow(l)));

if (strong.length === 0) {
  console.log('  (none — projection engine doesn\'t see anything ≥60 edge tonight)');
}

console.log(`\n---- MODERATE EDGE (${moderate.length}, top 15) ----`);
moderate.slice(0, 15).forEach((l) => console.log(fmtRow(l)));

// ---- Suggested parlay: top 3 highest mightHitPct that LEAN strongly ----
console.log('\n---- SUGGESTED PARLAY (top 3 highest hit %) ----');
const parlay = ranked
  .filter((l) => {
    const lean = l.projection.edge.lean;
    return lean.startsWith('Strong') || lean.startsWith('Slight');
  })
  .sort((a, b) => {
    const aP = Math.max(a.projection.probability.over, a.projection.probability.under);
    const bP = Math.max(b.projection.probability.over, b.projection.probability.under);
    return bP - aP;
  })
  .slice(0, 3);

let combined = 1;
for (const l of parlay) {
  const p = l.projection;
  const lean = p.edge.lean.includes('Over') ? 'OVER' : 'UNDER';
  const pct = lean === 'OVER' ? p.probability.over : p.probability.under;
  combined *= pct / 100;
  console.log(`  ${l.playerName} ${l.statLabel} ${l.line} ${lean} — ${pct}% (edge ${p.edge.score}, conf ${p.confidence.score})`);
}
console.log(`  Combined hit probability (independent): ${(combined * 100).toFixed(1)}%`);

// ---- Crazy parlay: top 5 strongest, see what combined % comes out ----
console.log('\n---- CRAZY PARLAY (top 5 strongest, lottery ticket) ----');
const crazy = ranked.slice(0, 5);
let crazyCombined = 1;
for (const l of crazy) {
  const p = l.projection;
  const lean = p.edge.lean.includes('Over') ? 'OVER' : 'UNDER';
  const pct = lean === 'OVER' ? p.probability.over : p.probability.under;
  crazyCombined *= pct / 100;
  console.log(`  ${l.playerName} ${l.statLabel} ${l.line} ${lean} — ${pct}%`);
}
console.log(`  Combined hit probability: ${(crazyCombined * 100).toFixed(1)}%`);

// ---- AVOID list — No Clear Edge but user picked a side anyway ----
const noEdgeUserPicked = ranked.filter((l) =>
  l.projection.edge.lean === 'No Clear Edge' && l.userDir !== 'both'
);
console.log(`\n---- AVOID (no model edge but a side was picked, ${noEdgeUserPicked.length}) ----`);
noEdgeUserPicked.slice(0, 10).forEach((l) => console.log(`  ${l.playerName} ${l.statLabel} ${l.line} (your pick: ${l.userDir.toUpperCase()}) — model says no edge`));

// ---- Unresolved lines ----
if (data.unresolved.length > 0) {
  console.log(`\n---- UNRESOLVED (${data.unresolved.length}, sample) ----`);
  data.unresolved.slice(0, 10).forEach((u) => {
    console.log(`  ${u.rawText} ${u.rawStatLabel} ${u.line} — ${u.reason}`);
  });
}
