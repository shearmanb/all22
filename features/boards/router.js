// Big Board — hand-built, drag-and-drop player lists independent of any
// ingested rankings (e.g. a personal Zero RB target list). Mounted at
// /api/boards. A board is an ordered list of players_master references; rank is
// the position in the list, rewritten on every reorder.
const express = require('express');
const router = express.Router();

const pool = require('../../db/pool');
const master = require('../../lib/players-master');

const hasDb = () => Boolean(process.env.DATABASE_URL);

// --- Player search (declared before /:id so "players" isn't read as an id) ---
router.get('/players', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    res.json({ ok: true, data: await master.search(String(req.query.q || ''), 20) });
  } catch (err) {
    console.error(`GET /api/boards/players: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Player search failed.' });
  }
});

// --- Boards ---------------------------------------------------------------

router.get('/', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.notes, b.created_at, b.updated_at,
              COUNT(bp.id)::int AS player_count
       FROM boards b
       LEFT JOIN board_players bp ON bp.board_id = b.id
       GROUP BY b.id
       ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC`
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error(`GET /api/boards: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load your boards.' });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Boards need a database (DATABASE_URL is not set).' });
    const name = ((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Give the board a name first.' });
    const { rows } = await pool.query(
      'INSERT INTO boards (name, notes) VALUES ($1, $2) RETURNING id, name, notes, created_at, updated_at',
      [name, (req.body && req.body.notes) ? String(req.body.notes) : null]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`POST /api/boards: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not create that board.' });
  }
});

// Board meta + its ordered players (joined to the canonical player list).
router.get('/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Boards need a database.' });
    const { rows: boardRows } = await pool.query(
      'SELECT id, name, notes, created_at, updated_at FROM boards WHERE id = $1', [req.params.id]
    );
    if (!boardRows.length) return res.status(404).json({ ok: false, error: 'Board not found.' });
    const players = await boardPlayers(req.params.id);
    res.json({ ok: true, data: { board: boardRows[0], players } });
  } catch (err) {
    console.error(`GET /api/boards/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load that board.' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Boards need a database.' });
    const sets = ['updated_at = now()'];
    const params = [req.params.id];
    if (req.body && req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ ok: false, error: 'A board needs a name.' });
      params.push(name); sets.push(`name = $${params.length}`);
    }
    if (req.body && req.body.notes !== undefined) {
      params.push(req.body.notes ? String(req.body.notes) : null);
      sets.push(`notes = $${params.length}`);
    }
    const { rows } = await pool.query(
      `UPDATE boards SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, notes, created_at, updated_at`,
      params
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Board not found.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`PATCH /api/boards/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not update that board.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Boards need a database.' });
    await pool.query('DELETE FROM boards WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    console.error(`DELETE /api/boards/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not delete that board.' });
  }
});

// --- Players on a board ---------------------------------------------------

// Add a player to the bottom of the board. Body: { player_id }.
router.post('/:id/players', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Boards need a database.' });
    const playerId = req.body && req.body.player_id;
    if (!playerId) return res.status(400).json({ ok: false, error: 'Pick a player to add.' });
    const { rows: boardRows } = await pool.query('SELECT id FROM boards WHERE id = $1', [req.params.id]);
    if (!boardRows.length) return res.status(404).json({ ok: false, error: 'Board not found.' });
    const { rows: maxRows } = await pool.query(
      'SELECT COALESCE(MAX(rank), 0) AS max FROM board_players WHERE board_id = $1', [req.params.id]
    );
    await pool.query(
      `INSERT INTO board_players (board_id, player_id, rank) VALUES ($1, $2, $3)
       ON CONFLICT (board_id, player_id) DO NOTHING`,
      [req.params.id, playerId, Number(maxRows[0].max) + 1]
    );
    await pool.query('UPDATE boards SET updated_at = now() WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: { players: await boardPlayers(req.params.id) } });
  } catch (err) {
    console.error(`POST /api/boards/:id/players: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not add that player.' });
  }
});

router.delete('/:id/players/:playerId', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Boards need a database.' });
    await pool.query('DELETE FROM board_players WHERE board_id = $1 AND player_id = $2', [req.params.id, req.params.playerId]);
    await pool.query('UPDATE boards SET updated_at = now() WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: { players: await boardPlayers(req.params.id) } });
  } catch (err) {
    console.error(`DELETE /api/boards/:id/players/:playerId: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not remove that player.' });
  }
});

// Reorder the whole board. Body: { player_ids: [orderedId, ...] }.
router.put('/:id/order', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Boards need a database.' });
    const ids = Array.isArray(req.body && req.body.player_ids) ? req.body.player_ids : [];
    if (!ids.length) return res.status(400).json({ ok: false, error: 'No order was provided.' });
    await client.query('BEGIN');
    let rank = 1;
    for (const pid of ids) {
      await client.query(
        'UPDATE board_players SET rank = $1 WHERE board_id = $2 AND player_id = $3',
        [rank, req.params.id, pid]
      );
      rank++;
    }
    await client.query('UPDATE boards SET updated_at = now() WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, data: { players: await boardPlayers(req.params.id) } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`PUT /api/boards/:id/order: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save the new order.' });
  } finally {
    client.release();
  }
});

// A board's players in rank order, joined to players_master for name/pos/team.
async function boardPlayers(boardId) {
  const { rows } = await pool.query(
    `SELECT bp.player_id, bp.rank, bp.note,
            p.name, p.position, p.team, p.active
     FROM board_players bp
     JOIN players_master p ON p.player_id = bp.player_id
     WHERE bp.board_id = $1
     ORDER BY bp.rank ASC, bp.id ASC`, [boardId]
  );
  return rows;
}

module.exports = router;
