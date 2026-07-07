-- 016_auction_value_source: War Chest learns where its player values come from.
-- value_set_id pins an auction to one ingested ranking set that carries auction
-- values (e.g. "Yahoo AAV" or "FantasyPros AAV" imported via Combine); NULL
-- means "latest value from any set". price_mult_pct is the expensive-league
-- dial: assumed prices = value × (1 + pct/100), editable on the dashboard.
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS value_set_id INT REFERENCES ranking_sets(id) ON DELETE SET NULL;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS price_mult_pct NUMERIC NOT NULL DEFAULT 0;
