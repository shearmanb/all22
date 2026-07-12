// Edge Rush — ADP intelligence (PRD Phase 4), mounted at /api/adp.
// adp_history holds daily snapshots per (site, format, teams); this router
// serves the latest board, risers/fallers between snapshots, per-player
// history, collector status, and a collect-now trigger. Collection itself
// lives in lib/collect.js and runs on a boot + interval schedule (server.js).
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const pool = require('../../db/pool');
const settings = require('../../lib/settings');
const collect = require('./lib/collect');
const sources = require('./lib/sources');
const custom = require('./lib/custom');

const hasDb = () => Boolean(process.env.DATABASE_URL);

// The "View source ↗" link for a board (PRD §11 provenance). Built-ins map to
// the site's own ADP page; a custom source links back to the URL the owner
// added.
async function sourceUrlFor(site, format, teams) {
  if (site === 'ffc') return sources.ffcPageUrl(format, teams);
  if (site === 'sleeper') return 'https://sleeper.com/';
  const list = await settings.get('adp.custom_sources', []);
  for (const e of (Array.isArray(list) ? list : [])) {
    const id = e && e.url && custom.identify(e.url);
    if (id && id.site === site) return id.url;
  }
  // Bookmarklet-captured boards (e.g. Yahoo) record the page they came from.
  const urls = (await settings.get('adp.source_urls', {})) || {};
  return urls[site] || null;
}

// Pick the best stored snapshot key for a format: exact league size beats
// Sleeper's sitewide (teams = 0) beats whatever is freshest.
async function resolveKey({ site, format, teams }) {
  const { rows } = await pool.query(
    `SELECT site, format, teams, MAX(snapshot_date)::text AS latest
     FROM adp_history
     WHERE format = $1
     GROUP BY site, format, teams`,
    [format]
  );
  let candidates = rows;
  if (site) candidates = candidates.filter((r) => r.site === site);
  if (!candidates.length) return null;
  const wanted = Number(teams) || null;
  const score = (r) => {
    if (wanted && Number(r.teams) === wanted) return 3;
    if (wanted && Number(r.teams) === sources.clampTeams(wanted) && r.site === 'ffc') return 2;
    if (Number(r.teams) === 0) return 1;
    return 0;
  };
  candidates.sort((a, b) =>
    (score(b) - score(a)) ||
    (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0) ||
    (a.site === 'ffc' ? -1 : 1)
  );
  const best = candidates[0];
  return { site: best.site, format, teams: Number(best.teams), latest: best.latest };
}

async function snapshotRows(key, date) {
  const { rows } = await pool.query(
    `SELECT a.player_id, a.raw_name, a.raw_position, a.raw_team, a.bye,
            a.adp::float AS adp, a.high::float AS high, a.low::float AS low,
            a.stdev::float AS stdev, a.times_drafted,
            p.name AS master_name, p.position AS master_position, p.team AS master_team
     FROM adp_history a
     LEFT JOIN players_master p ON p.player_id = a.player_id
     WHERE a.site = $1 AND a.format = $2 AND a.teams = $3 AND a.snapshot_date = $4
     ORDER BY a.adp ASC`,
    [key.site, key.format, key.teams, date]
  );
  return rows.map((r) => ({
    player_id: r.player_id,
    name: r.master_name || r.raw_name,
    position: r.master_position || r.raw_position || '',
    team: r.master_team || r.raw_team || '',
    raw_name: r.raw_name,
    matched: !!r.player_id,
    bye: r.bye,
    adp: r.adp,
    high: r.high,
    low: r.low,
    stdev: r.stdev,
    times_drafted: r.times_drafted,
  }));
}

// The latest board for a format (?format=half&teams=12&site=ffc).
router.get('/latest', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: { rows: [] } });
    const format = String(req.query.format || '').toLowerCase();
    if (!format) return res.status(400).json({ ok: false, error: 'Say which scoring format you want ADP for.' });
    const key = await resolveKey({ site: req.query.site, format, teams: req.query.teams });
    if (!key) return res.json({ ok: true, data: { rows: [], format } });
    const rows = await snapshotRows(key, key.latest);
    const source_url = await sourceUrlFor(key.site, key.format, key.teams);
    // Real capture/collection time (adp_history.created_at), not just the
    // snapshot DATE — so the owner sees exactly how fresh a board is.
    const { rows: capRows } = await pool.query(
      'SELECT MAX(created_at) AS at FROM adp_history WHERE site = $1 AND format = $2 AND teams = $3 AND snapshot_date = $4',
      [key.site, key.format, key.teams, key.latest]
    );
    res.json({ ok: true, data: { site: key.site, format: key.format, teams: key.teams, snapshot_date: key.latest, captured_at: capRows[0] && capRows[0].at, source_url, rows } });
  } catch (err) {
    console.error(`GET /api/adp/latest: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load ADP.' });
  }
});

// Risers/fallers: today's snapshot vs the newest one at least N days older.
router.get('/movers', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: { pairs: [] } });
    const format = String(req.query.format || '').toLowerCase();
    if (!format) return res.status(400).json({ ok: false, error: 'Say which scoring format you want movers for.' });
    const days = Math.max(1, parseInt(req.query.days, 10) || 7);
    const key = await resolveKey({ site: req.query.site, format, teams: req.query.teams });
    if (!key) return res.json({ ok: true, data: { pairs: [], format } });
    const { rows: prevRows } = await pool.query(
      `SELECT MAX(snapshot_date)::text AS prev
       FROM adp_history
       WHERE site = $1 AND format = $2 AND teams = $3
         AND snapshot_date <= $4::date - $5::int`,
      [key.site, key.format, key.teams, key.latest, days]
    );
    const prevDate = prevRows[0] && prevRows[0].prev;
    const current = await snapshotRows(key, key.latest);
    if (!prevDate) {
      return res.json({ ok: true, data: { site: key.site, format: key.format, teams: key.teams, latest: key.latest, prev: null, pairs: [], entered: [] } });
    }
    const previous = await snapshotRows(key, prevDate);
    const prevBy = new Map();
    for (const r of previous) prevBy.set(r.player_id || `raw:${r.raw_name}`, r);
    const pairs = [];
    const entered = [];
    for (const r of current) {
      const p = prevBy.get(r.player_id || `raw:${r.raw_name}`);
      if (p) {
        const delta = Math.round((p.adp - r.adp) * 10) / 10; // + = drafted earlier now (riser)
        pairs.push({ player_id: r.player_id, name: r.name, position: r.position, team: r.team, adp: r.adp, prev_adp: p.adp, delta });
      } else {
        entered.push({ player_id: r.player_id, name: r.name, position: r.position, team: r.team, adp: r.adp });
      }
    }
    pairs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    res.json({ ok: true, data: { site: key.site, format: key.format, teams: key.teams, latest: key.latest, prev: prevDate, pairs, entered } });
  } catch (err) {
    console.error(`GET /api/adp/movers: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not compute risers and fallers.' });
  }
});

// One player's ADP series (for trend displays).
router.get('/history/:playerId', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    const format = String(req.query.format || '').toLowerCase();
    const params = [req.params.playerId];
    let where = 'player_id = $1';
    if (format) { params.push(format); where += ` AND format = $${params.length}`; }
    if (req.query.site) { params.push(String(req.query.site)); where += ` AND site = $${params.length}`; }
    if (req.query.teams) { params.push(Number(req.query.teams)); where += ` AND teams = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT site, format, teams, snapshot_date::text AS date, adp::float AS adp
       FROM adp_history WHERE ${where}
       ORDER BY snapshot_date ASC`,
      params
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error(`GET /api/adp/history: ${err.message}`);
    res.status(500).json({ ok: false, error: "Could not load that player's ADP history." });
  }
});

// Collector status: what's stored, what's configured, how the last run went.
router.get('/status', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: { db: false, snapshots: [] } });
    const { rows: groups } = await pool.query(
      `SELECT site, format, teams, snapshot_date::text AS date,
              COUNT(*)::int AS rows,
              COUNT(*) FILTER (WHERE player_id IS NULL)::int AS unmatched,
              MAX(created_at) AS captured
       FROM adp_history
       GROUP BY site, format, teams, snapshot_date`
    );
    const latestByKey = new Map();
    for (const g of groups) {
      const k = `${g.site}|${g.format}|${g.teams}`;
      const cur = latestByKey.get(k);
      if (!cur || g.date > cur.date) latestByKey.set(k, g);
    }
    const snapshots = Array.from(latestByKey.values())
      .map((g) => ({ site: g.site, format: g.format, teams: Number(g.teams), latest: g.date, captured: g.captured, rows: g.rows, unmatched: g.unmatched }))
      .sort((a, b) => a.site.localeCompare(b.site) || a.format.localeCompare(b.format) || a.teams - b.teams);
    const [auto, year, lastRun, targets, customSources] = await Promise.all([
      settings.get('adp.auto', true),
      settings.get('adp.year', null),
      settings.get('adp.last_run', null),
      collect.ffcTargets(),
      settings.get('adp.custom_sources', []),
    ]);
    res.json({ ok: true, data: { db: true, snapshots, auto: auto !== false, year, last_run: lastRun, ffc_targets: targets, custom_sources: Array.isArray(customSources) ? customSources : [] } });
  } catch (err) {
    console.error(`GET /api/adp/status: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load the ADP collector status.' });
  }
});

// Collect now (the page's button). Body: { force?: true } re-pulls today.
router.post('/collect', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'ADP collection needs a database.' });
    const summary = await collect.collectNow({ force: !!(req.body && req.body.force) });
    res.json({ ok: true, data: { summary } });
  } catch (err) {
    console.error(`POST /api/adp/collect: ${err.message}`);
    res.status(500).json({ ok: false, error: `ADP collection failed: ${err.message}` });
  }
});

// Collector dials. Body: { auto?, year?, sources? } — null clears an override.
router.put('/config', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Settings need a database.' });
    const body = req.body || {};
    if (body.auto !== undefined) await settings.set('adp.auto', !!body.auto);
    if (body.year !== undefined) {
      const y = parseInt(body.year, 10);
      if (body.year === null || body.year === '' || !Number.isFinite(y)) await settings.remove('adp.year');
      else await settings.set('adp.year', y);
    }
    if (body.sources !== undefined) {
      if (!body.sources) await settings.remove('adp.sources');
      else if (Array.isArray(body.sources)) await settings.set('adp.sources', body.sources);
      else return res.status(400).json({ ok: false, error: 'sources must be a list of {format, teams}.' });
    }
    res.json({ ok: true, data: { saved: true } });
  } catch (err) {
    console.error(`PUT /api/adp/config: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save the collector settings.' });
  }
});

// Custom ADP sources the owner added by URL. GET lists them; PUT replaces the
// list (each entry validated against a known adapter so a bad link is rejected
// loudly, not saved to silently fail every night).
router.get('/sources', async (req, res) => {
  try {
    const list = await settings.get('adp.custom_sources', []);
    res.json({ ok: true, data: { sources: Array.isArray(list) ? list : [], hint: custom.SUPPORTED_HINT } });
  } catch (err) {
    console.error(`GET /api/adp/sources: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load your ADP sources.' });
  }
});

router.put('/sources', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'ADP sources need a database.' });
    const entries = req.body && req.body.sources;
    if (!Array.isArray(entries)) return res.status(400).json({ ok: false, error: 'sources must be a list.' });
    const cleaned = [];
    for (const e of entries) {
      const id = e && e.url && custom.identify(e.url);
      if (!id) return res.status(400).json({ ok: false, error: `That link can't be read as an ADP source. ${custom.SUPPORTED_HINT}` });
      cleaned.push({
        url: id.url,
        label: (e.label && String(e.label).trim()) || id.label,
        format: custom.cleanFormat(e.format || custom.inferFormat(id.url)),
        teams: Number(e.teams) || 12,
        enabled: e.enabled !== false,
      });
    }
    await settings.set('adp.custom_sources', cleaned);
    res.json({ ok: true, data: { sources: cleaned } });
  } catch (err) {
    console.error(`PUT /api/adp/sources: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save your ADP sources.' });
  }
});

// The capture token the Yahoo bookmarklet carries. GET returns it (minting one
// on first use); POST rotates it (if it ever leaks, the old bookmarklet dies).
router.get('/capture', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Capture needs a database.' });
    let token = await settings.get('adp.ingest_token', null);
    if (!token) { token = crypto.randomBytes(24).toString('hex'); await settings.set('adp.ingest_token', token); }
    res.json({ ok: true, data: { token, last_capture: await settings.get('adp.last_capture', null) } });
  } catch (err) {
    console.error(`GET /api/adp/capture: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load the capture token.' });
  }
});

router.post('/capture/rotate', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Capture needs a database.' });
    const token = crypto.randomBytes(24).toString('hex');
    await settings.set('adp.ingest_token', token);
    res.json({ ok: true, data: { token } });
  } catch (err) {
    console.error(`POST /api/adp/capture/rotate: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not rotate the capture token.' });
  }
});

module.exports = router;
