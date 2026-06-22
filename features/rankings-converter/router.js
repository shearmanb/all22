// Rankings Converter feature router (mounted at /api/convert).
// Pipeline: screenshot (OCR) or pasted text -> parse -> editable list -> export
// to any registered format. JSON API shape: { ok:true, data } / { ok:false, error }.
const express = require('express');
const router = express.Router();

const ocr = require('./lib/ocr');
const rankingsParser = require('./lib/rankings');
const converters = require('./lib/converters');
const players = require('../../lib/players');
const pool = require('../../db/pool');

const hasDb = () => Boolean(process.env.DATABASE_URL);

// Re-rank a client-supplied list into the canonical internal shape, in the
// order given. Names are re-normalized through lib/players.js so edits the owner
// made in the preview are cleaned consistently before export.
function normalizeList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && (p.name || '').trim())
    .map((p, i) => ({
      rank: i + 1,
      name: players.display(p.name),
      position: (p.position || '').toUpperCase().replace(/\./g, ''),
      team: (p.team || '').toUpperCase().replace(/\./g, ''),
    }));
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
    const note = parsed.length
      ? ''
      : 'No players were detected in that screenshot. Try a sharper, higher-contrast image, or paste the rankings as text.';
    res.json({ ok: true, data: { players: parsed, unparsed, text, note } });
  } catch (err) {
    console.error(`POST /api/convert/ocr: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not read that screenshot. Try a clearer image or paste the rankings as text.' });
  }
});

// Parse pasted TEXT into a ranking list (the reliable path / OCR fallback).
router.post('/parse', (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ ok: false, error: 'Paste some rankings text first.' });
    }
    const { players: parsed, unparsed } = rankingsParser.parse(text);
    res.json({ ok: true, data: { players: parsed, unparsed, note: parsed.length ? '' : 'No players found in that text.' } });
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

module.exports = router;
