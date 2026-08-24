require('dotenv').config();
const pool = require('./src/config/db');

pool.query(`SELECT balance FROM wallets WHERE user_id = 1 AND asset = 'ETH'`)
  .then((r) => console.log(r.rows[0]))
  .finally(() => process.exit());