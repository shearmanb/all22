-- Positional vs overall lists. Some sources publish ONE overall list; others
-- publish position-by-position lists (QB, then WR, then RB — block order
-- varies by site). ranking_scope records which kind of list the set IS.
-- Like native_scoring_format, it's part of the input's identity: never
-- rewritten downstream.
--   'overall'    — one cross-position list; the stored rank is the real rank.
--   'positional' — concatenated per-position blocks; the stored rank is just
--                  paste order (it preserves each block's internal order), and
--                  only the rank WITHIN a position is meaningful. That
--                  position rank is derived at read time from list order +
--                  position, so it self-heals as the review queue resolves rows.
ALTER TABLE ranking_sets ADD COLUMN IF NOT EXISTS ranking_scope TEXT NOT NULL DEFAULT 'overall';
ALTER TABLE ranking_sets ADD CONSTRAINT ranking_sets_scope_check
  CHECK (ranking_scope IN ('overall', 'positional'));
