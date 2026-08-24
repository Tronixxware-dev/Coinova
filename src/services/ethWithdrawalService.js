const pool = require('../config/db');
const { ethers } = require('ethers');
const { provider, deriveEthWallet } = require('./ethWallet');

async function withdrawEth(userId, toAddress, amount) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    const err = new Error('amount must be a positive number');
    err.status = 400;
    throw err;
  }
  if (!ethers.isAddress(toAddress)) {
    const err = new Error('toAddress is not a valid Ethereum address');
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();
  let deducted = false;
  try {
    await client.query('BEGIN');
    const walletResult = await client.query(
      `SELECT balance FROM wallets WHERE user_id = $1 AND asset = 'ETH' FOR UPDATE`,
      [userId]
    );
    const wallet = walletResult.rows[0];
    if (!wallet || Number(wallet.balance) < numericAmount) {
      await client.query('ROLLBACK');
      const err = new Error('Insufficient ETH balance');
      err.status = 400;
      throw err;
    }
    await client.query(
      `UPDATE wallets SET balance = balance - $1 WHERE user_id = $2 AND asset = 'ETH'`,
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
    const { privateKey } = deriveEthWallet(userId);
    const signer = new ethers.Wallet(privateKey, provider);

    const tx = await signer.sendTransaction({
      to: toAddress,
      value: ethers.parseEther(numericAmount.toString()),
    });
    await tx.wait(1);

    return { txHash: tx.hash, amount: numericAmount, toAddress };
  } catch (err) {
    if (deducted) {
      await pool.query(
        `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2 AND asset = 'ETH'`,
        [numericAmount, userId]
      );
    }
    throw err;
  }
}

module.exports = { withdrawEth };