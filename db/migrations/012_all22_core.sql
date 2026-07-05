-- 012_all22_core: the All22 rebuild's core schema (PRD §5).
-- Everything joins on players_master.player_id — the linchpin. Legacy tables
-- (picks, converter_aliases, converter_corrections, underdog_id_sets,
-- roster_cache) are left untouched; drafts/picks are reused as-is by Playbook.

-- The canonical player registry. Seeded and refreshed from Sleeper's free
-- public player list at runtime; rows the owner adds by hand get source
-- 'manual' and are never clobbered by a sync. aliases is the per-site alias
-- map: { "underdog": ["Marquise Brown"], "common": ["Hollywood Brown"] }.
CREATE TABLE IF NOT EXISTS players_master (
  player_id   SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,   -- lib/players.key(name); the match key
  position    TEXT NOT NULL DEFAULT '',
  team        TEXT NOT NULL DEFAULT '',
  aliases     JSONB NOT NULL DEFAULT '{}'::jsonb,
  active      BOOLEAN NOT NULL DEFAULT true,
  source      TEXT NOT NULL DEFAULT 'sleeper',  -- sleeper | manual
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ranking_sets predates this rebuild (005): it becomes the set-level metadata
-- for rankings_raw. Its legacy JSONB `players` column stays as a read-only
-- archive of pre-rebuild saves (backfilled into rankings_raw below); new sets
-- leave it NULL. Native scoring format is the format the source was PUBLISHED
-- in and is never rewritten (PRD §12/§13).
ALTER TABLE ranking_sets ALTER COLUMN players DROP NOT NULL;
ALTER TABLE ranking_sets ADD COLUMN IF NOT EXISTS native_scoring_format TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE ranking_sets ADD COLUMN IF NOT EXISTS captured_on DATE;
ALTER TABLE ranking_sets ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE ranking_sets ADD CONSTRAINT ranking_sets_format_check
  CHECK (native_scoring_format IN ('ppr', 'half', 'standard', 'best_ball', 'superflex', 'unknown'))
  NOT VALID;  -- legacy rows default to 'unknown', which the check allows anyway

-- Every ingested ranking row, exactly as captured (post-OCR / post-parse text,
-- before any identity decision). Append-only from the app's point of view.
CREATE TABLE IF NOT EXISTS rankings_raw (
  id           SERIAL PRIMARY KEY,
  set_id       INT NOT NULL REFERENCES ranking_sets(id) ON DELETE CASCADE,
  rank         INT NOT NULL,
  raw_name     TEXT NOT NULL,
  raw_position TEXT NOT NULL DEFAULT '',
  raw_team     TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rankings_raw_set_idx ON rankings_raw(set_id);

-- A raw row resolved to a canonical player. A raw row with NO row here is
-- unmatched — that's the review queue. confidence records how sure the matcher
-- was; confirmed means the owner accepted/made the match by hand.
CREATE TABLE IF NOT EXISTS rankings_normalized (
  id          SERIAL PRIMARY KEY,
  raw_id      INT NOT NULL UNIQUE REFERENCES rankings_raw(id) ON DELETE CASCADE,
  set_id      INT NOT NULL REFERENCES ranking_sets(id) ON DELETE CASCADE,
  player_id   INT NOT NULL REFERENCES players_master(player_id) ON DELETE CASCADE,
  rank        INT NOT NULL,
  confidence  TEXT NOT NULL DEFAULT 'high',   -- high | medium | low
  matched_via TEXT NOT NULL DEFAULT '',
  confirmed   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rankings_normalized_set_idx ON rankings_normalized(set_id);
CREATE INDEX IF NOT EXISTS rankings_normalized_player_idx ON rankings_normalized(player_id);

-- Backfill: every pre-rebuild saved set becomes raw rows (rank = list order,
-- which is how the converter always ranked). Normalization happens at runtime
-- via the Combine "re-match" action, not in SQL — matching lives in JS.
INSERT INTO rankings_raw (set_id, rank, raw_name, raw_position, raw_team, created_at)
SELECT s.id, p.ord, p.elem->>'name',
       COALESCE(p.elem->>'position', ''), COALESCE(p.elem->>'team', ''), s.created_at
FROM ranking_sets s
CROSS JOIN LATERAL jsonb_array_elements(s.players) WITH ORDINALITY AS p(elem, ord)
WHERE s.players IS NOT NULL
  AND COALESCE(p.elem->>'name', '') <> ''
  AND NOT EXISTS (SELECT 1 FROM rankings_raw r WHERE r.set_id = s.id);

-- Output of the custom ranking model (Phase 2 — table created now so the
-- schema isn't blocked; not written yet). One run = one versioned output.
CREATE TABLE IF NOT EXISTS my_ranking_runs (
  id            SERIAL PRIMARY KEY,
  target_format TEXT NOT NULL DEFAULT 'half',
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- dial snapshot for the run
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS my_rankings (
  id         SERIAL PRIMARY KEY,
  run_id     INT NOT NULL REFERENCES my_ranking_runs(id) ON DELETE CASCADE,
  player_id  INT NOT NULL REFERENCES players_master(player_id) ON DELETE CASCADE,
  rank       INT NOT NULL,
  score      NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS my_rankings_run_idx ON my_rankings(run_id);

-- Daily ADP snapshots per site (Phase 4 — Edge Rush scraper; created now).
-- raw_name keeps the site's spelling so an unmatched snapshot row is
-- reviewable later instead of lost.
CREATE TABLE IF NOT EXISTS adp_history (
  id            SERIAL PRIMARY KEY,
  site          TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  player_id     INT REFERENCES players_master(player_id) ON DELETE SET NULL,
  raw_name      TEXT NOT NULL DEFAULT '',
  adp           NUMERIC NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adp_history_site_date_idx ON adp_history(site, snapshot_date);

-- Fast scratchpad ("that's interesting" — jot now, research later).
CREATE TABLE IF NOT EXISTS notes (
  id         SERIAL PRIMARY KEY,
  body       TEXT NOT NULL,
  done       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Control-panel values: every tweakable dial lives here, never in code.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
