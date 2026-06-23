-- News aggregator: cache fetched feed items so the homepage loads fast and
-- still shows the last-known headlines when a source is briefly unreachable.
-- We store only the lightweight bits needed to skim and link out (title, url,
-- short summary, date) — never full article bodies, so this is a link list,
-- not a mirror.

CREATE TABLE IF NOT EXISTS news_items (
  id           SERIAL PRIMARY KEY,
  source_key   TEXT NOT NULL,
  guid         TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL DEFAULT '',
  summary      TEXT,
  author       TEXT,
  published_at TIMESTAMPTZ,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_key, guid)
);

CREATE INDEX IF NOT EXISTS news_items_source_published_idx
  ON news_items (source_key, published_at DESC NULLS LAST);

-- Per-source fetch status so the homepage can show "couldn't refresh" in the
-- open instead of silently showing stale data.
CREATE TABLE IF NOT EXISTS news_source_status (
  source_key      TEXT PRIMARY KEY,
  last_fetched_at TIMESTAMPTZ,
  last_ok         BOOLEAN,
  last_error      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
