const pool = require('./src/config/db');

const email = process.argv[2];

if (!email) {
  console.error('Usage: node make-admin.js <email>');
  process.exit(1);
}

pool.query(
  'UPDATE users SET is_admin = TRUE WHERE email = $1 RETURNING id, email, username, is_admin',
  [email]
)
  .then((result) => {
    if (result.rows.length === 0) {
      console.log(`No user found with email ${email}`);
    } else {
      console.log('Updated:', result.rows[0]);
    }
  })
  .catch((err) => console.error('Failed:', err))
  .finally(() => pool.end());