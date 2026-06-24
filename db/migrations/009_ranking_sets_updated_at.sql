-- Rankings Converter: track when a saved ranking set was last replaced.
-- "Load a set → edit → Update" overwrites its players in place; this column
-- reflects that last-saved time so the UI can list sets most-recent-first and
-- show which is current. created_at keeps the original first-saved time.
ALTER TABLE ranking_sets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
