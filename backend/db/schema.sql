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
