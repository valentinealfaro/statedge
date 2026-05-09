// Big-Game detector — Phase 104.
//
// Scans tonight's completed games for players who crossed sport-
// specific stat thresholds. Each detection becomes a big_game article.
//
// Pure function. Inputs: live boxscore data (we already fetch via
// getNbaLiveToday / getMlbLiveToday / getWnbaLiveToday). Outputs:
// list of detections — each with the player, the headline stat, and
// supporting stats. Caller orchestrates the YouTube search + season
// average lookup + projection lookup.
//
// Threshold spec lives at the top so it's easy to tune from one
// place. Conservative defaults — we'd rather under-trigger than
// flood the news feed with marginal performances.

export type DetectionInput = {
  sport: 'nba' | 'mlb' | 'wnba';
  player: {
    id: number | string;
    name: string;
    team: string | null;
  };
  game: {
    eventId: string;
    awayTeam: string | null;
    homeTeam: string | null;
    awayScore: number | null;
    homeScore: number | null;
    state: 'final' | 'live' | 'pregame';
  };
  // Stat line — sport-specific keys mapped from each league's bulk-
  // live response shape.
  stats: Record<string, number | null>;
};

export type Detection = {
  sport: 'nba' | 'mlb' | 'wnba';
  player: { id: number | string; name: string; team: string | null };
  game: DetectionInput['game'];
  // What triggered the detection
  trigger: string;            // human-readable: '40+ points', '3+ HR', etc.
  // Headline + supporting stats for the article
  headlineStat: { key: string; label: string; actual: number };
  supportingStats: Array<{ key: string; label: string; actual: number }>;
};

// ---------- NBA / WNBA thresholds ----------
//
// These work identically for both — same stat keys, same shape.
// Triple-double = ≥10 in any 3 of points/rebounds/assists/steals/blocks.

function detectBasketball(input: DetectionInput): Detection | null {
  if (input.game.state !== 'final') return null;
  const s = input.stats;
  const pts = num(s.points);
  const reb = num(s.rebounds);
  const ast = num(s.assists);
  const stl = num(s.steals);
  const blk = num(s.blocks);
  const tpm = num(s.three_pt_made);

  // Triple-double check
  const tdCategories = [pts, reb, ast, stl, blk].filter((v) => v >= 10).length;
  const isTripleDouble = tdCategories >= 3;

  // Headline triggers (in order of significance — first match wins)
  if (pts >= 50) {
    return makeBasketballDetection(input, '50+ point game', 'points', 'Points', pts);
  }
  if (pts >= 40) {
    return makeBasketballDetection(input, '40+ point game', 'points', 'Points', pts);
  }
  if (isTripleDouble) {
    return makeBasketballDetection(input, 'triple-double', 'points', 'Points', pts);
  }
  if (ast >= 15) {
    return makeBasketballDetection(input, '15+ assist game', 'assists', 'Assists', ast);
  }
  if (reb >= 18) {
    return makeBasketballDetection(input, '18+ rebound game', 'rebounds', 'Rebounds', reb);
  }
  if (tpm >= 8) {
    return makeBasketballDetection(input, '8+ three-pointers', 'three_pt_made', 'Three-Pointers Made', tpm);
  }
  return null;
}

function makeBasketballDetection(
  input: DetectionInput,
  trigger: string,
  headlineKey: string,
  headlineLabel: string,
  headlineValue: number,
): Detection {
  const s = input.stats;
  // Supporting stats — the next two most "impressive" stats from
  // points/rebounds/assists.
  const candidates: Array<{ key: string; label: string; actual: number }> = [
    { key: 'points',       label: 'Points',       actual: num(s.points)        },
    { key: 'rebounds',     label: 'Rebounds',     actual: num(s.rebounds)      },
    { key: 'assists',      label: 'Assists',      actual: num(s.assists)       },
    { key: 'three_pt_made',label: 'Three-Pointers Made', actual: num(s.three_pt_made) },
    { key: 'steals',       label: 'Steals',       actual: num(s.steals)        },
    { key: 'blocks',       label: 'Blocks',       actual: num(s.blocks)        },
  ];
  const supporting = candidates
    .filter((c) => c.key !== headlineKey && c.actual > 0)
    .sort((a, b) => {
      // Rebounds + assists weigh higher in basketball write-ups
      const order: Record<string, number> = { rebounds: 0, assists: 1, three_pt_made: 2, steals: 3, blocks: 4, points: 5 };
      return (order[a.key] ?? 99) - (order[b.key] ?? 99);
    })
    .slice(0, 3);

  return {
    sport: input.sport,
    player: input.player,
    game: input.game,
    trigger,
    headlineStat: { key: headlineKey, label: headlineLabel, actual: headlineValue },
    supportingStats: supporting,
  };
}

// ---------- MLB thresholds ----------
//
// Hitter + pitcher branches have different stat-key vocabularies.
// `stats` should include both flavors when available; the detector
// picks whichever applies.

function detectMlb(input: DetectionInput): Detection | null {
  if (input.game.state !== 'final') return null;
  const s = input.stats;

  // Pitcher checks (priority — a no-hitter is bigger news than a 4-HR game)
  const pitcherStrikeouts = num(s.pitcher_strikeouts);
  const inningsPitched = num(s.innings_pitched);
  const earnedRunsAllowed = num(s.earned_runs_allowed);
  const hitsAllowed = num(s.hits_allowed);

  if (pitcherStrikeouts >= 12 && inningsPitched >= 6) {
    return {
      sport: 'mlb',
      player: input.player,
      game: input.game,
      trigger: `${pitcherStrikeouts}-strikeout outing`,
      headlineStat: { key: 'pitcher_strikeouts', label: 'Strikeouts', actual: pitcherStrikeouts },
      supportingStats: [
        { key: 'innings_pitched',     label: 'Innings Pitched',  actual: inningsPitched },
        { key: 'earned_runs_allowed', label: 'Earned Runs',      actual: earnedRunsAllowed },
        { key: 'hits_allowed',        label: 'Hits Allowed',     actual: hitsAllowed },
      ],
    };
  }
  if (inningsPitched >= 7 && earnedRunsAllowed === 0 && hitsAllowed <= 2) {
    return {
      sport: 'mlb',
      player: input.player,
      game: input.game,
      trigger: 'shutout-quality start',
      headlineStat: { key: 'earned_runs_allowed', label: 'Earned Runs', actual: earnedRunsAllowed },
      supportingStats: [
        { key: 'innings_pitched',   label: 'Innings Pitched',   actual: inningsPitched   },
        { key: 'pitcher_strikeouts',label: 'Strikeouts',        actual: pitcherStrikeouts },
        { key: 'hits_allowed',      label: 'Hits Allowed',      actual: hitsAllowed       },
      ],
    };
  }

  // Hitter checks
  const homeRuns = num(s.home_runs);
  const hits = num(s.hits);
  const rbis = num(s.rbis);
  const totalBases = num(s.total_bases);
  const stolenBases = num(s.stolen_bases);
  const runs = num(s.runs);

  if (homeRuns >= 3) {
    return {
      sport: 'mlb',
      player: input.player,
      game: input.game,
      trigger: `${homeRuns}-homer game`,
      headlineStat: { key: 'home_runs', label: 'Home Runs', actual: homeRuns },
      supportingStats: [
        { key: 'rbis',        label: 'RBIs',        actual: rbis },
        { key: 'total_bases', label: 'Total Bases', actual: totalBases },
        { key: 'hits',        label: 'Hits',        actual: hits },
      ],
    };
  }
  if (hits >= 5) {
    return {
      sport: 'mlb',
      player: input.player,
      game: input.game,
      trigger: `${hits}-hit night`,
      headlineStat: { key: 'hits', label: 'Hits', actual: hits },
      supportingStats: [
        { key: 'total_bases', label: 'Total Bases', actual: totalBases },
        { key: 'rbis',        label: 'RBIs',        actual: rbis        },
        { key: 'runs',        label: 'Runs',        actual: runs        },
      ],
    };
  }
  if (rbis >= 7) {
    return {
      sport: 'mlb',
      player: input.player,
      game: input.game,
      trigger: `${rbis}-RBI night`,
      headlineStat: { key: 'rbis', label: 'RBIs', actual: rbis },
      supportingStats: [
        { key: 'home_runs',   label: 'Home Runs',   actual: homeRuns },
        { key: 'hits',        label: 'Hits',        actual: hits     },
        { key: 'total_bases', label: 'Total Bases', actual: totalBases},
      ],
    };
  }
  if (stolenBases >= 4) {
    return {
      sport: 'mlb',
      player: input.player,
      game: input.game,
      trigger: `${stolenBases}-steal night`,
      headlineStat: { key: 'stolen_bases', label: 'Stolen Bases', actual: stolenBases },
      supportingStats: [
        { key: 'hits',        label: 'Hits',        actual: hits },
        { key: 'runs',        label: 'Runs',        actual: runs },
      ],
    };
  }
  return null;
}

// ---------- Public entry ----------

export function detectBigGames(inputs: DetectionInput[]): Detection[] {
  const out: Detection[] = [];
  for (const input of inputs) {
    let detection: Detection | null = null;
    if (input.sport === 'nba' || input.sport === 'wnba') {
      detection = detectBasketball(input);
    } else if (input.sport === 'mlb') {
      detection = detectMlb(input);
    }
    if (detection) out.push(detection);
  }
  return out;
}

// ---------- helpers ----------

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
