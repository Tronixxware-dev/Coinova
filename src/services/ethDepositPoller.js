const pool = require('../config/db');
const { provider } = require('./ethWallet');

let lastCheckedBlock = null;

async function fetchIncomingEthTransfers(address, fromBlock, toBlock) {
  const result = await provider.send('alchemy_getAssetTransfers', [{
    fromBlock: '0x' + fromBlock.toString(16),
    toBlock: '0x' + toBlock.toString(16),
    toAddress: address,
    category: ['external'],
    excludeZeroValue: true,
  }]);
  return result.transfers || [];
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

async function pollEthDeposits() {
  const latestBlock = await provider.getBlockNumber();

  if (lastCheckedBlock === null) {
    // First run — start a little behind the tip so we don't miss anything
    // that landed in the few blocks right before the server started.
    lastCheckedBlock = Math.max(latestBlock - 10, 0);
  }
  if (latestBlock <= lastCheckedBlock) return;

  const fromBlock = lastCheckedBlock + 1;

  const { rows: addresses } = await pool.query(
    `SELECT user_id, address FROM deposit_addresses WHERE chain = 'ETH'`
  );

  for (const { user_id, address } of addresses) {
    try {
      const transfers = await fetchIncomingEthTransfers(address, fromBlock, latestBlock);
      for (const t of transfers) {
        const amount = Number(t.value);
        if (!amount) continue;
        const credited = await creditDeposit({
          userId: user_id,
          chain: 'ETH',
          asset: 'ETH',
          txHash: t.hash,
          amount,
        });
        if (credited) {
          console.log(`Credited ${amount} ETH to user ${user_id} (tx ${t.hash})`);
        }
      }
    } catch (err) {
      console.error(`Error polling ETH deposits for ${address}:`, err.message);
    }
  }

  lastCheckedBlock = latestBlock;
}

function startEthDepositPoller(intervalMs = 30000) {
  pollEthDeposits().catch((err) => console.error('Initial ETH poll failed:', err));
  return setInterval(() => {
    pollEthDeposits().catch((err) => console.error('ETH poll failed:', err));
  }, intervalMs);
}

module.exports = { pollEthDeposits, startEthDepositPoller };