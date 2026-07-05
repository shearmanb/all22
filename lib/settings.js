// lib/settings.js — the control panel's storage. Every tweakable dial lives in
// the settings table (PRD §11: "tweak in the app, not in code"). Values are
// JSONB, so a setting can be a string, number, list or object.
const pool = require('../db/pool');

const hasDb = () => Boolean(process.env.DATABASE_URL);

async function getAll() {
  if (!hasDb()) return {};
  const { rows } = await pool.query('SELECT key, value, updated_at FROM settings ORDER BY key');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function get(key, fallback = null) {
  if (!hasDb()) return fallback;
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length ? rows[0].value : fallback;
  } catch (err) {
    console.error(`settings: get ${key} failed: ${err.message}`);
    return fallback;
  }
}

async function set(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

async function remove(key) {
  await pool.query('DELETE FROM settings WHERE key = $1', [key]);
}

module.exports = { getAll, get, set, remove };
