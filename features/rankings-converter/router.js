// Rankings Converter feature router (mounted at /api/convert).
// Pipeline: screenshot (OCR) or pasted text -> parse -> editable list -> export
// to any registered format. JSON API shape: { ok:true, data } / { ok:false, error }.
const express = require('express');
const router = express.Router();

const ocr = require('./lib/ocr');
const rankingsParser = require('./lib/rankings');
const roster = require('./lib/roster');
const converters = require('./lib/converters');
const players = require('../../lib/players');
const pool = require('../../db/pool');

const hasDb = () => Boolean(process.env.DATABASE_URL);

// Assign a position rank ("QB5") to each entry by its order within its position.
// The list is already in overall-rank order, so this is just a per-position
// running count. Mutates and returns the same list.
function addPositionRank(list) {
  const counters = {};
  for (const item of list) {
    if (!item.position) { item.posRank = null; continue; }
    counters[item.position] = (counters[item.position] || 0) + 1;
    item.posRank = counters[item.position];
  }
  return list;
}

// Re-rank a client-supplied list into the canonical internal shape. Overall rank
// is the row's POSITION in the list — players are always pasted in rank order, so
// the first row is rank 1 (this also accumulates correctly across screenshots).
// Names are re-normalized through lib/players.js so preview edits are cleaned.
function normalizeList(list) {
  if (!Array.isArray(list)) return [];
  const out = list
    .filter((p) => p && (p.name || '').trim())
    .map((p, i) => ({
      rank: i + 1,
      name: players.display(p.name),
      position: (p.position || '').toUpperCase().replace(/\./g, ''),
      team: (p.team || '').toUpperCase().replace(/\./g, ''),
    }));
  return addPositionRank(out);
}

// Load the fix queue as a Map keyed by canonical name key. Returns an empty map
// when there's no database (the converter still works, just without saved fixes).
async function loadCorrections() {
  const map = new Map();
  if (!hasDb()) return map;
  try {
    const { rows } = await pool.query('SELECT name_key, team, position FROM converter_corrections');
    for (const r of rows) map.set(r.name_key, { team: r.team, position: r.position });
  } catch (err) {
    // Never let the fix queue break core parsing — just skip it this time.
    console.error(`convert: loadCorrections failed: ${err.message}`);
  }
  return map;
}

// Apply saved fixes to freshly parsed players: a stored team/position overrides
// what OCR produced (that's the whole point — "enter once, fix going forward").
function applyCorrections(parsed, corrections) {
  if (!corrections || !corrections.size) return parsed;
  for (const p of parsed) {
    const fix = corrections.get(players.key(p.name));
    if (!fix) continue;
    if (fix.team) p.team = fix.team;
    if (fix.position) p.position = fix.position;
  }
  return parsed;
}

// List available output formats (for building the UI).
router.get('/formats', (req, res) => {
  res.json({ ok: true, data: converters.list() });
});

// OCR a pasted/uploaded screenshot, then parse it into a ranking list.
router.post('/ocr', async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image) {
      return res.status(400).json({ ok: false, error: 'No image was provided. Paste or choose a screenshot first.' });
    }
    const text = await ocr.imageToText(image);
    const { players: parsed, unparsed } = rankingsParser.parse(text);
    // Fill team/position from the NFL roster (by name), then let saved fixes win.
    const enriched = await roster.enrich(parsed);
    applyCorrections(parsed, await loadCorrections());
    const note = parsed.length
      ? ''
      : 'No players were detected in that screenshot. Try a sharper, higher-contrast image, or paste the rankings as text.';
    res.json({ ok: true, data: { players: parsed, unparsed, text, note, enriched } });
  } catch (err) {
    console.error(`POST /api/convert/ocr: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not read that screenshot. Try a clearer image or paste the rankings as text.' });
  }
});

// Parse pasted TEXT into a ranking list (the reliable path / OCR fallback).
router.post('/parse', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ ok: false, error: 'Paste some rankings text first.' });
    }
    const { players: parsed, unparsed } = rankingsParser.parse(text);
    const enriched = await roster.enrich(parsed);
    applyCorrections(parsed, await loadCorrections());
    res.json({ ok: true, data: { players: parsed, unparsed, enriched, note: parsed.length ? '' : 'No players found in that text.' } });
  } catch (err) {
    console.error(`POST /api/convert/parse: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not parse that text.' });
  }
});

// Export the (possibly edited) list to a chosen format as a downloadable CSV.
router.post('/export', (req, res) => {
  try {
    const { players: list, format } = req.body || {};
    const converter = converters.get(format);
    if (!converter) {
      return res.status(400).json({ ok: false, error: `Unknown export format: ${format}` });
    }
    const normalized = normalizeList(list);
    if (!normalized.length) {
      return res.status(400).json({ ok: false, error: 'There are no players to export.' });
    }
    const csv = converter.build(normalized);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${converter.filenameBase}-${stamp}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error(`POST /api/convert/export: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not build the export file.' });
  }
});

// --- Optional persistence (requires DATABASE_URL) -------------------------

router.post('/save', async (req, res) => {
  try {
    if (!hasDb()) {
      return res.status(400).json({ ok: false, error: 'Saving needs a database (DATABASE_URL is not set). Export still works without it.' });
    }
    const { name, source, players: list } = req.body || {};
    const normalized = normalizeList(list);
    if (!name || !String(name).trim()) {
      return res.status(400).json({ ok: false, error: 'Give this ranking set a name before saving.' });
    }
    if (!normalized.length) {
      return res.status(400).json({ ok: false, error: 'There are no players to save.' });
    }
    const { rows } = await pool.query(
      'INSERT INTO ranking_sets (name, source, players) VALUES ($1, $2, $3) RETURNING id, name, source, created_at',
      [String(name).trim(), source ? String(source).trim() : null, JSON.stringify(normalized)]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`POST /api/convert/save: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save that ranking set.' });
  }
});

router.get('/sets', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    const { rows } = await pool.query(
      'SELECT id, name, source, created_at, jsonb_array_length(players) AS count FROM ranking_sets ORDER BY created_at DESC'
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error(`GET /api/convert/sets: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load saved ranking sets.' });
  }
});

router.get('/sets/:id', async (req, res) => {
  try {
    if (!hasDb()) {
      return res.status(400).json({ ok: false, error: 'Saved sets need a database.' });
    }
    const { rows } = await pool.query('SELECT id, name, source, players, created_at FROM ranking_sets WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Ranking set not found.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`GET /api/convert/sets/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load that ranking set.' });
  }
});

// --- Fix queue (corrections) ----------------------------------------------
// Remembered team/position fixes, keyed by canonical name, auto-applied on every
// future import. Requires DATABASE_URL.

// List all saved fixes (for the manage view).
router.get('/corrections', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    const { rows } = await pool.query(
      'SELECT id, name, team, position, updated_at FROM converter_corrections ORDER BY name'
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error(`GET /api/convert/corrections: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load saved fixes.' });
  }
});

// Upsert one or more fixes. Body: { fixes: [{ name, team, position }] }.
// A fix is stored only when it carries a team or a position to remember.
router.post('/corrections', async (req, res) => {
  try {
    if (!hasDb()) {
      return res.status(400).json({ ok: false, error: 'Remembering fixes needs a database (DATABASE_URL is not set).' });
    }
    const incoming = Array.isArray(req.body && req.body.fixes) ? req.body.fixes : [];
    let saved = 0;
    for (const f of incoming) {
      const name = players.display((f && f.name) || '');
      if (!name) continue;
      const team = (f.team || '').toUpperCase().replace(/\./g, '').trim() || null;
      const position = (f.position || '').toUpperCase().replace(/\./g, '').trim() || null;
      if (!team && !position) continue; // nothing worth remembering
      const nameKey = players.key(name);
      if (!nameKey) continue;
      await pool.query(
        `INSERT INTO converter_corrections (name_key, name, team, position, updated_at)
           VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (name_key) DO UPDATE
           SET name = EXCLUDED.name,
               team = COALESCE(EXCLUDED.team, converter_corrections.team),
               position = COALESCE(EXCLUDED.position, converter_corrections.position),
               updated_at = now()`,
        [nameKey, name, team, position]
      );
      saved += 1;
    }
    res.json({ ok: true, data: { saved } });
  } catch (err) {
    console.error(`POST /api/convert/corrections: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save those fixes.' });
  }
});

// Forget a saved fix.
router.delete('/corrections/:id', async (req, res) => {
  try {
    if (!hasDb()) {
      return res.status(400).json({ ok: false, error: 'Saved fixes need a database.' });
    }
    await pool.query('DELETE FROM converter_corrections WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    console.error(`DELETE /api/convert/corrections/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not delete that fix.' });
  }
});

module.exports = router;
