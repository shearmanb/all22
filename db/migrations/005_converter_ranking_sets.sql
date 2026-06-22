-- Rankings Converter: saved ranking sets.
-- A ranking set is one ordered list of players (the canonical "source" rankings
-- the owner pasted/OCR'd), stored as JSON so the converter can re-export it to
-- any output format later without re-parsing.
CREATE TABLE IF NOT EXISTS ranking_sets (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  source      TEXT,                 -- free-text note: where these rankings came from
  players     JSONB NOT NULL,       -- [{ rank, name, position, team }]
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
