const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres requires SSL from outside its network but the cert
  // is not in the default trust store; internal connections ignore this.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
});

// Without this, an idle client losing its connection (DB restart, network
// blip) emits an unhandled 'error' event and crashes the whole process.
pool.on('error', (err) => {
  console.error(`pg pool: idle client error: ${err.message}`);
});

module.exports = pool;

