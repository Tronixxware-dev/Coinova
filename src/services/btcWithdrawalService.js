const pool = require('../config/db');
const { deriveBtcWallet, bitcoin } = require('./btcWallet');

const BTC_API_BASE = process.env.BTC_API_BASE;

async function fetchUtxos(address) {
  const res = await fetch(`${BTC_API_BASE}/address/${address}/utxo`);
  if (!res.ok) throw new Error(`mempool.space request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchFeeRate() {
  const res = await fetch(`${BTC_API_BASE}/v1/fees/recommended`);
  if (!res.ok) throw new Error(`mempool.space request failed: ${res.status} ${res.statusText}`);
  const fees = await res.json();
  return fees.economyFee || fees.hourFee || 2; // sat/vByte, fall back to a safe default
}

async function broadcastTx(hex) {
  const res = await fetch(`${BTC_API_BASE}/tx`, { method: 'POST', body: hex });
  const text = await res.text();
  if (!res.ok) throw new Error(`Broadcast failed: ${text}`);
  return text.trim(); // mempool.space returns the raw txid as plain text
}

function isValidBtcAddress(address) {
  try {
    bitcoin.address.toOutputScript(address, bitcoin.networks.testnet);
    return true;
  } catch {
    return false;
  }
}

async function withdrawBtc(userId, toAddress, amount) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    const err = new Error('amount must be a positive number');
    err.status = 400;
    throw err;
  }
  if (!isValidBtcAddress(toAddress)) {
    const err = new Error('toAddress is not a valid testnet BTC address');
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();
  let deducted = false;
  try {
    await client.query('BEGIN');
    const walletResult = await client.query(
      `SELECT balance FROM wallets WHERE user_id = $1 AND asset = 'BTC' FOR UPDATE`,
      [userId]
    );
    const wallet = walletResult.rows[0];
    if (!wallet || Number(wallet.balance) < numericAmount) {
      await client.query('ROLLBACK');
      const err = new Error('Insufficient BTC balance');
      err.status = 400;
      throw err;
    }
    await client.query(
      `UPDATE wallets SET balance = balance - $1 WHERE user_id = $2 AND asset = 'BTC'`,
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
    const { address: fromAddress, scriptPubKey, keyPair } = deriveBtcWallet(userId);
    const amountSats = Math.round(numericAmount * 1e8);

    const utxos = await fetchUtxos(fromAddress);
    const feeRate = await fetchFeeRate();

    // Simple greedy coin selection — gather UTXOs until they cover the
    // send amount plus an estimated fee for the transaction built so far.
    const selected = [];
    let selectedSats = 0;
    for (const utxo of utxos) {
      selected.push(utxo);
      selectedSats += utxo.value;
      const estimatedVBytes = selected.length * 68 + 2 * 31 + 11; // 2 outputs: destination + change
      const estimatedFee = Math.ceil(estimatedVBytes * feeRate);
      if (selectedSats >= amountSats + estimatedFee) break;
    }

    const finalVBytes = selected.length * 68 + 2 * 31 + 11;
    const fee = Math.ceil(finalVBytes * feeRate);

    if (selectedSats < amountSats + fee) {
      throw new Error('Not enough confirmed UTXOs at this address to cover the amount plus network fee.');
    }

    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
    for (const utxo of selected) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: { script: scriptPubKey, value: BigInt(utxo.value) },
      });
    }

    psbt.addOutput({ address: toAddress, value: BigInt(amountSats) });

    const change = selectedSats - amountSats - fee;
    if (change > 546) { // above Bitcoin's "dust" threshold — otherwise just leave it as extra fee
      psbt.addOutput({ address: fromAddress, value: BigInt(change) });
    }

    selected.forEach((_, i) => psbt.signInput(i, keyPair));
    psbt.finalizeAllInputs();

    const txHex = psbt.extractTransaction().toHex();
    const txHash = await broadcastTx(txHex);

    return { txHash, amount: numericAmount, toAddress };
  } catch (err) {
    if (deducted) {
      await pool.query(
        `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2 AND asset = 'BTC'`,
        [numericAmount, userId]
      );
    }
    throw err;
  }
}

module.exports = { withdrawBtc };