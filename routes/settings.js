// Core settings API (mounted at /api/settings, behind the password gate).
// The global control panel reads/writes here; every dial is a settings row.
const express = require('express');
const settings = require('../lib/settings');

const router = express.Router();
const hasDb = () => Boolean(process.env.DATABASE_URL);

router.get('/', async (req, res) => {
  try {
    res.json({ ok: true, data: await settings.getAll() });
  } catch (err) {
    console.error(`GET /api/settings: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load settings.' });
  }
});

// Upsert one or more settings. Body: { entries: { key: value, ... } }.
router.put('/', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Settings need a database (DATABASE_URL is not set).' });
    const entries = (req.body && req.body.entries) || {};
    const keys = Object.keys(entries);
    if (!keys.length) return res.status(400).json({ ok: false, error: 'Nothing to save.' });
    for (const key of keys) await settings.set(key, entries[key]);
    res.json({ ok: true, data: await settings.getAll() });
  } catch (err) {
    console.error(`PUT /api/settings: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save settings.' });
  }
});

module.exports = router;
