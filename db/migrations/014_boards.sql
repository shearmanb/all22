-- 014_boards: Big Board — hand-built, drag-and-drop player lists that are
-- independent of any ingested rankings (e.g. a personal Zero RB target list).
-- A board is just an ordered set of players_master references; rank = position
-- in the list, rewritten on every reorder.
CREATE TABLE IF NOT EXISTS boards (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS board_players (
  id         SERIAL PRIMARY KEY,
  board_id   INT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  player_id  INT NOT NULL REFERENCES players_master(player_id) ON DELETE CASCADE,
  rank       INT NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (board_id, player_id)   -- a player appears at most once per board
);
CREATE INDEX IF NOT EXISTS board_players_board_idx ON board_players(board_id);
