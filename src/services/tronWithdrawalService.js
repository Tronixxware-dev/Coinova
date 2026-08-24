const pool = require('../config/db');
const { TronWeb } = require('tronweb');
const Decimal = require('decimal.js');
const { deriveTronWallet } = require('./tronWallet');

const TRON_RPC_URL = process.env.TRON_RPC_URL;
const USDT_CONTRACT = process.env.TRON_USDT_CONTRACT;
const USDT_DECIMALS = 6;

async function withdrawTronUsdt(userId, toAddress, amount) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    const err = new Error('amount must be a positive number');
    err.status = 400;
    throw err;
  }
  if (!TronWeb.isAddress(toAddress)) {
    const err = new Error('toAddress is not a valid TRON address');
    err.status = 400;
    throw err;
  }

  // Deduct from the internal ledger first, row-locked, so two concurrent
  // withdrawal requests can't both pass the balance check.
  const client = await pool.connect();
  let deducted = false;
  try {
    await client.query('BEGIN');
    const walletResult = await client.query(
      `SELECT balance FROM wallets WHERE user_id = $1 AND asset = 'USDT' FOR UPDATE`,
      [userId]
    );
    const wallet = walletResult.rows[0];
    if (!wallet || Number(wallet.balance) < numericAmount) {
      await client.query('ROLLBACK');
      const err = new Error('Insufficient USDT balance');
      err.status = 400;
      throw err;
    }
    await client.query(
      `UPDATE wallets SET balance = balance - $1 WHERE user_id = $2 AND asset = 'USDT'`,
      [numericAmount, userId]
    );
    await client.query('COMMIT');
    deducted = true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  try {
    const { privateKey, address: fromAddress } = deriveTronWallet(userId);
    const signingTronWeb = new TronWeb({ fullHost: TRON_RPC_URL, privateKey });

    const rawAmount = new Decimal(numericAmount).mul(10 ** USDT_DECIMALS).toFixed(0);

    const functionSelector = 'transfer(address,uint256)';
    const parameter = [
      { type: 'address', value: toAddress },
      { type: 'uint256', value: rawAmount },
    ];

    const tx = await signingTronWeb.transactionBuilder.triggerSmartContract(
      USDT_CONTRACT,
      functionSelector,
      { feeLimit: 100_000_000, callValue: 0 },
      parameter,
      fromAddress
    );

    if (!tx.result || !tx.result.result) {
      throw new Error(
        'Failed to build the withdrawal transaction — this usually means the address ' +
        'does not have enough TRX to pay for energy/bandwidth.'
      );
    }

    const signedTx = await signingTronWeb.trx.sign(tx.transaction);
    const broadcastResult = await signingTronWeb.trx.sendRawTransaction(signedTx);

    if (!broadcastResult.result) {
      throw new Error(`Broadcast failed: ${JSON.stringify(broadcastResult)}`);
    }

    return { txHash: broadcastResult.txid, amount: numericAmount, toAddress };
  } catch (err) {
    // On-chain send failed after the ledger was already deducted — refund it.
    if (deducted) {
      await pool.query(
        `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2 AND asset = 'USDT'`,
        [numericAmount, userId]
      );
    }
    throw err;
  }
}

module.exports = { withdrawTronUsdt };