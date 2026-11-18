-- Pay Dirt: a slate can also carry DraftKings' salaries for the same week, so
-- the page can show where the two sites price a player differently (FanDuel vs
-- DraftKings arbitrage). Stored verbatim like the FanDuel file — either DK's
-- own "Export to CSV" or the same columns built from DK's public draftables
-- feed — and compared on read. dk_source says where it came from (shown on the
-- page); dk_at is when it was attached. All nullable: a slate without DK
-- salaries is exactly the slate it always was.
ALTER TABLE dfs_slates ADD COLUMN IF NOT EXISTS dk_salaries TEXT;
ALTER TABLE dfs_slates ADD COLUMN IF NOT EXISTS dk_source TEXT;
ALTER TABLE dfs_slates ADD COLUMN IF NOT EXISTS dk_at TIMESTAMPTZ;
