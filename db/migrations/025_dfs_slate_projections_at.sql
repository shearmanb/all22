-- Fantasy Points re-publishes its projections a few times over a weekend, so a
-- Pay Dirt slate can swap in a newer projections file while keeping its FanDuel
-- salaries. projections_at is when the slate's projections were last set; the
-- page offers any newer same-week file saved after it. NULL = created_at.
ALTER TABLE dfs_slates ADD COLUMN IF NOT EXISTS projections_at TIMESTAMPTZ;
