const { Pool } = require('pg');
require('dotenv').config({ quiet: true });

// Single shared connection pool for the whole app.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Sensible defaults for a small app — tune if you scale up.
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error:', err);
});

module.exports = pool;