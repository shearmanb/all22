-- 013_auction_values: optional per-row auction dollar value on ingested rows.
-- Not every source publishes auction values, so the column is nullable and stays
-- NULL for rank-only lists. It rides on rankings_raw because it's part of the
-- input's captured identity (like rank), never rewritten downstream.
ALTER TABLE rankings_raw ADD COLUMN IF NOT EXISTS auction_value NUMERIC;
