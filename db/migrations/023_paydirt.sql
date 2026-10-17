-- Pay Dirt: one saved slate per week — the Fantasy Points projections export
-- and the FanDuel salaries, stored exactly as uploaded. The points-per-dollar
-- table is recomputed from these on every read, so a name taught to the player
-- list later (an alias) fixes an old slate's misses too. Keeping the raw files
-- is what lets the owner upload on a laptop and sort/search on his phone.
CREATE TABLE IF NOT EXISTS dfs_slates (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  nfl_week     INTEGER,
  season       INTEGER,
  projections  TEXT NOT NULL,
  salaries     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
