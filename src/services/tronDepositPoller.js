const pool = require('../config/db');

const TRON_API_BASE = process.env.TRON_RPC_URL;
const USDT_CONTRACT = process.env.TRON_USDT_CONTRACT;
const USDT_DECIMALS = 6;

async function fetchIncomingUsdtTransfers(address) {
  const url = `${TRON_API_BASE}/v1/accounts/${address}/transactions/trc20` +
    `?contract_address=${USDT_CONTRACT}&only_to=true&limit=20&order_by=block_timestamp,desc`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TronGrid request failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  return body.data || [];
}

// Records the deposit and credits the wallet in one transaction, guarded
// by onchain_deposits' UNIQUE(chain, tx_hash, asset) constraint — if this
// tx was already processed, the INSERT is a no-op and nothing is credited
// twice, even if the poller sees the same transfer again later.
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

async function pollTronDeposits() {
  const { rows: addresses } = await pool.query(
    `SELECT user_id, address FROM deposit_addresses WHERE chain = 'TRON'`
  );

  for (const { user_id, address } of addresses) {
    try {
      const transfers = await fetchIncomingUsdtTransfers(address);
      for (const t of transfers) {
        const decimals = Number(t.token_info?.decimals ?? USDT_DECIMALS);
        const amount = Number(t.value) / 10 ** decimals;
        const credited = await creditDeposit({
          userId: user_id,
          chain: 'TRON',
          asset: 'USDT',
          txHash: t.transaction_id,
          amount,
        });
        if (credited) {
          console.log(`Credited ${amount} USDT to user ${user_id} (tx ${t.transaction_id})`);
        }
      }
    } catch (err) {
      console.error(`Error polling TRON deposits for ${address}:`, err.message);
    }
  }
}

function startTronDepositPoller(intervalMs = 30000) {
  pollTronDeposits().catch((err) => console.error('Initial TRON poll failed:', err));
  return setInterval(() => {
    pollTronDeposits().catch((err) => console.error('TRON poll failed:', err));
  }, intervalMs);
}

module.exports = { pollTronDeposits, startTronDepositPoller };