const pool = require('../../src/config/db');
const redis = require('../../src/config/redis');

async function resetDb() {
  await pool.query(
    'TRUNCATE TABLE trades, wallet_transactions, stake_withdrawals, stakes, refresh_tokens, orders, wallets, users RESTART IDENTITY CASCADE'
  );
  await redis.flushdb();
}

async function closeAll() {
  await pool.end();
  redis.disconnect();
}

module.exports = { resetDb, closeAll, pool, redis };