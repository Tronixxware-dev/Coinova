const { Pool } = require('pg');

const email = process.argv[2];
const connectionString = process.argv[3];

if (!email || !connectionString) {
  console.error('Usage: node inspect-user.js <email> "<external-database-url>"');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

pool.query(
  'SELECT id, email, username, password_hash FROM users WHERE email = $1',
  [email]
)
  .then((result) => {
    console.log(`Found ${result.rows.length} row(s) for ${email}:`);
    result.rows.forEach((row) => {
      console.log({
        id: row.id,
        email: row.email,
        username: row.username,
        password_hash_prefix: row.password_hash?.slice(0, 15),
        password_hash_length: row.password_hash?.length,
      });
    });
  })
  .catch((err) => console.error('Query failed:', err))
  .finally(() => pool.end());