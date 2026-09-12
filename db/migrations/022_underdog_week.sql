-- Underdog quick upload: remember WHICH WEEK a saved Underdog file was captured
-- for, so the app can say "this file is from week 1 and you're ranking week 2 —
-- download a fresh one" instead of silently building an upload against a stale
-- contest. Underdog's player IDs change every contest and every week, so a file
-- from last week produces an upload that looks right and is wrong.
--
-- Nullable on purpose: files saved before this migration (and any file whose
-- rankings did not publish a week) simply have no week, and the staleness check
-- stays quiet rather than guessing.
ALTER TABLE underdog_id_sets ADD COLUMN IF NOT EXISTS nfl_week INTEGER;
ALTER TABLE underdog_id_sets ADD COLUMN IF NOT EXISTS season   INTEGER;
