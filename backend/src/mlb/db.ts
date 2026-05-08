// MLB-specific Postgres helpers. Kept separate from the NBA db.ts so
// the schemas stay independent and we don't accidentally couple MLB
// behavior to NBA assumptions (NBA player_game_stats has minutes/3pt%;
// MLB has plate appearances/innings — different worlds). All upserts
// are idempotent so syncs can be re-run safely.

import { getPool } from '../db.js';
import {
  inningsPitchedToNumeric,
  leagueCodeFromId,
  type MlbGameLogEntry,
  type MlbPlayer,
  type MlbScheduleGame,
  type MlbTeam,
} from './client.js';

// ---------- Schema bootstrap ----------

// Run once on first call to make sure the MLB tables exist on a fresh
// DB. The CREATE TABLE statements mirror backend/db/schema.sql verbatim
// so we can stand up a new env without running migrations manually.
let mlbTablesEnsured = false;

export async function ensureMlbTables(): Promise<void> {
  if (mlbTablesEnsured) return;
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mlb_teams (
      id            INTEGER PRIMARY KEY,
      abbreviation  TEXT NOT NULL,
      city          TEXT,
      name          TEXT NOT NULL,
      full_name     TEXT NOT NULL,
      league        TEXT NOT NULL CHECK (league IN ('AL', 'NL')),
      division      TEXT
    );
    CREATE TABLE IF NOT EXISTS mlb_players (
      id           INTEGER PRIMARY KEY,
      team_id      INTEGER REFERENCES mlb_teams(id),
      first_name   TEXT,
      last_name    TEXT,
      full_name    TEXT NOT NULL,
      position     TEXT,
      bats         TEXT CHECK (bats IN ('L', 'R', 'S')),
      throws       TEXT CHECK (throws IN ('L', 'R')),
      is_active    BOOLEAN NOT NULL DEFAULT TRUE,
      is_pitcher   BOOLEAN GENERATED ALWAYS AS (position = 'P') STORED
    );
    CREATE INDEX IF NOT EXISTS mlb_players_full_name_idx ON mlb_players (lower(full_name));
    CREATE INDEX IF NOT EXISTS mlb_players_pitcher_idx   ON mlb_players (is_pitcher);
    CREATE TABLE IF NOT EXISTS mlb_games (
      id            BIGINT PRIMARY KEY,
      season        TEXT NOT NULL,
      game_date     DATE NOT NULL,
      home_team_id  INTEGER REFERENCES mlb_teams(id),
      away_team_id  INTEGER REFERENCES mlb_teams(id),
      home_score    INTEGER,
      away_score    INTEGER,
      status        TEXT,
      venue         TEXT
    );
    CREATE INDEX IF NOT EXISTS mlb_games_date_idx   ON mlb_games (game_date DESC);
    CREATE INDEX IF NOT EXISTS mlb_games_team_idx   ON mlb_games (home_team_id, away_team_id);
    CREATE INDEX IF NOT EXISTS mlb_games_season_idx ON mlb_games (season);
    CREATE TABLE IF NOT EXISTS mlb_hitting_stats (
      player_id          INTEGER NOT NULL REFERENCES mlb_players(id),
      game_id            BIGINT  NOT NULL REFERENCES mlb_games(id),
      team_id            INTEGER REFERENCES mlb_teams(id),
      opponent_team_id   INTEGER REFERENCES mlb_teams(id),
      is_home            BOOLEAN,
      plate_appearances  INTEGER,
      at_bats            INTEGER,
      hits               INTEGER,
      singles            INTEGER,
      doubles            INTEGER,
      triples            INTEGER,
      home_runs          INTEGER,
      total_bases        INTEGER,
      runs               INTEGER,
      rbis               INTEGER,
      walks              INTEGER,
      strikeouts         INTEGER,
      stolen_bases       INTEGER,
      caught_stealing    INTEGER,
      hit_by_pitch       INTEGER,
      batting_order      INTEGER,
      PRIMARY KEY (player_id, game_id)
    );
    CREATE INDEX IF NOT EXISTS mlb_hit_player_idx   ON mlb_hitting_stats (player_id);
    CREATE INDEX IF NOT EXISTS mlb_hit_game_idx     ON mlb_hitting_stats (game_id);
    CREATE INDEX IF NOT EXISTS mlb_hit_opponent_idx ON mlb_hitting_stats (opponent_team_id);
    CREATE TABLE IF NOT EXISTS mlb_pitching_stats (
      player_id            INTEGER NOT NULL REFERENCES mlb_players(id),
      game_id              BIGINT  NOT NULL REFERENCES mlb_games(id),
      team_id              INTEGER REFERENCES mlb_teams(id),
      opponent_team_id     INTEGER REFERENCES mlb_teams(id),
      is_home              BOOLEAN,
      is_starter           BOOLEAN,
      outs_recorded        INTEGER,
      innings_pitched      NUMERIC,
      pitches_thrown       INTEGER,
      hits_allowed         INTEGER,
      runs_allowed         INTEGER,
      earned_runs_allowed  INTEGER,
      walks_allowed        INTEGER,
      strikeouts           INTEGER,
      home_runs_allowed    INTEGER,
      PRIMARY KEY (player_id, game_id)
    );
    CREATE INDEX IF NOT EXISTS mlb_pit_player_idx   ON mlb_pitching_stats (player_id);
    CREATE INDEX IF NOT EXISTS mlb_pit_game_idx     ON mlb_pitching_stats (game_id);
    CREATE INDEX IF NOT EXISTS mlb_pit_opponent_idx ON mlb_pitching_stats (opponent_team_id);
    CREATE TABLE IF NOT EXISTS mlb_projection_history (
      id                SERIAL PRIMARY KEY,
      created_at        TIMESTAMP DEFAULT NOW(),
      game_date         DATE,
      player_id         INTEGER REFERENCES mlb_players(id),
      team_id           INTEGER REFERENCES mlb_teams(id),
      opponent_team_id  INTEGER REFERENCES mlb_teams(id),
      selected_stat     TEXT,
      line_value        NUMERIC,
      direction         TEXT,
      projection_value  NUMERIC,
      probability       NUMERIC,
      confidence_score  NUMERIC,
      risk_score        NUMERIC,
      trap_score        NUMERIC,
      edge_score        NUMERIC,
      ev_score          NUMERIC,
      card_type         TEXT,
      model_version     TEXT,
      inputs_json       JSONB,
      result_value      NUMERIC,
      hit_or_miss       BOOLEAN,
      graded_at         TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS mlb_proj_history_date_idx   ON mlb_projection_history (game_date DESC);
    CREATE INDEX IF NOT EXISTS mlb_proj_history_player_idx ON mlb_projection_history (player_id);
  `);
  mlbTablesEnsured = true;
}

// ---------- Teams ----------

export async function upsertMlbTeams(teams: MlbTeam[]): Promise<number> {
  if (teams.length === 0) return 0;
  await ensureMlbTables();
  const pool = getPool();
  let count = 0;
  for (const t of teams) {
    const league = leagueCodeFromId(t.league?.id);
    if (!league) continue;     // skip non AL/NL (spring leagues, etc.)
    await pool.query(
      `INSERT INTO mlb_teams (id, abbreviation, city, name, full_name, league, division)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         abbreviation = EXCLUDED.abbreviation,
         city         = EXCLUDED.city,
         name         = EXCLUDED.name,
         full_name    = EXCLUDED.full_name,
         league       = EXCLUDED.league,
         division     = EXCLUDED.division`,
      [
        t.id,
        t.abbreviation,
        t.locationName ?? null,
        t.teamName ?? t.name,
        t.name,
        league,
        t.division?.name ?? null,
      ],
    );
    count += 1;
  }
  return count;
}

export type MlbTeamRow = {
  id: number;
  abbreviation: string;
  city: string | null;
  name: string;
  fullName: string;
  league: 'AL' | 'NL';
  division: string | null;
};

export async function listMlbTeamsFromDb(): Promise<MlbTeamRow[]> {
  await ensureMlbTables();
  const { rows } = await getPool().query<{
    id: number;
    abbreviation: string;
    city: string | null;
    name: string;
    full_name: string;
    league: 'AL' | 'NL';
    division: string | null;
  }>(
    `SELECT id, abbreviation, city, name, full_name, league, division
       FROM mlb_teams
       ORDER BY league, division NULLS LAST, full_name`,
  );
  return rows.map((r) => ({
    id: r.id,
    abbreviation: r.abbreviation,
    city: r.city,
    name: r.name,
    fullName: r.full_name,
    league: r.league,
    division: r.division,
  }));
}

// ---------- Players ----------

export async function upsertMlbPlayers(players: MlbPlayer[]): Promise<number> {
  if (players.length === 0) return 0;
  await ensureMlbTables();
  const pool = getPool();
  let count = 0;
  for (const p of players) {
    const teamId = p.currentTeam?.id ?? null;
    // Foreign key constraint: only insert if the team exists (or null
    // out the team_id if missing). Avoids errors during a fresh sync
    // where a player's team hasn't synced yet.
    const teamExists = teamId !== null
      ? (await pool.query<{ exists: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM mlb_teams WHERE id = $1) AS exists`,
          [teamId],
        )).rows[0]?.exists ?? false
      : false;
    await pool.query(
      `INSERT INTO mlb_players (
         id, team_id, first_name, last_name, full_name, position, bats, throws, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         team_id    = EXCLUDED.team_id,
         first_name = EXCLUDED.first_name,
         last_name  = EXCLUDED.last_name,
         full_name  = EXCLUDED.full_name,
         position   = EXCLUDED.position,
         bats       = EXCLUDED.bats,
         throws     = EXCLUDED.throws,
         is_active  = EXCLUDED.is_active`,
      [
        p.id,
        teamExists ? teamId : null,
        p.firstName ?? null,
        p.lastName ?? null,
        p.fullName,
        p.primaryPosition?.abbreviation ?? null,
        p.batSide?.code ?? null,
        p.pitchHand?.code ?? null,
        p.active !== false,
      ],
    );
    count += 1;
  }
  return count;
}

export async function listActiveMlbPlayerIdsFromDb(
  pitcher?: boolean,
): Promise<number[]> {
  await ensureMlbTables();
  const pool = getPool();
  const where: string[] = ['is_active = TRUE'];
  if (pitcher === true) where.push('is_pitcher = TRUE');
  if (pitcher === false) where.push('is_pitcher = FALSE');
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM mlb_players WHERE ${where.join(' AND ')} ORDER BY id`,
  );
  return rows.map((r) => r.id);
}

// ---------- Games ----------

export async function upsertMlbGames(games: MlbScheduleGame[]): Promise<number> {
  if (games.length === 0) return 0;
  await ensureMlbTables();
  const pool = getPool();
  let count = 0;
  for (const g of games) {
    await pool.query(
      `INSERT INTO mlb_games (
         id, season, game_date, home_team_id, away_team_id, home_score, away_score, status, venue
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         season       = EXCLUDED.season,
         game_date    = EXCLUDED.game_date,
         home_team_id = EXCLUDED.home_team_id,
         away_team_id = EXCLUDED.away_team_id,
         home_score   = EXCLUDED.home_score,
         away_score   = EXCLUDED.away_score,
         status       = EXCLUDED.status,
         venue        = EXCLUDED.venue`,
      [
        g.gamePk,
        g.season,
        g.officialDate,
        g.teams.home.team.id,
        g.teams.away.team.id,
        g.teams.home.score ?? null,
        g.teams.away.score ?? null,
        g.status?.detailedState ?? null,
        g.venue?.name ?? null,
      ],
    );
    count += 1;
  }
  return count;
}

// ---------- Hitting / pitching stats from game logs ----------

// Compute singles from totalBases (TB = 1B + 2*2B + 3*3B + 4*HR).
// MLB API doesn't return singles directly, so we derive — saves a
// downstream join when computing per-stat probability distributions.
function deriveSingles(e: MlbGameLogEntry): number | null {
  const hits = e.hits;
  if (hits === undefined) return null;
  return Math.max(
    0,
    hits - (e.doubles ?? 0) - (e.triples ?? 0) - (e.homeRuns ?? 0),
  );
}

export async function upsertMlbHittingStat(
  playerId: number,
  e: MlbGameLogEntry,
): Promise<void> {
  await ensureMlbTables();
  const pool = getPool();
  await pool.query(
    `INSERT INTO mlb_hitting_stats (
       player_id, game_id, team_id, opponent_team_id, is_home,
       plate_appearances, at_bats, hits, singles, doubles, triples,
       home_runs, total_bases, runs, rbis, walks, strikeouts,
       stolen_bases, caught_stealing, hit_by_pitch, batting_order
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (player_id, game_id) DO UPDATE SET
       team_id           = EXCLUDED.team_id,
       opponent_team_id  = EXCLUDED.opponent_team_id,
       is_home           = EXCLUDED.is_home,
       plate_appearances = EXCLUDED.plate_appearances,
       at_bats           = EXCLUDED.at_bats,
       hits              = EXCLUDED.hits,
       singles           = EXCLUDED.singles,
       doubles           = EXCLUDED.doubles,
       triples           = EXCLUDED.triples,
       home_runs         = EXCLUDED.home_runs,
       total_bases       = EXCLUDED.total_bases,
       runs              = EXCLUDED.runs,
       rbis              = EXCLUDED.rbis,
       walks             = EXCLUDED.walks,
       strikeouts        = EXCLUDED.strikeouts,
       stolen_bases      = EXCLUDED.stolen_bases,
       caught_stealing   = EXCLUDED.caught_stealing,
       hit_by_pitch      = EXCLUDED.hit_by_pitch`,
    [
      playerId,
      e.gamePk,
      e.team.id,
      e.opponent.id,
      e.isHome,
      e.plateAppearances ?? null,
      e.atBats ?? null,
      e.hits ?? null,
      deriveSingles(e),
      e.doubles ?? null,
      e.triples ?? null,
      e.homeRuns ?? null,
      e.totalBases ?? null,
      e.runs ?? null,
      e.rbi ?? null,
      e.baseOnBalls ?? null,
      e.strikeOuts ?? null,
      e.stolenBases ?? null,
      e.caughtStealing ?? null,
      e.hitByPitch ?? null,
      null,                                  // batting_order — not in gameLog payload; future enhancement
    ],
  );
}

export async function upsertMlbPitchingStat(
  playerId: number,
  e: MlbGameLogEntry,
): Promise<void> {
  await ensureMlbTables();
  const pool = getPool();
  const innings = inningsPitchedToNumeric(e.inningsPitched);
  // outs_recorded = innings × 3 (rounded). The MLB API doesn't return
  // outs directly on the game-log split, but innings_pitched is exact
  // (e.g. "5.2" = 5 ⅔ = 17 outs).
  const outs = innings === null ? null : Math.round(innings * 3);
  await pool.query(
    `INSERT INTO mlb_pitching_stats (
       player_id, game_id, team_id, opponent_team_id, is_home, is_starter,
       outs_recorded, innings_pitched, pitches_thrown, hits_allowed,
       runs_allowed, earned_runs_allowed, walks_allowed, strikeouts, home_runs_allowed
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (player_id, game_id) DO UPDATE SET
       team_id              = EXCLUDED.team_id,
       opponent_team_id     = EXCLUDED.opponent_team_id,
       is_home              = EXCLUDED.is_home,
       is_starter           = EXCLUDED.is_starter,
       outs_recorded        = EXCLUDED.outs_recorded,
       innings_pitched      = EXCLUDED.innings_pitched,
       pitches_thrown       = EXCLUDED.pitches_thrown,
       hits_allowed         = EXCLUDED.hits_allowed,
       runs_allowed         = EXCLUDED.runs_allowed,
       earned_runs_allowed  = EXCLUDED.earned_runs_allowed,
       walks_allowed        = EXCLUDED.walks_allowed,
       strikeouts           = EXCLUDED.strikeouts,
       home_runs_allowed    = EXCLUDED.home_runs_allowed`,
    [
      playerId,
      e.gamePk,
      e.team.id,
      e.opponent.id,
      e.isHome,
      (e.gamesStarted ?? 0) > 0,
      outs,
      innings,
      e.pitchesThrown ?? null,
      e.hitsAllowed ?? null,
      e.runsAllowed ?? null,
      e.earnedRuns ?? null,
      e.baseOnBallsAllowed ?? null,
      e.strikeOutsThrown ?? null,
      e.homeRunsAllowed ?? null,
    ],
  );
}

// ---------- Counts (for verification / health) ----------

export async function getMlbCounts(): Promise<{
  teams: number;
  players: number;
  games: number;
  hittingStats: number;
  pitchingStats: number;
}> {
  await ensureMlbTables();
  const pool = getPool();
  const { rows } = await pool.query<{
    teams: string;
    players: string;
    games: string;
    hitting_stats: string;
    pitching_stats: string;
  }>(`
    SELECT
      (SELECT COUNT(*)::text FROM mlb_teams)          AS teams,
      (SELECT COUNT(*)::text FROM mlb_players)        AS players,
      (SELECT COUNT(*)::text FROM mlb_games)          AS games,
      (SELECT COUNT(*)::text FROM mlb_hitting_stats)  AS hitting_stats,
      (SELECT COUNT(*)::text FROM mlb_pitching_stats) AS pitching_stats
  `);
  const r = rows[0] ?? {
    teams: '0', players: '0', games: '0', hitting_stats: '0', pitching_stats: '0',
  };
  return {
    teams: Number(r.teams),
    players: Number(r.players),
    games: Number(r.games),
    hittingStats: Number(r.hitting_stats),
    pitchingStats: Number(r.pitching_stats),
  };
}
