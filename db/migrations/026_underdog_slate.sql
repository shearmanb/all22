-- Underdog runs more than one weekly contest with its own player pool and its
-- own IDs: the main slate (every game) and the late slate (afternoon games
-- only). The owner builds an upload for each, so a saved Underdog file carries
-- WHICH slate it is, and the weekly page keeps one file per slate per week
-- instead of one file per week. Files saved before this were all main-slate
-- downloads, hence the default.
ALTER TABLE underdog_id_sets ADD COLUMN IF NOT EXISTS slate TEXT NOT NULL DEFAULT 'main';
