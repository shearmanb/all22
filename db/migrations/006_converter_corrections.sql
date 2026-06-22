-- Rankings Converter: the "fix queue".
-- When OCR can't get a player's team/position (or reads it wrong), the owner
-- corrects it once in the preview and remembers it. We store the fix keyed on
-- the canonical name key (lib/players.js key()) so every future import for that
-- player is auto-filled. team/position are nullable: a fix may set either or both.
CREATE TABLE IF NOT EXISTS converter_corrections (
  id          SERIAL PRIMARY KEY,
  name_key    TEXT NOT NULL UNIQUE, -- players.key(name); the match key
  name        TEXT NOT NULL,        -- display name as last entered (for the UI)
  team        TEXT,                 -- canonical team abbr to force, or NULL
  position    TEXT,                 -- position to force, or NULL
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
