// Edge Rush capture receiver — the ONE route that lives OUTSIDE the password
// gate, because the Yahoo bookmarklet POSTs to it cross-origin from
// football.fantasysports.yahoo.com and can't carry the app's session cookie.
//
// Auth is a capture token instead: a per-install secret the owner gets from the
// Edge Rush page (baked into the bookmarklet). No cookies, so a wide-open CORS
// origin is safe — the token is the credential, and all the endpoint can do is
// insert ADP rows. The bookmarklet sends text/plain JSON to dodge a CORS
// preflight; express.text() (server.js) hands it here as a string.
const express = require('express');
const router = express.Router();

const settings = require('../../lib/settings');
const collect = require('./lib/collect');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

router.options('/api/adp/ingest', (req, res) => { cors(res); res.status(204).end(); });

router.post('/api/adp/ingest', async (req, res) => {
  cors(res);
  try {
    if (!process.env.DATABASE_URL) return res.status(400).json({ ok: false, error: 'Capture needs a database.' });
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ ok: false, error: 'The captured data was not valid JSON.' }); }
    }
    body = body || {};
    const token = await settings.get('adp.ingest_token', null);
    if (!token || body.token !== token) {
      return res.status(401).json({ ok: false, error: 'Bad or missing capture token — re-copy the bookmarklet from Edge Rush.' });
    }
    const result = await collect.ingestSnapshot({
      site: body.site || 'capture',
      format: body.format,
      teams: body.teams,
      rows: body.rows,
      source_url: body.source_url,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`POST /api/adp/ingest: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
