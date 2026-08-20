-- 021: War Room — the live draft recorder (PRD Phase 5's first slice).
-- Reuses Playbook's drafts/picks tables so a finished live draft flows straight
-- into the existing draft-detail analysis. New columns + uniqueness guards for
-- concurrent recorders.

-- Picks gain identity (SESSION_PLAN Phase 3: resolve to player_id), provenance
-- (which phone recorded it), and a price slot for the auction variant later.
ALTER TABLE picks ADD COLUMN IF NOT EXISTS player_id INT REFERENCES players_master(player_id);
ALTER TABLE picks ADD COLUMN IF NOT EXISTS recorded_by TEXT;
ALTER TABLE picks ADD COLUMN IF NOT EXISTS pick_price NUMERIC;
CREATE INDEX IF NOT EXISTS picks_player_id_idx ON picks(player_id);

-- Conflict safety for two people recording at once. Legacy hand-pasted drafts
-- could hold duplicate rows these indexes reject, so creation must never brick
-- boot: try, and on failure log + skip (the router enforces uniqueness in its
-- transactions regardless — the index is belt-and-braces, not the only guard).
DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS picks_draft_overall_uq ON picks(draft_id, overall_pick);
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'skipping picks_draft_overall_uq (legacy duplicates?): %', SQLERRM;
  END;
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS picks_draft_player_uq ON picks(draft_id, player_id)
      WHERE player_id IS NOT NULL;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'skipping picks_draft_player_uq (legacy duplicates?): %', SQLERRM;
  END;
END $$;

-- Drafts gain a live-draft lifecycle + the sync version counter. Every legacy
-- row is by definition finished, so the default is 'complete'; only War Room
-- creates rows as 'live'.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS rounds INT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS league_profile_id TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS my_ranking_run_id INT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
