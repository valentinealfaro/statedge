-- StatEdge schema. Run against your Postgres (Neon, local, etc).

-- Used for diacritic-insensitive player search ("jokic" → "Jokić").
CREATE EXTENSION IF NOT EXISTS unaccent;


CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid    TEXT UNIQUE NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  display_name    TEXT,
  plan            TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','elite')),
  stripe_customer TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
  id           INTEGER PRIMARY KEY,         -- NBA team id
  league       TEXT NOT NULL,               -- 'nba' | 'mlb' | 'nfl'
  abbreviation TEXT NOT NULL,
  city         TEXT,
  name         TEXT NOT NULL,
  full_name    TEXT NOT NULL,
  conference   TEXT,
  division     TEXT
);

CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY,          -- NBA player id
  league      TEXT NOT NULL,
  team_id     INTEGER REFERENCES teams(id),
  first_name  TEXT,
  last_name   TEXT,
  full_name   TEXT NOT NULL,
  position    TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS players_full_name_idx ON players (lower(full_name));

CREATE TABLE IF NOT EXISTS games (
  id           BIGINT PRIMARY KEY,           -- NBA game id
  league       TEXT NOT NULL,
  season       TEXT NOT NULL,                -- '2024-25'
  game_date    DATE NOT NULL,
  home_team_id INTEGER REFERENCES teams(id),
  away_team_id INTEGER REFERENCES teams(id),
  home_score   INTEGER,
  away_score   INTEGER,
  status       TEXT                          -- 'scheduled' | 'live' | 'final'
);

CREATE INDEX IF NOT EXISTS games_date_idx ON games (game_date DESC);

CREATE TABLE IF NOT EXISTS player_game_stats (
  player_id   INTEGER NOT NULL REFERENCES players(id),
  game_id     BIGINT  NOT NULL REFERENCES games(id),
  team_id     INTEGER REFERENCES teams(id),
  minutes     NUMERIC,
  points      INTEGER,
  rebounds    INTEGER,
  assists     INTEGER,
  steals      INTEGER,
  blocks      INTEGER,
  turnovers   INTEGER,
  fg_pct      NUMERIC,
  fg3_pct     NUMERIC,
  ft_pct      NUMERIC,
  PRIMARY KEY (player_id, game_id)
);

CREATE INDEX IF NOT EXISTS pgs_player_idx ON player_game_stats (player_id);

CREATE TABLE IF NOT EXISTS team_game_stats (
  team_id     INTEGER NOT NULL REFERENCES teams(id),
  game_id     BIGINT  NOT NULL REFERENCES games(id),
  points      INTEGER,
  rebounds    INTEGER,
  assists     INTEGER,
  fg_pct      NUMERIC,
  fg3_pct     NUMERIC,
  ft_pct      NUMERIC,
  turnovers   INTEGER,
  PRIMARY KEY (team_id, game_id)
);

CREATE TABLE IF NOT EXISTS saved_comparisons (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('player_vs_team','player_vs_player','team_vs_team')),
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS saved_comparisons_user_idx ON saved_comparisons (user_id, created_at DESC);

-- Cached responses for stats.nba.com game-log endpoints. The deployed
-- backend reads from these tables; a local sync job populates them
-- because stats.nba.com blocks datacenter IPs.
CREATE TABLE IF NOT EXISTS player_game_logs (
  player_id   INTEGER NOT NULL,
  season      TEXT NOT NULL,
  games       JSONB NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, season)
);

CREATE TABLE IF NOT EXISTS team_game_logs (
  team_id     INTEGER NOT NULL,
  season      TEXT NOT NULL,
  games       JSONB NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, season)
);

-- Snapshot of the pre-built parlays (Best 2/3/4/5/6 + Wild Card) that
-- were generated and shown on /slate for a given calendar day. Locked
-- on the first /slate/today fetch each day so every visitor sees the
-- same combos and we have a stable record to grade later.
--
-- `combos` is the array as snapshotted (each combo has label + legs[]).
-- `results` is the graded outcome (per-leg actuals + parlay W/L), filled
-- in lazily when a user opens the History tab after games are final.
-- `resolved_at` is null until results have been written.
CREATE TABLE IF NOT EXISTS slate_results (
  slate_date   DATE PRIMARY KEY,
  combos       JSONB NOT NULL,
  results      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS slate_results_date_idx ON slate_results (slate_date DESC);

-- ---------------------------------------------------------------
-- MLB tables. Kept entirely separate from the NBA tables above so
-- the sports stay independent — baseball stats have a fundamentally
-- different shape (hitting vs pitching, no minutes, plate appearances
-- as the unit) and mixing schemas would force lossy compromises.
-- Source of truth: MLB Stats API (statsapi.mlb.com) — public, free,
-- no auth. League column on mlb_teams is AL/NL (not 'mlb' since this
-- table is already MLB-only).
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mlb_teams (
  id            INTEGER PRIMARY KEY,                  -- MLB team id
  abbreviation  TEXT NOT NULL,
  city          TEXT,
  name          TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  league        TEXT NOT NULL CHECK (league IN ('AL', 'NL')),
  division      TEXT
);

CREATE TABLE IF NOT EXISTS mlb_players (
  id           INTEGER PRIMARY KEY,                   -- MLB player id
  team_id      INTEGER REFERENCES mlb_teams(id),
  first_name   TEXT,
  last_name    TEXT,
  full_name    TEXT NOT NULL,
  position     TEXT,
  -- bats / throws allow 'S' (switch) on both sides — switch-throwers
  -- are rare but real (Carlos Cortes / Pat Venditte). Allow NULL too
  -- in case the MLB API returns an unrecognized code we coerce away.
  bats         TEXT CHECK (bats IS NULL OR bats IN ('L', 'R', 'S')),
  throws       TEXT CHECK (throws IS NULL OR throws IN ('L', 'R', 'S')),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  -- Generated column so route handlers can query "give me pitchers"
  -- without recomputing — drives the type-restriction rule (pitchers
  -- can't be queried for hitter stats and vice versa).
  is_pitcher   BOOLEAN GENERATED ALWAYS AS (position = 'P') STORED
);

CREATE INDEX IF NOT EXISTS mlb_players_full_name_idx ON mlb_players (lower(full_name));
CREATE INDEX IF NOT EXISTS mlb_players_pitcher_idx   ON mlb_players (is_pitcher);

CREATE TABLE IF NOT EXISTS mlb_games (
  id            BIGINT PRIMARY KEY,                   -- MLB gamePk
  season        TEXT NOT NULL,                        -- '2026'
  game_date     DATE NOT NULL,
  home_team_id  INTEGER REFERENCES mlb_teams(id),
  away_team_id  INTEGER REFERENCES mlb_teams(id),
  home_score    INTEGER,
  away_score    INTEGER,
  status        TEXT,                                 -- 'Final', 'Live', 'Scheduled', 'Postponed', etc.
  venue         TEXT
);

CREATE INDEX IF NOT EXISTS mlb_games_date_idx   ON mlb_games (game_date DESC);
CREATE INDEX IF NOT EXISTS mlb_games_team_idx   ON mlb_games (home_team_id, away_team_id);
CREATE INDEX IF NOT EXISTS mlb_games_season_idx ON mlb_games (season);

-- Hitter game-by-game stats. PK is (player_id, game_id) so a player
-- only appears once per game. Doubleheaders use distinct game_ids
-- so they don't collide. Walks + HBP captured separately because
-- PrizePicks/DraftKings list "hits" without HBP — but reach-base
-- props need both.
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

-- Pitcher game-by-game stats. is_starter distinguishes starts from
-- relief appearances since prop markets price them very differently
-- (starter K props vs reliever K props are different stats).
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

-- Every projection we emit gets a row here. Drives calibration
-- (predicted vs actual hit rate per bucket) once games grade. inputs_json
-- captures the snapshot of context that fed the projection so we can
-- replay what the model saw at lock time.
CREATE TABLE IF NOT EXISTS mlb_projection_history (
  id                SERIAL PRIMARY KEY,
  created_at        TIMESTAMP DEFAULT NOW(),
  game_date         DATE,
  player_id         INTEGER REFERENCES mlb_players(id),
  team_id           INTEGER REFERENCES mlb_teams(id),
  opponent_team_id  INTEGER REFERENCES mlb_teams(id),
  selected_stat     TEXT,
  line_value        NUMERIC,
  direction         TEXT,                              -- 'OVER' | 'UNDER'
  projection_value  NUMERIC,
  probability       NUMERIC,                           -- 0-100
  confidence_score  NUMERIC,                           -- 0-100
  risk_score        NUMERIC,                           -- 0-100
  trap_score        NUMERIC,                           -- 0-100
  edge_score        NUMERIC,                           -- 0-100
  ev_score          NUMERIC,
  card_type         TEXT,                              -- 'Best 2', 'Wild Card', etc.
  model_version     TEXT,
  inputs_json       JSONB,
  result_value      NUMERIC,
  hit_or_miss       BOOLEAN,
  graded_at         TIMESTAMP
);

CREATE INDEX IF NOT EXISTS mlb_proj_history_date_idx   ON mlb_projection_history (game_date DESC);
CREATE INDEX IF NOT EXISTS mlb_proj_history_player_idx ON mlb_projection_history (player_id);
