// Pay Dirt — projected fantasy points per FanDuel dollar. Mounted at /api/paydirt.
// The join itself is pure (lib/value.js); this router only stores the two
// uploaded files per slate and recomputes the table from them on read.
const express = require('express');
const pool = require('../../db/pool');
const value = require('./lib/value');
const underdogQuick = require('../combine/lib/underdog-quick');

const router = express.Router();
const hasDb = () => Boolean(process.env.DATABASE_URL);

function compute(projections, salaries) {
  const out = value.build(projections, salaries);
  const meta = underdogQuick.detectMeta(projections);
  out.week = meta.week;
  out.season = meta.season;
  return out;
}

// Build the table from two uploaded files without saving anything.
// Body: { projections, salaries }.
router.post('/build', (req, res) => {
  try {
    const { projections, salaries } = req.body || {};
    if (!projections || !String(projections).trim()) return res.status(400).json({ ok: false, error: 'Choose the Fantasy Points projections file first (step 1).' });
    if (!salaries || !String(salaries).trim()) return res.status(400).json({ ok: false, error: 'Choose the FanDuel salaries file or paste them (step 2).' });
    let data;
    try { data = compute(String(projections), String(salaries)); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`POST /api/paydirt/build: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not build the points-per-dollar table.' });
  }
});

router.get('/slates', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    const { rows } = await pool.query('SELECT id, name, nfl_week, season, created_at FROM dfs_slates ORDER BY created_at DESC LIMIT 100');
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error(`GET /api/paydirt/slates: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load saved slates.' });
  }
});

// Save a slate. Body: { name, projections, salaries }.
router.post('/slates', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saving slates needs a database (DATABASE_URL is not set).' });
    const { projections, salaries } = req.body || {};
    let data;
    try { data = compute(String(projections || ''), String(salaries || '')); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    const name = String((req.body || {}).name || '').trim() || (data.week ? `FanDuel Week ${data.week}` : 'FanDuel slate');
    const { rows } = await pool.query(
      'INSERT INTO dfs_slates (name, nfl_week, season, projections, salaries) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, nfl_week, season, created_at',
      [name, data.week, data.season, String(projections), String(salaries)]
    );
    res.json({ ok: true, data: Object.assign(data, { slate: rows[0] }) });
  } catch (err) {
    console.error(`POST /api/paydirt/slates: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save that slate.' });
  }
});

router.get('/slates/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved slates need a database.' });
    const { rows } = await pool.query('SELECT id, name, nfl_week, season, created_at, projections, salaries FROM dfs_slates WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'That saved slate no longer exists.' });
    const s = rows[0];
    let data;
    try { data = compute(s.projections, s.salaries); } catch (e) { return res.status(400).json({ ok: false, error: `That saved slate could not be read: ${e.message}` }); }
    res.json({ ok: true, data: Object.assign(data, { slate: { id: s.id, name: s.name, nfl_week: s.nfl_week, season: s.season, created_at: s.created_at } }) });
  } catch (err) {
    console.error(`GET /api/paydirt/slates/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load that slate.' });
  }
});

router.delete('/slates/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved slates need a database.' });
    await pool.query('DELETE FROM dfs_slates WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: { id: Number(req.params.id) } });
  } catch (err) {
    console.error(`DELETE /api/paydirt/slates/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not delete that slate.' });
  }
});

module.exports = router;
