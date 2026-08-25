const pool = require('../config/db');

const BTC_API_BASE = process.env.BTC_API_BASE;

async function fetchAddressTxs(address) {
  const res = await fetch(`${BTC_API_BASE}/address/${address}/txs`);
  if (!res.ok) throw new Error(`mempool.space request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function creditDeposit({ userId, chain, asset, txHash, amount }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO onchain_deposits (user_id, chain, asset, tx_hash, amount, status, credited_at)
       VALUES ($1, $2, $3, $4, $5, 'CREDITED', NOW())
       ON CONFLICT (chain, tx_hash, asset) DO NOTHING
       RETURNING *`,
      [userId, chain, asset, txHash, amount]
    );
    if (!inserted.rows[0]) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO wallets (user_id, asset, balance)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, asset)
       DO UPDATE SET balance = wallets.balance + EXCLUDED.balance`,
      [userId, asset, amount]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function pollBtcDeposits() {
  const { rows: addresses } = await pool.query(
    `SELECT user_id, address FROM deposit_addresses WHERE chain = 'BTC'`
  );

  for (const { user_id, address } of addresses) {
    try {
      const txs = await fetchAddressTxs(address);
      for (const tx of txs) {
        if (!tx.status?.confirmed) continue; // wait for confirmation before crediting

        const receivedSats = tx.vout
          .filter((v) => v.scriptpubkey_address === address)
          .reduce((sum, v) => sum + v.value, 0);
        if (!receivedSats) continue;

        const amount = receivedSats / 1e8;
        const credited = await creditDeposit({
          userId: user_id,
          chain: 'BTC',
          asset: 'BTC',
          txHash: tx.txid,
          amount,
        });
        if (credited) {
          console.log(`Credited ${amount} BTC to user ${user_id} (tx ${tx.txid})`);
        }
      }
    } catch (err) {
      console.error(`Error polling BTC deposits for ${address}:`, err.message, err.cause || '');
    }
  }
}

function startBtcDepositPoller(intervalMs = 30000) {
  pollBtcDeposits().catch((err) => console.error('Initial BTC poll failed:', err));
  return setInterval(() => {
    pollBtcDeposits().catch((err) => console.error('BTC poll failed:', err));
  }, intervalMs);
}

module.exports = { pollBtcDeposits, startBtcDepositPoller };