-- Rankings Converter: learned name aliases ("remember this player").
-- A curated seed list lives in code (lib/aliases.js). When the owner fixes a
-- misread/nicknamed name in the preview and chooses to remember it, we store the
-- variant -> canonical mapping here so every future import auto-resolves it.
-- Keyed on the canonical name key (lib/players.js key()) of the VARIANT spelling.
CREATE TABLE IF NOT EXISTS converter_aliases (
  id          SERIAL PRIMARY KEY,
  alias_key   TEXT NOT NULL UNIQUE,  -- players.key(alias); the match key
  alias       TEXT NOT NULL,         -- the variant spelling as entered (for the UI)
  canonical   TEXT NOT NULL,         -- the correct full name to resolve to
  source      TEXT,                  -- optional: which site this quirk came from
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
