-- Rankings Converter: persistent NFL roster cache.
-- roster.js fetches Sleeper's full player list (~5MB) and keeps it in memory for
-- a day. Railway containers are ephemeral, so a cold start (or a Sleeper outage)
-- would otherwise leave name-enrichment blank until a fresh fetch succeeds. We
-- persist the de-duped list here so the matcher always has a roster to fall back
-- on. Single row (id = 1), upserted on each successful fetch.
CREATE TABLE IF NOT EXISTS roster_cache (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  players     JSONB NOT NULL,        -- [{ name, position, team, active, skill }]
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT roster_cache_single_row CHECK (id = 1)
);
