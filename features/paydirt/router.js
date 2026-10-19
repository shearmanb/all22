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

// One saved slate, recomputed, plus the newest same-week Fantasy Points file
// saved after this slate's projections were set (Fantasy Points re-publishes
// over the weekend) — so the page can offer a one-tap update. Returns
// { status, error } or { data }.
async function loadSlate(id) {
  const { rows } = await pool.query(
    'SELECT id, name, nfl_week, season, created_at, projections_at, projections, salaries FROM dfs_slates WHERE id = $1', [id]
  );
  if (!rows.length) return { status: 404, error: 'That saved slate no longer exists.' };
  const s = rows[0];
  let data;
  try { data = compute(s.projections, s.salaries); } catch (e) { return { status: 400, error: `That saved slate could not be read: ${e.message}` }; }
  const since = s.projections_at || s.created_at;
  const { rows: newer } = await pool.query(
    `SELECT id, name, nfl_week, file_modified, created_at FROM fp_rankings_files
      WHERE has_projections AND created_at > $1 AND rankings <> $2
        AND ($3::int IS NULL OR nfl_week IS NULL OR nfl_week = $3)
      ORDER BY created_at DESC LIMIT 1`,
    [since, s.projections, s.nfl_week]
  );
  data.slate = { id: s.id, name: s.name, nfl_week: s.nfl_week, season: s.season, created_at: s.created_at, projections_at: since };
  data.newer_projections = newer[0] || null;
  return { data };
}

router.get('/slates/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved slates need a database.' });
    const out = await loadSlate(req.params.id);
    if (out.error) return res.status(out.status).json({ ok: false, error: out.error });
    res.json({ ok: true, data: out.data });
  } catch (err) {
    console.error(`GET /api/paydirt/slates/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load that slate.' });
  }
});

// Swap a slate's projections for a saved Fantasy Points file, keeping its
// FanDuel salaries. Body: { fp_file_id }.
router.post('/slates/:id/projections', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved slates need a database.' });
    const fpId = (req.body || {}).fp_file_id;
    const { rows: fp } = await pool.query('SELECT rankings FROM fp_rankings_files WHERE id = $1', [fpId]);
    if (!fp.length) return res.status(404).json({ ok: false, error: 'That Fantasy Points file no longer exists.' });
    const { rows: sl } = await pool.query('SELECT salaries FROM dfs_slates WHERE id = $1', [req.params.id]);
    if (!sl.length) return res.status(404).json({ ok: false, error: 'That saved slate no longer exists.' });
    let check;
    try { check = compute(fp[0].rankings, sl[0].salaries); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    await pool.query(
      'UPDATE dfs_slates SET projections = $2, nfl_week = COALESCE($3, nfl_week), season = COALESCE($4, season), projections_at = now() WHERE id = $1',
      [req.params.id, fp[0].rankings, check.week, check.season]
    );
    const out = await loadSlate(req.params.id);
    if (out.error) return res.status(out.status).json({ ok: false, error: out.error });
    res.json({ ok: true, data: out.data });
  } catch (err) {
    console.error(`POST /api/paydirt/slates/:id/projections: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not update that slate\'s projections.' });
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
