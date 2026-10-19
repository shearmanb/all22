-- One Fantasy Points weekly export, entered once, used everywhere. The Underdog
-- quick upload and Pay Dirt both read the same file (its order is the Underdog
-- ranking, its FPTS column is Pay Dirt's projection), so it is saved here the
-- moment it is chosen on either page and both pages offer the newest one.
-- Stored verbatim; each page parses it the way it always has.
--
-- has_projections marks files Pay Dirt can use (an FPTS column), so a plain
-- rankings list saved from the Underdog page never shows up there.
CREATE TABLE IF NOT EXISTS fp_rankings_files (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  nfl_week         INTEGER,
  season           INTEGER,
  row_count        INTEGER,
  has_projections  BOOLEAN NOT NULL DEFAULT false,
  file_modified    TIMESTAMPTZ,
  rankings         TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
