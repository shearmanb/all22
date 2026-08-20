-- 020: per-player notes on an ingested ranking row.
-- Sources increasingly publish a comment/analysis column next to each player
-- ("elite dual-threat", "post-hype, injury risk"). We capture it verbatim on
-- the raw row so it survives review and shows up next to the player, and so
-- the owner can jot his own note on any row.
ALTER TABLE rankings_raw ADD COLUMN IF NOT EXISTS notes TEXT;
