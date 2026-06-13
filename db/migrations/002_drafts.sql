CREATE TABLE IF NOT EXISTS drafts (
  id              SERIAL PRIMARY KEY,
  site            TEXT NOT NULL,
  draft_type      TEXT NOT NULL,
  drafted_at      DATE NOT NULL,
  league_size     INT NOT NULL,
  my_slot         INT NOT NULL,
  strategy        TEXT,
  suggested_strategy TEXT,
  rating          INT CHECK (rating >= 1 AND rating <= 5),
  notes           TEXT,
  source          TEXT NOT NULL DEFAULT 'manual',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS picks (
  id           SERIAL PRIMARY KEY,
  draft_id     INT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  overall_pick INT NOT NULL,
  round        INT NOT NULL,
  player_name  TEXT NOT NULL,
  position     TEXT,
  nfl_team     TEXT,
  draft_slot   INT,
  is_my_pick   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS picks_draft_id_idx ON picks(draft_id);
