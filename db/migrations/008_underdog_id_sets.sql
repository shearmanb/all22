-- Rankings Converter: saved Underdog "rankings with IDs" files.
-- Underdog's downloadable rankings CSV contains their exact per-contest player
-- IDs (a UUID per player). Those IDs change every contest/season, so we never
-- hardcode them — the owner uploads the current file per contest and we store
-- it here (raw, byte-for-byte) so the converter can reorder it to match a ranked
-- list and hand back an upload-ready file. Multiple rows = a list of contests.
CREATE TABLE IF NOT EXISTS underdog_id_sets (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,            -- contest label, e.g. "Best Ball preseason"
  csv          TEXT NOT NULL,            -- the raw Underdog CSV, kept exactly as uploaded
  player_count INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
