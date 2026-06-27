// Rankings Converter feature router (mounted at /api/convert).
// Pipeline: screenshot (OCR) or pasted text -> parse -> editable list -> export
// to any registered format. JSON API shape: { ok:true, data } / { ok:false, error }.
const express = require('express');
const router = express.Router();

const ocr = require('./lib/ocr');
const rankingsParser = require('./lib/rankings');
const roster = require('./lib/roster');
const converters = require('./lib/converters');
const underdogIds = require('./lib/underdog-ids');
const yahooBookmarklet = require('./lib/yahoo-bookmarklet');
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

// Pre-warm the OCR worker + roster cache so the first screenshot is fast.
// Fire-and-forget: kick both off and return immediately (never blocks).
router.post('/warmup', (req, res) => {
  try { ocr.warmup(); } catch (e) { /* best-effort */ }
  try { roster.getMap(); } catch (e) { /* best-effort */ }
  res.json({ ok: true, data: { warming: true } });
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

// Build the "All22 → Yahoo" bookmarklet for the current list. Yahoo has no
// rankings upload, so the owner drags this to his bookmarks bar and clicks it on
// Yahoo's pre-draft editor; it moves his players into Preferred order in place.
// The names are baked into the bookmarklet, so it carries no secrets and needs
// no callback to this server (which is why it works inside Yahoo's page).
router.post('/yahoo-bookmarklet', (req, res) => {
  try {
    const { players: list } = req.body || {};
    const normalized = normalizeList(list);
    if (!normalized.length) {
      return res.status(400).json({ ok: false, error: 'There are no players to send to Yahoo.' });
    }
    const built = yahooBookmarklet.build(normalized);
    res.json({ ok: true, data: built });
  } catch (err) {
    console.error(`POST /api/convert/yahoo-bookmarklet: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not build the Yahoo bookmarklet.' });
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
      'SELECT id, name, source, created_at, updated_at, jsonb_array_length(players) AS count FROM ranking_sets ORDER BY updated_at DESC'
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
    const { rows } = await pool.query('SELECT id, name, source, players, created_at, updated_at FROM ranking_sets WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Ranking set not found.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`GET /api/convert/sets/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load that ranking set.' });
  }
});

// Replace an existing ranking set in place ("Update" — the saved list the owner
// loaded, edited, and re-saved). Body: { name?, source?, players }. Players are
// always replaced; name/source update only when provided.
router.put('/sets/:id', async (req, res) => {
  try {
    if (!hasDb()) {
      return res.status(400).json({ ok: false, error: 'Saving needs a database (DATABASE_URL is not set).' });
    }
    const { name, source, players: list } = req.body || {};
    const normalized = normalizeList(list);
    if (!normalized.length) {
      return res.status(400).json({ ok: false, error: 'There are no players to save.' });
    }
    const sets = ['players = $2', 'updated_at = now()'];
    const params = [req.params.id, JSON.stringify(normalized)];
    if (name && String(name).trim()) {
      params.push(String(name).trim());
      sets.push(`name = $${params.length}`);
    }
    if (source !== undefined) {
      params.push(source ? String(source).trim() : null);
      sets.push(`source = $${params.length}`);
    }
    const { rows } = await pool.query(
      `UPDATE ranking_sets SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, source, created_at, updated_at`,
      params
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'That ranking set was not found — it may have been deleted.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`PUT /api/convert/sets/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not update that ranking set.' });
  }
});

// Forget a saved ranking set.
router.delete('/sets/:id', async (req, res) => {
  try {
    if (!hasDb()) {
      return res.status(400).json({ ok: false, error: 'Saved sets need a database.' });
    }
    await pool.query('DELETE FROM ranking_sets WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    console.error(`DELETE /api/convert/sets/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not delete that ranking set.' });
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

// --- Underdog "rankings with IDs" (requires DATABASE_URL) -----------------
// Underdog's player IDs change every contest/season, so the owner uploads the
// CSV they download from Underdog (one per contest, kept as a named list). On
// export we reorder that exact file to match the ranked list and hand back an
// upload-ready file with Underdog's real IDs. See lib/underdog-ids.js.

// List saved Underdog files (the contest list).
router.get('/underdog/sets', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    const { rows } = await pool.query(
      'SELECT id, name, player_count, created_at FROM underdog_id_sets ORDER BY created_at DESC'
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error(`GET /api/convert/underdog/sets: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load your saved Underdog files.' });
  }
});

// Save a downloaded Underdog CSV under a name. Body: { name, csv }.
router.post('/underdog/sets', async (req, res) => {
  try {
    if (!hasDb()) {
      return res.status(400).json({ ok: false, error: 'Saving an Underdog file needs a database (DATABASE_URL is not set).' });
    }
    const { name, csv } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ ok: false, error: 'Give this Underdog file a name (e.g. the contest or season) before saving.' });
    }
    if (!csv || !String(csv).trim()) {
      return res.status(400).json({ ok: false, error: 'Paste or choose the CSV you downloaded from Underdog first.' });
    }
    let count;
    try {
      ({ count } = underdogIds.summarize(String(csv)));
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    const { rows } = await pool.query(
      'INSERT INTO underdog_id_sets (name, csv, player_count) VALUES ($1, $2, $3) RETURNING id, name, player_count, created_at',
      [String(name).trim(), String(csv), count]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`POST /api/convert/underdog/sets: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save that Underdog file.' });
  }
});

// Forget a saved Underdog file.
router.delete('/underdog/sets/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved Underdog files need a database.' });
    await pool.query('DELETE FROM underdog_id_sets WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    console.error(`DELETE /api/convert/underdog/sets/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not delete that Underdog file.' });
  }
});

// Live match report: how many of the ranked names match a stored Underdog file,
// with a nearest-name suggestion per miss. Body: { players, setId }. Used to
// show inline status while editing (no download). Always 200 with availability.
router.post('/underdog/match', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: { available: false } });
    const { players: list, setId } = req.body || {};
    const normalized = normalizeList(list);
    if (!setId || !normalized.length) {
      return res.json({ ok: true, data: { available: true, total: 0, matched: 0, unmatched: [] } });
    }
    const { rows } = await pool.query('SELECT csv FROM underdog_id_sets WHERE id = $1', [setId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'That Underdog file was not found — it may have been deleted.' });
    let report;
    try {
      report = underdogIds.matchReport(rows[0].csv, normalized);
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    res.json({ ok: true, data: Object.assign({ available: true }, report) });
  } catch (err) {
    console.error(`POST /api/convert/underdog/match: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not check matches against the Underdog file.' });
  }
});

// Build the upload-ready Underdog file: reorder a stored file to match the
// ranked list. Body: { players: [{name,...}], setId }. Returns the CSV text plus
// a match report so the UI can download it and show what didn't match.
router.post('/underdog/export', async (req, res) => {
  try {
    if (!hasDb()) {
      return res.status(400).json({ ok: false, error: 'This needs a database to load your saved Underdog file.' });
    }
    const { players: list, setId } = req.body || {};
    const normalized = normalizeList(list);
    if (!normalized.length) {
      return res.status(400).json({ ok: false, error: 'There are no players in your list to rank.' });
    }
    if (!setId) {
      return res.status(400).json({ ok: false, error: 'Choose which Underdog file to use first.' });
    }
    const { rows } = await pool.query('SELECT name, csv FROM underdog_id_sets WHERE id = $1', [setId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'That Underdog file was not found — it may have been deleted.' });

    let result;
    try {
      result = underdogIds.buildExport(rows[0].csv, normalized);
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    const slug = String(rows[0].name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'underdog';
    const stamp = new Date().toISOString().slice(0, 10);
    res.json({
      ok: true,
      data: {
        filename: `underdog-${slug}-${stamp}.csv`,
        csv: result.csv,
        total: result.total,
        matched: result.matched,
        unmatched: result.unmatched,
      },
    });
  } catch (err) {
    console.error(`POST /api/convert/underdog/export: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not build the Underdog upload file.' });
  }
});

module.exports = router;
