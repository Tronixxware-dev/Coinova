const express = require('express');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Assets this app currently supports trading/holding. Kept in sync by
// hand with priceFeed.js's SYMBOLS list — deposits/withdrawals are
// restricted to these so a typo (e.g. 'DOGE') can't create an orphaned
// wallet for an asset with no market and no way to ever trade out of it.
const SUPPORTED_ASSETS = ['USDT', 'BTC', 'ETH', 'SOL', 'BNB', 'XRP'];

// Generous on purpose — this is a simulator, not a real ledger. Just
// enough of a cap to stop a fat-fingered deposit from producing an
// absurd balance.
const MAX_DEPOSIT_AMOUNT = new Decimal('10000000'); // 10,000,000 units

function toPositiveDecimal(value, label) {
  let d;
  try {
    d = new Decimal(value);
  } catch {
    throw new Error(`${label} must be a valid number`);
  }
  if (!d.isFinite() || !d.isPositive() || d.isZero()) {
    throw new Error(`${label} must be a positive number`);
  }
  return d;
}

async function ensureWallet(client, userId, asset) {
  await client.query(
    `INSERT INTO wallets (user_id, asset, balance)
     VALUES ($1, $2, 0)
     ON CONFLICT (user_id, asset) DO NOTHING`,
    [userId, asset]
  );
}

// GET /api/wallet — all asset balances for the logged-in user
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT asset, balance, locked_balance
       FROM wallets
       WHERE user_id = $1
       ORDER BY asset ASC`,
      [req.user.id]
    );
    res.json({ wallets: result.rows });
  } catch (err) {
    console.error('Wallet fetch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/wallet/deposit — { asset, amount } adds virtual funds.
// Simulated only: no real money or external transfer is involved.
router.post('/deposit', requireAuth, async (req, res) => {
  const asset = typeof req.body.asset === 'string' ? req.body.asset.toUpperCase() : req.body.asset;

  if (!SUPPORTED_ASSETS.includes(asset)) {
    return res.status(400).json({ error: `Unsupported asset. Choose one of: ${SUPPORTED_ASSETS.join(', ')}` });
  }

  let amount;
  try {
    amount = toPositiveDecimal(req.body.amount, 'amount');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (amount.greaterThan(MAX_DEPOSIT_AMOUNT)) {
    return res.status(400).json({ error: `amount cannot exceed ${MAX_DEPOSIT_AMOUNT.toFixed()} per deposit` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWallet(client, req.user.id, asset);

    const result = await client.query(
      `UPDATE wallets SET balance = balance + $3
       WHERE user_id = $1 AND asset = $2
       RETURNING balance`,
      [req.user.id, asset, amount.toFixed()]
    );
    const newBalance = result.rows[0].balance;

    await client.query(
      `INSERT INTO wallet_transactions (user_id, asset, type, amount, balance_after)
       VALUES ($1, $2, 'DEPOSIT', $3, $4)`,
      [req.user.id, asset, amount.toFixed(), newBalance]
    );

    await client.query('COMMIT');
    res.status(201).json({ asset, amount: amount.toFixed(), balance: newBalance });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/wallet/withdraw — { asset, amount } removes virtual funds.
// Only the free (unlocked) balance is eligible — funds reserved
// against open orders can't be withdrawn until the order fills or is
// cancelled, same rule a real exchange would enforce.
router.post('/withdraw', requireAuth, async (req, res) => {
  const asset = typeof req.body.asset === 'string' ? req.body.asset.toUpperCase() : req.body.asset;

  if (!SUPPORTED_ASSETS.includes(asset)) {
    return res.status(400).json({ error: `Unsupported asset. Choose one of: ${SUPPORTED_ASSETS.join(', ')}` });
  }

  let amount;
  try {
    amount = toPositiveDecimal(req.body.amount, 'amount');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The WHERE balance >= $3 guard makes this atomic against
    // concurrent withdrawals — same pattern as lockFunds() in
    // orderEngine.js. Without it, two simultaneous withdrawal requests
    // could both read a sufficient balance before either writes,
    // letting the user withdraw more than they actually have.
    const result = await client.query(
      `UPDATE wallets SET balance = balance - $3
       WHERE user_id = $1 AND asset = $2 AND balance >= $3
       RETURNING balance`,
      [req.user.id, asset, amount.toFixed()]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient ${asset} balance` });
    }
    const newBalance = result.rows[0].balance;

    await client.query(
      `INSERT INTO wallet_transactions (user_id, asset, type, amount, balance_after)
       VALUES ($1, $2, 'WITHDRAWAL', $3, $4)`,
      [req.user.id, asset, amount.toFixed(), newBalance]
    );

    await client.query('COMMIT');
    res.status(201).json({ asset, amount: amount.toFixed(), balance: newBalance });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Withdrawal error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// GET /api/wallet/transactions — deposit/withdrawal ledger history.
// Optional query params: ?asset=USDT&limit=50
router.get('/transactions', requireAuth, async (req, res) => {
  const { asset } = req.query;
  const conditions = ['user_id = $1'];
  const params = [req.user.id];

  if (asset) {
    params.push(asset.toUpperCase());
    conditions.push(`asset = $${params.length}`);
  }

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  limit = Math.min(limit, 500);
  params.push(limit);

  try {
    const result = await pool.query(
      `SELECT id, asset, type, amount, balance_after, created_at
       FROM wallet_transactions
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    console.error('Transaction history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;