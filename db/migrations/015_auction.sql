-- 015_auction: War Chest — the auction budget calculator (web version of the
-- owner's Auction_calc spreadsheet). An auction is a budget plan: one row per
-- roster slot with a planned $ (the sheet's EST column), the player you got and
-- what you actually paid (ACT). paid IS NULL = slot still open. Targets are the
-- sheet's Must Haves / Wants / watch lists with expected prices.
CREATE TABLE IF NOT EXISTS auctions (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  teams      INT NOT NULL DEFAULT 12,
  budget     NUMERIC NOT NULL DEFAULT 200,
  roster     JSONB NOT NULL DEFAULT '{"QB":1,"RB":2,"WR":3,"TE":1,"FLEX":2,"K":1,"DST":1,"BN":6}'::jsonb,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auction_slots (
  id          SERIAL PRIMARY KEY,
  auction_id  INT NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  slot        TEXT NOT NULL,   -- QB | RB | WR | TE | FLEX | K | DST | BN
  slot_num    INT NOT NULL,    -- RB1, RB2, ... within a slot type
  plan        NUMERIC,         -- planned $ for this slot (EST)
  player_id   INT REFERENCES players_master(player_id) ON DELETE SET NULL,
  player_name TEXT,            -- display name; kept even when not linked to players_master
  paid        NUMERIC,         -- actual $ once won (ACT); NULL = slot still open
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (auction_id, slot, slot_num)
);
CREATE INDEX IF NOT EXISTS auction_slots_auction_idx ON auction_slots(auction_id);

CREATE TABLE IF NOT EXISTS auction_targets (
  id          SERIAL PRIMARY KEY,
  auction_id  INT NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  tier        TEXT NOT NULL DEFAULT 'want' CHECK (tier IN ('must', 'want', 'watch')),
  player_id   INT REFERENCES players_master(player_id) ON DELETE SET NULL,
  player_name TEXT NOT NULL,
  est         NUMERIC,          -- what you expect him to go for
  gone        BOOLEAN NOT NULL DEFAULT false,  -- off the board (someone else got him)
  sort        INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auction_targets_auction_idx ON auction_targets(auction_id);
