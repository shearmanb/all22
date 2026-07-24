-- 020_playbook_picks_identity: Phase 3 — Playbook grows up (SESSION_PLAN).
-- Picks resolve to players_master so draft analysis (value vs ADP, reaches/
-- steals) can join adp_history and my_rankings by player_id instead of by
-- name. Identity rule (CLAUDE.md): only high-confidence matches get a
-- player_id; anything fuzzier keeps NULL with the raw player_name preserved —
-- visible as "unmatched" on the draft page, never a silent guess.
ALTER TABLE picks ADD COLUMN IF NOT EXISTS player_id INT REFERENCES players_master(player_id) ON DELETE SET NULL;
-- How the match was made ('high'|'medium'|'low'|'none'; NULL = never attempted,
-- which is what tells the analysis endpoint a pick still needs resolving).
ALTER TABLE picks ADD COLUMN IF NOT EXISTS match_confidence TEXT;
ALTER TABLE picks ADD COLUMN IF NOT EXISTS match_via TEXT;
CREATE INDEX IF NOT EXISTS picks_player_idx ON picks(player_id);
