// Combine — the rankings hub (PRD's #1 job), mounted at /api/combine.
// One-click pipeline: screenshot/paste -> OCR (Claude vision, Tesseract
// fallback) -> match against players_master -> ranking_sets + rankings_raw +
// rankings_normalized -> review queue for anything not rock-solid.
// API shape everywhere: { ok:true, data } / { ok:false, error }.
const express = require('express');
const router = express.Router();

const vision = require('./lib/vision');
const ocr = require('./lib/ocr');
const textParser = require('./lib/rankings');
const csvImport = require('./lib/csv-import');
const fetchRankings = require('./lib/fetch-rankings');
const autopull = require('./lib/autopull');
const ingest = require('./lib/ingest');
const store = require('./lib/store');
const converters = require('./lib/converters');
const underdogIds = require('./lib/underdog-ids');
const master = require('../../lib/players-master');
const settings = require('../../lib/settings');
const pool = require('../../db/pool');

const hasDb = () => Boolean(process.env.DATABASE_URL);

// image -> raw rows, via the best engine available. Returns
// { rows, engine, unparsed, warning }.
async function imageToRawRows(image) {
  if (vision.available()) {
    const model = await settings.get('combine.ocr_model', vision.DEFAULT_MODEL);
    try {
      const { rows } = await vision.imageToRows(image, { model });
      return { rows, engine: 'claude-vision', unparsed: [] };
    } catch (err) {
      console.error(`combine: vision OCR failed, falling back to tesseract: ${err.message}`);
      const out = await tesseractRows(image);
      out.warning = 'Claude vision failed on this image — used the offline OCR fallback, which reads less accurately.';
      return out;
    }
  }
  const out = await tesseractRows(image);
  out.warning = 'ANTHROPIC_API_KEY is not set — using the offline OCR fallback. Add the key in Railway for much better screenshot reads.';
  return out;
}

async function tesseractRows(image) {
  const text = await ocr.imageToText(image);
  const { players: parsed, unparsed } = textParser.parse(text);
  return { rows: parsed, engine: 'tesseract', unparsed };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

// Pre-warm the slow pieces so the first real screenshot is fast.
router.post('/warmup', (req, res) => {
  if (!vision.available()) { try { ocr.warmup(); } catch (e) { /* best-effort */ } }
  try { master.getIndex(); } catch (e) { /* best-effort */ }
  res.json({ ok: true, data: { warming: true, engine: vision.available() ? 'claude-vision' : 'tesseract' } });
});

// OCR one screenshot into matched rows (nothing is saved yet — the client
// accumulates screenshots, then POST /sets saves the whole list in one click).
router.post('/ocr', async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ ok: false, error: 'No image was provided. Paste or choose a screenshot first.' });
    const { rows, engine, unparsed, warning } = await imageToRawRows(image);
    const index = await master.getIndex();
    const matched = ingest.matchRows(rows, index);
    res.json({
      ok: true,
      data: {
        rows: matched,
        engine,
        unparsed: unparsed || [],
        warning: warning || '',
        review: ingest.reviewSummary(matched),
      },
    });
  } catch (err) {
    console.error(`POST /api/combine/ocr: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not read that screenshot. Try a clearer image or paste the rankings as text.' });
  }
});

// Import a CSV / spreadsheet export (FantasyPros CSV, Excel "Save As CSV", or a
// pasted spreadsheet range). Columns are auto-detected by header; rows flow
// through the same players_master matching pipeline as OCR/paste.
router.post('/import', async (req, res) => {
  try {
    const { csv } = req.body || {};
    if (!csv || !String(csv).trim()) return res.status(400).json({ ok: false, error: 'Choose a CSV or spreadsheet file first.' });
    const { rows: parsed, mapping } = csvImport.importCsv(String(csv));
    if (!parsed.length) {
      return res.status(400).json({ ok: false, error: 'No player rows found in that file. Make sure it has a player-name column.' });
    }
    const index = await master.getIndex();
    const matched = ingest.matchRows(parsed, index);
    res.json({
      ok: true,
      data: {
        rows: matched,
        engine: 'csv',
        unparsed: [],
        columns: csvImport.detectedFields(mapping),
        review: ingest.reviewSummary(matched),
      },
    });
  } catch (err) {
    console.error(`POST /api/combine/import: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not read that file. Make sure it is a CSV (in Excel, use Save As → CSV).' });
  }
});

// Parse pasted text into matched rows (the no-image path).
router.post('/parse', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: 'Paste some rankings text first.' });
    const { players: parsed, unparsed, position_blocks } = textParser.parse(text);
    const index = await master.getIndex();
    const matched = ingest.matchRows(parsed, index);
    res.json({ ok: true, data: { rows: matched, engine: 'paste', unparsed, position_blocks, review: ingest.reviewSummary(matched) } });
  } catch (err) {
    console.error(`POST /api/combine/parse: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not parse that text.' });
  }
});

// Fetch rankings straight from a supported URL (FantasyPros consensus pages).
// Returns matched rows + the set identity the URL implies — nothing is saved;
// the client reviews and saves through the normal POST /sets flow.
router.post('/fetch', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !String(url).trim()) return res.status(400).json({ ok: false, error: 'Paste a rankings URL first.' });
    const { rows, meta } = await fetchRankings.fetchRankings(String(url));
    const index = await master.getIndex();
    const matched = ingest.matchRows(rows, index);
    res.json({
      ok: true,
      data: {
        rows: matched,
        engine: 'url',
        unparsed: [],
        meta,
        review: ingest.reviewSummary(matched),
      },
    });
  } catch (err) {
    console.error(`POST /api/combine/fetch: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Auto-pull config + status: which URLs get pulled daily, and how the last
// sweep went. Entries live in settings 'combine.auto_pull'.
router.get('/autopull', async (req, res) => {
  try {
    const [entries, last] = await Promise.all([
      settings.get('combine.auto_pull', []),
      settings.get('combine.auto_pull.last', null),
    ]);
    res.json({ ok: true, data: { entries: Array.isArray(entries) ? entries : [], last } });
  } catch (err) {
    console.error(`GET /api/combine/autopull: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load the auto-pull list.' });
  }
});

router.put('/autopull', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Auto-pull needs a database.' });
    const entries = req.body && req.body.entries;
    if (!Array.isArray(entries)) return res.status(400).json({ ok: false, error: 'entries must be a list.' });
    for (const e of entries) {
      if (!e || !e.url || !fetchRankings.parseTarget(e.url)) {
        return res.status(400).json({ ok: false, error: `Not a supported rankings URL: ${e && e.url ? e.url : '(empty)'}` });
      }
    }
    await settings.set('combine.auto_pull', entries);
    res.json({ ok: true, data: { entries } });
  } catch (err) {
    console.error(`PUT /api/combine/autopull: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save the auto-pull list.' });
  }
});

// Pull everything on the list right now (force = re-pull even if captured today).
router.post('/autopull/run', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Auto-pull needs a database.' });
    const results = await autopull.runPulls({ force: !!(req.body && req.body.force) });
    res.json({ ok: true, data: { results } });
  } catch (err) {
    console.error(`POST /api/combine/autopull/run: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Auto-pull failed.' });
  }
});

// Save a new set: meta + raw rows in, matching + storage in one shot.
// Body: { name, source, native_scoring_format, ranking_scope?, captured_on?,
// notes?, rows }. ranking_scope: 'overall' (one list, the default) or
// 'positional' (per-position blocks — only rank within a position matters).
router.post('/sets', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saving needs a database (DATABASE_URL is not set).' });
    const { name, source, native_scoring_format, ranking_scope, captured_on, notes, rows } = req.body || {};
    const list = Array.isArray(rows) ? rows.filter((r) => r && String(r.raw_name || r.name || '').trim()) : [];
    if (!list.length) return res.status(400).json({ ok: false, error: 'There are no players to save.' });
    if (!source || !String(source).trim()) return res.status(400).json({ ok: false, error: 'Tag the set with its source (who made these rankings) first.' });
    const setName = (name && String(name).trim()) ||
      `${String(source).trim()} ${captured_on || new Date().toISOString().slice(0, 10)}`;
    const index = await master.getIndex();
    const matched = ingest.matchRows(
      list.map((r) => ({ name: r.raw_name || r.name, position: r.raw_position || r.position, team: r.raw_team || r.team, auction_value: r.auction_value })),
      index
    );
    const set = await store.createSet(
      { name: setName, source: String(source).trim(), native_scoring_format, ranking_scope, captured_on, notes },
      matched
    );
    res.json({ ok: true, data: { set, review: ingest.reviewSummary(matched) } });
  } catch (err) {
    console.error(`POST /api/combine/sets: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save that ranking set.' });
  }
});

// Append rows to an existing set (screenshot #2..N of a long list).
router.post('/sets/:id/rows', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saving needs a database.' });
    const set = await store.getSet(req.params.id);
    if (!set) return res.status(404).json({ ok: false, error: 'Ranking set not found.' });
    const list = Array.isArray(req.body && req.body.rows) ? req.body.rows.filter((r) => r && String(r.raw_name || r.name || '').trim()) : [];
    if (!list.length) return res.status(400).json({ ok: false, error: 'There are no rows to add.' });
    const index = await master.getIndex();
    const matched = ingest.matchRows(
      list.map((r) => ({ name: r.raw_name || r.name, position: r.raw_position || r.position, team: r.raw_team || r.team, auction_value: r.auction_value })),
      index
    );
    await store.appendRows(set.id, matched);
    res.json({ ok: true, data: { added: matched.length, review: ingest.reviewSummary(matched) } });
  } catch (err) {
    console.error(`POST /api/combine/sets/:id/rows: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not add those rows to the set.' });
  }
});

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

router.get('/sets', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    res.json({ ok: true, data: await store.listSets() });
  } catch (err) {
    console.error(`GET /api/combine/sets: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load saved ranking sets.' });
  }
});

router.get('/sets/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved sets need a database.' });
    const set = await store.getSet(req.params.id);
    if (!set) return res.status(404).json({ ok: false, error: 'Ranking set not found.' });
    const rows = await store.getSetRows(set.id);
    res.json({ ok: true, data: { set, rows } });
  } catch (err) {
    console.error(`GET /api/combine/sets/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load that ranking set.' });
  }
});

router.patch('/sets/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved sets need a database.' });
    const set = await store.updateSetMeta(req.params.id, req.body || {});
    if (!set) return res.status(404).json({ ok: false, error: 'Ranking set not found.' });
    res.json({ ok: true, data: set });
  } catch (err) {
    console.error(`PATCH /api/combine/sets/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not update that ranking set.' });
  }
});

router.delete('/sets/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved sets need a database.' });
    await store.deleteSet(req.params.id);
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    console.error(`DELETE /api/combine/sets/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not delete that ranking set.' });
  }
});

// Re-run matching for a set's unresolved/unconfirmed rows — after a roster
// sync, a learned alias, or for sets migrated from the pre-rebuild converter.
router.post('/sets/:id/rematch', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved sets need a database.' });
    const set = await store.getSet(req.params.id);
    if (!set) return res.status(404).json({ ok: false, error: 'Ranking set not found.' });
    const rows = await store.getSetRows(set.id);
    const index = await master.getIndex();
    let resolved = 0;
    for (const row of rows) {
      if (row.confirmed) continue; // never second-guess the owner
      const m = ingest.matchRow(
        { name: row.raw_name, position: row.raw_position, team: row.raw_team }, index
      );
      if (m.player_id && m.player_id !== row.player_id) {
        await store.resolveRow(row.raw_id, m.player_id, { confidence: m.confidence, via: m.via, confirmed: false });
        resolved++;
      }
    }
    const fresh = await store.getSetRows(set.id);
    res.json({ ok: true, data: { resolved, rows: fresh } });
  } catch (err) {
    console.error(`POST /api/combine/sets/:id/rematch: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not re-match that set.' });
  }
});

// ---------------------------------------------------------------------------
// Review queue — never silently guess a player's identity (PRD §7).
// ---------------------------------------------------------------------------

router.get('/review', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    res.json({ ok: true, data: await store.reviewQueue() });
  } catch (err) {
    console.error(`GET /api/combine/review: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load the review queue.' });
  }
});

// Resolve one raw row. Body is ONE of:
//   { player_id, learn_alias? }          this raw name IS that player
//   { new_player: {name, position, team}, learn_alias? }   add + resolve
//   { confirm: true }                    the suggested match is right
//   { ignore: true }                     not a player — drop the row
router.post('/rows/:rawId/resolve', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'The review queue needs a database.' });
    const rawId = req.params.rawId;
    const body = req.body || {};
    const { rows: rawRows } = await pool.query(
      `SELECT r.raw_name, s.source FROM rankings_raw r JOIN ranking_sets s ON s.id = r.set_id WHERE r.id = $1`,
      [rawId]
    );
    if (!rawRows.length) return res.status(404).json({ ok: false, error: 'That row no longer exists.' });
    const { raw_name, source } = rawRows[0];

    if (body.ignore) {
      await store.ignoreRow(rawId);
      return res.json({ ok: true, data: { ignored: true } });
    }
    if (body.confirm) {
      await store.confirmRow(rawId);
      return res.json({ ok: true, data: { confirmed: true } });
    }

    let playerId = body.player_id;
    if (!playerId && body.new_player) {
      const created = await master.addManual(body.new_player);
      playerId = created.player_id;
    }
    if (!playerId) return res.status(400).json({ ok: false, error: 'Pick a player, add a new one, confirm, or ignore.' });

    await store.resolveRow(rawId, playerId, { confidence: 'high', via: 'owner', confirmed: true });
    if (body.learn_alias) {
      try { await master.learnAlias(playerId, raw_name, source); }
      catch (e) { console.error(`combine: learnAlias failed: ${e.message}`); }
    }
    res.json({ ok: true, data: { resolved: true, player_id: playerId } });
  } catch (err) {
    console.error(`POST /api/combine/rows/:rawId/resolve: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not resolve that row.' });
  }
});

// ---------------------------------------------------------------------------
// players_master: search / add / sync (the review queue's supporting cast).
// ---------------------------------------------------------------------------

router.get('/players', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    res.json({ ok: true, data: await master.search(String(req.query.q || ''), 20) });
  } catch (err) {
    console.error(`GET /api/combine/players: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Player search failed.' });
  }
});

router.post('/players', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'players_master needs a database.' });
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ ok: false, error: 'Give the player a name first.' });
    res.json({ ok: true, data: await master.addManual(req.body) });
  } catch (err) {
    console.error(`POST /api/combine/players: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not add that player.' });
  }
});

router.get('/master/status', async (req, res) => {
  res.json({ ok: true, data: Object.assign(await master.status(), { vision: vision.available() }) });
});

router.post('/master/sync', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'players_master needs a database.' });
    const count = await master.sync();
    res.json({ ok: true, data: { synced: count } });
  } catch (err) {
    console.error(`POST /api/combine/master/sync: ${err.message}`);
    res.status(500).json({ ok: false, error: `Roster sync failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Compare two sets (rank deltas on shared players).
// ---------------------------------------------------------------------------

router.get('/compare', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Compare needs a database.' });
    const aId = req.query.a, bId = req.query.b;
    if (!aId || !bId) return res.status(400).json({ ok: false, error: 'Pick two sets to compare.' });
    const [aSet, bSet] = await Promise.all([store.getSet(aId), store.getSet(bId)]);
    if (!aSet || !bSet) return res.status(404).json({ ok: false, error: 'One of those sets was not found.' });
    const [aRows, bRows] = await Promise.all([store.getSetRows(aId), store.getSetRows(bId)]);
    const byPlayer = new Map();
    for (const r of aRows) if (r.player_id) byPlayer.set(r.player_id, { a: r });
    for (const r of bRows) {
      if (!r.player_id) continue;
      const e = byPlayer.get(r.player_id);
      if (e) e.b = r; else byPlayer.set(r.player_id, { b: r });
    }
    // Overall list order is only comparable when BOTH sets are overall lists —
    // and even then two sources can bunch positions differently, so the default
    // comparison is per position (RB3 vs RB7), which is derived for every set
    // and always apples-to-apples. `mode=overall` opts back into list order.
    const positional = aSet.ranking_scope === 'positional' || bSet.ranking_scope === 'positional';
    const overallAvailable = !positional;
    const mode = (overallAvailable && String(req.query.mode || '').toLowerCase() === 'overall') ? 'overall' : 'position';
    const pairs = [], onlyA = [], onlyB = [];
    for (const { a, b } of byPlayer.values()) {
      if (a && b) {
        pairs.push({
          player_id: a.player_id, name: a.name, position: a.position, team: a.team,
          rank_a: a.rank, rank_b: b.rank, delta: a.rank - b.rank,
          pos_rank_a: a.position_rank, pos_rank_b: b.position_rank,
          pos_delta: (a.position_rank && b.position_rank) ? a.position_rank - b.position_rank : null,
        });
      } else if (a) onlyA.push({ name: a.name, position: a.position, team: a.team, rank: a.rank, pos_rank: a.position_rank });
      else onlyB.push({ name: b.name, position: b.position, team: b.team, rank: b.rank, pos_rank: b.position_rank });
    }
    const sortDelta = mode === 'position'
      ? (p) => (p.pos_delta === null ? -1 : Math.abs(p.pos_delta))
      : (p) => Math.abs(p.delta);
    pairs.sort((x, y) => sortDelta(y) - sortDelta(x));
    onlyA.sort((x, y) => x.rank - y.rank);
    onlyB.sort((x, y) => x.rank - y.rank);

    // Per-position buckets: each position is its own little comparison, so a
    // source that pastes RBs before WRs never skews another position's deltas.
    const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'DEF'];
    const groups = new Map();
    const bucket = (pos) => {
      const key = store.positionKey(pos) || 'UNKNOWN';
      if (!groups.has(key)) groups.set(key, { position: key, pairs: [], onlyA: [], onlyB: [] });
      return groups.get(key);
    };
    for (const p of pairs) bucket(p.position).pairs.push(p);
    for (const p of onlyA) bucket(p.position).onlyA.push(p);
    for (const p of onlyB) bucket(p.position).onlyB.push(p);
    const groupList = [...groups.values()].map((g) => {
      const withDelta = g.pairs.filter((p) => p.pos_delta !== null);
      const totalDelta = withDelta.reduce((sum, p) => sum + Math.abs(p.pos_delta), 0);
      const biggest = withDelta.reduce((best, p) => (
        !best || Math.abs(p.pos_delta) > Math.abs(best.pos_delta) ? p : best), null);
      return {
        ...g,
        shared: g.pairs.length,
        avg_pos_delta: withDelta.length ? Math.round((totalDelta / withDelta.length) * 10) / 10 : null,
        biggest_gap: biggest ? { name: biggest.name, delta: biggest.pos_delta } : null,
      };
    }).sort((x, y) => {
      const ix = POS_ORDER.indexOf(x.position), iy = POS_ORDER.indexOf(y.position);
      if (ix !== iy) return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy);
      return x.position.localeCompare(y.position);
    });

    res.json({
      ok: true,
      data: {
        positional,
        mode,
        overall_available: overallAvailable,
        a: { id: aSet.id, name: aSet.name, source: aSet.source, format: aSet.native_scoring_format, scope: aSet.ranking_scope, unmatched: aRows.filter((r) => !r.player_id).length },
        b: { id: bSet.id, name: bSet.name, source: bSet.source, format: bSet.native_scoring_format, scope: bSet.ranking_scope, unmatched: bRows.filter((r) => !r.player_id).length },
        pairs, onlyA, onlyB,
        groups: groupList,
      },
    });
  } catch (err) {
    console.error(`GET /api/combine/compare: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not compare those sets.' });
  }
});

// ---------------------------------------------------------------------------
// Exports (PRD §10) — canonical names out, in each site's format.
// ---------------------------------------------------------------------------

router.get('/formats', (req, res) => {
  res.json({ ok: true, data: converters.list() });
});

router.get('/sets/:id/export/:format', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Exports need a database.' });
    const converter = converters.get(req.params.format);
    if (!converter) return res.status(400).json({ ok: false, error: `Unknown export format: ${req.params.format}` });
    const set = await store.getSet(req.params.id);
    if (!set) return res.status(404).json({ ok: false, error: 'Ranking set not found.' });
    const rows = await store.getSetRows(set.id);
    if (!rows.length) return res.status(400).json({ ok: false, error: 'That set has no players to export.' });
    const csv = converter.build(rows);
    const slug = String(set.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'rankings';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${converter.filenameBase}-${slug}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(`GET /api/combine/sets/:id/export: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not build the export file.' });
  }
});

// --- Underdog "rankings with IDs" ------------------------------------------
// Underdog's uploader wants its own per-contest player IDs; the owner saves the
// CSV downloaded from Underdog and we reorder it to match a set (byte-for-byte
// rows, so it's never rejected). Recycled from the proven converter flow.

router.get('/underdog/sets', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    const { rows } = await pool.query('SELECT id, name, player_count, created_at FROM underdog_id_sets ORDER BY created_at DESC');
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error(`GET /api/combine/underdog/sets: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load your saved Underdog files.' });
  }
});

router.post('/underdog/sets', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saving an Underdog file needs a database.' });
    const { name, csv } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ ok: false, error: 'Give this Underdog file a name (e.g. the contest) before saving.' });
    if (!csv || !String(csv).trim()) return res.status(400).json({ ok: false, error: 'Paste or choose the CSV you downloaded from Underdog first.' });
    let count;
    try { ({ count } = underdogIds.summarize(String(csv))); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    const { rows } = await pool.query(
      'INSERT INTO underdog_id_sets (name, csv, player_count) VALUES ($1, $2, $3) RETURNING id, name, player_count, created_at',
      [String(name).trim(), String(csv), count]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`POST /api/combine/underdog/sets: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save that Underdog file.' });
  }
});

router.delete('/underdog/sets/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Saved Underdog files need a database.' });
    await pool.query('DELETE FROM underdog_id_sets WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    console.error(`DELETE /api/combine/underdog/sets/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not delete that Underdog file.' });
  }
});

// Build the upload-ready Underdog file for a ranking set.
// Body: { set_id, underdog_set_id }.
router.post('/underdog/export', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'This needs a database.' });
    const { set_id, underdog_set_id } = req.body || {};
    if (!set_id || !underdog_set_id) return res.status(400).json({ ok: false, error: 'Pick a ranking set and an Underdog file first.' });
    const rows = await store.getSetRows(set_id);
    if (!rows.length) return res.status(400).json({ ok: false, error: 'That ranking set has no players.' });
    const { rows: ud } = await pool.query('SELECT name, csv FROM underdog_id_sets WHERE id = $1', [underdog_set_id]);
    if (!ud.length) return res.status(404).json({ ok: false, error: 'That Underdog file was not found — it may have been deleted.' });
    let result;
    try { result = underdogIds.buildExport(ud[0].csv, rows); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    const slug = String(ud[0].name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'underdog';
    const stamp = new Date().toISOString().slice(0, 10);
    res.json({
      ok: true,
      data: {
        filename: `underdog-${slug}-${stamp}.csv`,
        csv: result.csv, total: result.total, matched: result.matched, unmatched: result.unmatched,
      },
    });
  } catch (err) {
    console.error(`POST /api/combine/underdog/export: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not build the Underdog upload file.' });
  }
});

module.exports = router;
