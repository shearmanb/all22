const express = require('express');
const pool = require('../db/pool');
const { appliedMigrations } = require('../db/migrate');

const router = express.Router();

router.get('/health', async (req, res) => {
  const result = { ok: true, app: 'ok', db: 'ok', migrations: [] };
  try {
    await pool.query('SELECT 1');
    result.migrations = await appliedMigrations();
  } catch (err) {
    console.error(`GET /health: db check failed: ${err.message}`);
    result.ok = false;
    result.db = `error: ${err.message}`;
    return res.status(503).json(result);
  }
  res.json(result);
});

module.exports = router;
