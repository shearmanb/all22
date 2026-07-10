-- 018_adp_myrankings: Edge Rush's ADP collector dimensions + My Rankings run
-- metadata. Both tables were created ahead of time in 012; this fills in what
-- actually building the features showed they need.

-- adp_history: a snapshot row is identified by WHERE it came from (site),
-- WHAT it measures (scoring format + league size — the same ADP differs a lot
-- between 12-team PPR and 14-team standard), and WHEN. FFC also publishes the
-- pick distribution (high/low/stdev/times drafted) — kept because War Room's
-- "% still available" math needs a distribution, not just the mean (PRD §17.4).
ALTER TABLE adp_history ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE adp_history ADD COLUMN IF NOT EXISTS teams INT NOT NULL DEFAULT 12;
ALTER TABLE adp_history ADD COLUMN IF NOT EXISTS raw_position TEXT NOT NULL DEFAULT '';
ALTER TABLE adp_history ADD COLUMN IF NOT EXISTS raw_team TEXT NOT NULL DEFAULT '';
ALTER TABLE adp_history ADD COLUMN IF NOT EXISTS bye INT;
ALTER TABLE adp_history ADD COLUMN IF NOT EXISTS high NUMERIC;
ALTER TABLE adp_history ADD COLUMN IF NOT EXISTS low NUMERIC;
ALTER TABLE adp_history ADD COLUMN IF NOT EXISTS stdev NUMERIC;
ALTER TABLE adp_history ADD COLUMN IF NOT EXISTS times_drafted INT;

-- One row per player per (site, format, teams) snapshot per day — re-collecting
-- the same day replaces rather than duplicates (the collector deletes the day's
-- slice first; this index backstops it).
CREATE UNIQUE INDEX IF NOT EXISTS adp_history_snapshot_key
  ON adp_history(site, format, teams, snapshot_date, raw_name);

-- players_master learns each row's Sleeper ID so Sleeper-sourced datasets
-- (their ADP feed, later their drafts) join EXACTLY by id instead of by name.
-- Filled by the daily Sleeper sync; clearing the sync stamp below forces a
-- resync on the next boot so the column populates immediately.
ALTER TABLE players_master ADD COLUMN IF NOT EXISTS sleeper_id TEXT;
CREATE INDEX IF NOT EXISTS players_master_sleeper_idx ON players_master(sleeper_id);
DELETE FROM settings WHERE key = 'players_master.synced_at';

-- my_ranking_runs: a human label so saved runs read as "Draft prep v3", not
-- "run #7". Settings JSONB (dial snapshot) was already there from 012.
ALTER TABLE my_ranking_runs ADD COLUMN IF NOT EXISTS name TEXT;

-- my_rankings: per-player computation detail frozen at save time (per-set
-- votes, avg/min/max/stdev/count, position rank) so a saved run stays exactly
-- what it was even if the source sets are later edited or deleted.
ALTER TABLE my_rankings ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL DEFAULT '{}'::jsonb;
