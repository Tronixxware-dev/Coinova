const { Pool } = require('pg');

const connectionString = process.argv[2];

if (!connectionString) {
  console.error('Usage: node list-users.js "<external-database-url>"');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

pool.query('SELECT id, email, username FROM users ORDER BY id')
  .then((result) => {
    console.log(`Total users in production: ${result.rows.length}`);
    result.rows.forEach((row) => console.log(row));
  })
  .catch((err) => console.error('Query failed:', err))
  .finally(() => pool.end());