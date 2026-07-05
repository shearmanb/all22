// Notes — the fast scratchpad (PRD §6: jot now, research later).
// Mounted at /api/notes.
const express = require('express');
const pool = require('../../db/pool');

const router = express.Router();
const hasDb = () => Boolean(process.env.DATABASE_URL);

router.get('/', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    const { rows } = await pool.query(
      'SELECT id, body, done, created_at, updated_at FROM notes ORDER BY done ASC, created_at DESC LIMIT 500'
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error(`GET /api/notes: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load notes.' });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Notes need a database (DATABASE_URL is not set).' });
    const body = ((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ ok: false, error: 'Write something first.' });
    const { rows } = await pool.query(
      'INSERT INTO notes (body) VALUES ($1) RETURNING id, body, done, created_at, updated_at',
      [body]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`POST /api/notes: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save that note.' });
  }
});

// Edit text and/or toggle done. Body: { body?, done? }.
router.patch('/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Notes need a database.' });
    const sets = ['updated_at = now()'];
    const params = [req.params.id];
    if (req.body && req.body.body !== undefined) {
      const text = String(req.body.body).trim();
      if (!text) return res.status(400).json({ ok: false, error: 'A note cannot be empty — delete it instead.' });
      params.push(text);
      sets.push(`body = $${params.length}`);
    }
    if (req.body && req.body.done !== undefined) {
      params.push(!!req.body.done);
      sets.push(`done = $${params.length}`);
    }
    const { rows } = await pool.query(
      `UPDATE notes SET ${sets.join(', ')} WHERE id = $1 RETURNING id, body, done, created_at, updated_at`,
      params
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Note not found.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`PATCH /api/notes/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not update that note.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Notes need a database.' });
    await pool.query('DELETE FROM notes WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    console.error(`DELETE /api/notes/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not delete that note.' });
  }
});

module.exports = router;
