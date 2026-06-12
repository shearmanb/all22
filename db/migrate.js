const fs = require('fs');
const path = require('path');
const pool = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  let ranAny = false;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`migrate: applied ${file}`);
      ranAny = true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
  if (!ranAny) console.log('migrate: no new migrations');
}

async function appliedMigrations() {
  const { rows } = await pool.query(
    'SELECT filename FROM schema_migrations ORDER BY filename'
  );
  return rows.map((r) => r.filename);
}

module.exports = { runMigrations, appliedMigrations };
