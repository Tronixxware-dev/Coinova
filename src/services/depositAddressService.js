const pool = require('../config/db');
const { deriveEthWallet } = require('./ethWallet');
const { deriveTronWallet } = require('./tronWallet');
const { deriveBtcWallet } = require('./btcWallet');

function deriveAddressForChain(chain, index) {
  if (chain === 'ETH') {
    return deriveEthWallet(index).address;
  }
  if (chain === 'TRON') {
    return deriveTronWallet(index).address;
  }
  if (chain === 'BTC') {
    return deriveBtcWallet(index).address;
  }
  const err = new Error(`Unsupported chain: ${chain}`);
  err.status = 400;
  throw err;
}

async function getOrCreateDepositAddress(userId, chain) {
  const existing = await pool.query(
    `SELECT * FROM deposit_addresses WHERE user_id = $1 AND chain = $2`,
    [userId, chain]
  );
  if (existing.rows[0]) return existing.rows[0];

  const address = deriveAddressForChain(chain, userId);

  const inserted = await pool.query(
    `INSERT INTO deposit_addresses (user_id, chain, address, derivation_index)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, chain) DO NOTHING
     RETURNING *`,
    [userId, chain, address, userId]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const retry = await pool.query(
    `SELECT * FROM deposit_addresses WHERE user_id = $1 AND chain = $2`,
    [userId, chain]
  );
  return retry.rows[0];
}

module.exports = { getOrCreateDepositAddress };