// Seed today's daily_slate by reading one or more pipe-delimited line
// files and POSTing them as a single bundle to /api/slate/today.
//
// Usage: SLATE_ADMIN_SECRET=xxx node scripts/seed-daily-slate.mjs file1.txt file2.txt
// Or:    BACKEND_URL=https://statedge-backend.vercel.app SLATE_ADMIN_SECRET=xxx node scripts/seed-daily-slate.mjs ...

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

const ESPN_TO_NBA = { NY: 'NYK', SA: 'SAS', GS: 'GSW', NO: 'NOP', WSH: 'WAS', UTAH: 'UTA' };

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node seed-daily-slate.mjs <file1> [file2 ...]');
  process.exit(1);
}

// Combine all input files into one big pasted bundle. We auto-pair
// opponents *within* each file (so PHI/NYK lines pair correctly even
// when SAS/MIN are also in the bundle).
const all = [];
for (const path of files) {
  const text = fs.readFileSync(path, 'utf-8');
  const rows = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const fileLines = [];
  const teamSet = new Set();
  for (const row of rows) {
    const f = row.split(/[|\t]/).map((x) => x.trim());
    if (f.length < 4) continue;
    const [name, team, statKey, lineStr] = f;
    const label = STAT_TO_LABEL[statKey.toLowerCase()];
    if (!label) continue;
    const lineNum = parseFloat(lineStr);
    if (!Number.isFinite(lineNum)) continue;
    const teamCanonical = ESPN_TO_NBA[team.toUpperCase()] ?? team.toUpperCase();
    teamSet.add(teamCanonical);
    fileLines.push({
      playerName: name,
      statLabel: label,
      line: lineNum,
      team: teamCanonical,
      opponentAbbr: null,
    });
  }
  const teams = [...teamSet];
  if (teams.length === 2) {
    const [a, b] = teams;
    for (const l of fileLines) l.opponentAbbr = l.team === a ? b : a;
  }
  console.error(`${path}: ${fileLines.length} lines, ${teams.join(' vs ')}`);
  all.push(...fileLines);
}

const backend = process.env.BACKEND_URL ?? 'https://statedge-backend.vercel.app';
const secret = process.env.SLATE_ADMIN_SECRET;
if (!secret) {
  console.error('Error: SLATE_ADMIN_SECRET env var must be set');
  process.exit(1);
}

console.error(`\nPosting ${all.length} total lines → ${backend}/api/slate/today`);

const res = await fetch(`${backend}/api/slate/today`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-admin-secret': secret,
  },
  body: JSON.stringify({ lines: all }),
});
const body = await res.text();
console.log(`HTTP ${res.status}: ${body}`);
if (!res.ok) process.exit(1);
