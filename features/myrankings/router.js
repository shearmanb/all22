// My Rankings — the custom model, phase-2 seed (PRD §8), mounted at
// /api/myrankings. v1 is the mini-ECR: pick ingested ranking sets, weight
// them, and blend a consensus (overall + per-position), then save versioned
// runs to my_ranking_runs / my_rankings and export them anywhere Combine can.
//
// The deep-session dials (unranked semantics, outlier tamping) are OFFERED as
// options with documented defaults — never silently applied beyond that; the
// page surfaces exactly what a preview did (meta block in every response).
const express = require('express');
const router = express.Router();

const ecr = require('./lib/ecr');
const runStore = require('./lib/store');
const combineStore = require('../combine/lib/store');
const converters = require('../combine/lib/converters');
const settings = require('../../lib/settings');

const hasDb = () => Boolean(process.env.DATABASE_URL);
// The one scoring vocabulary — Combine's store owns it (CLAUDE.md).
const FORMATS = combineStore.FORMATS;

// Load the selected sets (meta + rows) in the shape buildEcr wants.
// selections: [{ set_id, weight }]. Sets load in parallel — a blend of many
// sets is the hot interactive path.
async function loadSelections(selections) {
  const seen = new Set();
  const list = (Array.isArray(selections) ? selections : [])
    .map((s) => ({ set_id: Number(s && s.set_id), weight: s && s.weight }))
    .filter((s) => Number.isInteger(s.set_id) && s.set_id > 0)
    // Same set twice would double-count that ranker's votes — first one wins.
    .filter((s) => (seen.has(s.set_id) ? false : (seen.add(s.set_id), true)));
  if (!list.length) return { sets: [], missing: [] };
  const loaded = await Promise.all(list.map(async (sel) => {
    const meta = await combineStore.getSet(sel.set_id);
    if (!meta) return { missing: sel.set_id };
    const rows = await combineStore.getSetRows(sel.set_id);
    return {
      set: {
        id: meta.id,
        name: meta.name,
        source: meta.source,
        native_scoring_format: meta.native_scoring_format,
        ranking_scope: meta.ranking_scope,
        weight: sel.weight,
        rows,
      },
    };
  }));
  return {
    sets: loaded.filter((l) => l.set).map((l) => l.set),
    missing: loaded.filter((l) => l.missing).map((l) => l.missing),
  };
}

// Set labels for the run's settings snapshot — so a saved run still names its
// inputs even after a source set is deleted.
function setSnapshot(sets) {
  return sets.map((s) => ({
    set_id: s.id, name: s.name, source: s.source,
    format: s.native_scoring_format, scope: s.ranking_scope,
    weight: Number(s.weight) > 0 ? Number(s.weight) : (s.weight === undefined || s.weight === null ? 1 : 0),
    rows: s.rows.length,
  }));
}

// The saved dial defaults (settings table; PRD §11 — tweak in app, not code).
router.get('/options', async (req, res) => {
  try {
    const saved = await settings.get('myrankings.options', null);
    res.json({ ok: true, data: ecr.cleanOptions(saved || {}) });
  } catch (err) {
    console.error(`GET /api/myrankings/options: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load your model dials.' });
  }
});

router.put('/options', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saving dials needs a database.' });
    const clean = ecr.cleanOptions(req.body || {});
    await settings.set('myrankings.options', clean);
    res.json({ ok: true, data: clean });
  } catch (err) {
    console.error(`PUT /api/myrankings/options: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save your model dials.' });
  }
});

// The set picker's list — Combine's sets with row/review counts.
router.get('/sets', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    res.json({ ok: true, data: await combineStore.listSets() });
  } catch (err) {
    console.error(`GET /api/myrankings/sets: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load your ranking sets.' });
  }
});

// Blend without saving. Body: { selections: [{set_id, weight}], options }.
router.post('/preview', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'The blender needs a database.' });
    const { selections, options } = req.body || {};
    const { sets, missing } = await loadSelections(selections);
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Pick at least one ranking set to blend.' });
    const result = ecr.buildEcr(sets, options);
    res.json({ ok: true, data: Object.assign(result, { sets: setSnapshot(sets), missing_sets: missing }) });
  } catch (err) {
    console.error(`POST /api/myrankings/preview: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not blend those sets.' });
  }
});

// Blend AND save as a versioned run.
// Body: { name?, target_format?, selections, options }.
router.post('/runs', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saving a run needs a database.' });
    const { name, target_format, selections, options } = req.body || {};
    const { sets, missing } = await loadSelections(selections);
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Pick at least one ranking set to blend.' });
    const result = ecr.buildEcr(sets, options);
    if (!result.overall.length) {
      return res.status(400).json({
        ok: false,
        error: 'Nothing to save: no overall consensus was produced. A saved run needs at least one overall-scope set (positional sets only vote within their position), and its players must be matched.',
      });
    }
    const format = FORMATS.has(String(target_format || '').toLowerCase())
      ? String(target_format).toLowerCase() : 'unknown';
    const runName = (name && String(name).trim()) ||
      `My rankings ${new Date().toISOString().slice(0, 10)}`;
    const run = await runStore.saveRun({
      name: runName,
      target_format: format,
      settings: { sets: setSnapshot(sets), options: result.meta.options, meta: result.meta },
      rows: result.overall,
    });
    res.json({ ok: true, data: { run, players: result.overall.length, meta: result.meta, missing_sets: missing } });
  } catch (err) {
    console.error(`POST /api/myrankings/runs: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save that run.' });
  }
});

router.get('/runs', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    res.json({ ok: true, data: await runStore.listRuns() });
  } catch (err) {
    console.error(`GET /api/myrankings/runs: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load your saved runs.' });
  }
});

router.get('/runs/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved runs need a database.' });
    const run = await runStore.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'That run was not found.' });
    const rows = await runStore.getRunRows(run.id);
    res.json({ ok: true, data: { run, rows } });
  } catch (err) {
    console.error(`GET /api/myrankings/runs/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load that run.' });
  }
});

router.delete('/runs/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved runs need a database.' });
    await runStore.deleteRun(req.params.id);
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    console.error(`DELETE /api/myrankings/runs/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not delete that run.' });
  }
});

// Risers/fallers between two runs (older = a, newer = b).
router.get('/compare', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Compare needs a database.' });
    const aId = req.query.a, bId = req.query.b;
    if (!aId || !bId) return res.status(400).json({ ok: false, error: 'Pick two runs to compare.' });
    const [aRun, bRun] = await Promise.all([runStore.getRun(aId), runStore.getRun(bId)]);
    if (!aRun || !bRun) return res.status(404).json({ ok: false, error: 'One of those runs was not found.' });
    const [aRows, bRows] = await Promise.all([runStore.getRunRows(aId), runStore.getRunRows(bId)]);
    const cmp = ecr.compareRankings(aRows, bRows);
    res.json({
      ok: true,
      data: Object.assign({
        a: { id: aRun.id, name: aRun.name, created_at: aRun.created_at },
        b: { id: bRun.id, name: bRun.name, created_at: bRun.created_at },
      }, cmp),
    });
  } catch (err) {
    console.error(`GET /api/myrankings/compare: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not compare those runs.' });
  }
});

// Exports — the same converters Combine uses (Underdog/Yahoo/FantasyPros/CSV),
// so "my rankings" flow anywhere a source set can (PRD §10).
router.get('/formats', (req, res) => {
  res.json({ ok: true, data: converters.list() });
});

router.get('/runs/:id/export/:format', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Exports need a database.' });
    const converter = converters.get(req.params.format);
    if (!converter) return res.status(400).json({ ok: false, error: `Unknown export format: ${req.params.format}` });
    const run = await runStore.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'That run was not found.' });
    const rows = combineStore.withPositionRanks(await runStore.getRunRows(run.id));
    if (!rows.length) return res.status(400).json({ ok: false, error: 'That run has no players to export.' });
    const csv = converter.build(rows);
    const slug = String(run.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'my-rankings';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${converter.filenameBase}-${slug}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(`GET /api/myrankings/runs/:id/export: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not build the export file.' });
  }
});

module.exports = router;
