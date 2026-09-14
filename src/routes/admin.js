const express = require('express');
const pool = require('../config/db');
const logger = require('../config/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const VALID_ASSETS = ['USDT', 'BTC', 'ETH'];
const VALID_TIERS = [1, 2];

router.use(requireAuth, requireAdmin);

// GET /api/admin/users?search=
router.get('/users', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  try {
    const result = search
      ? await pool.query(
          `SELECT id, email, username, is_admin, is_suspended, tier, created_at
           FROM users
           WHERE email ILIKE $1 OR username ILIKE $1
           ORDER BY id DESC`,
          [`%${search}%`]
        )
      : await pool.query(
          `SELECT id, email, username, is_admin, is_suspended, tier, created_at
           FROM users
           ORDER BY id DESC`
        );
    res.json({ users: result.rows });
  } catch (err) {
    logger.error({ err }, 'Admin: list users error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/users/:id
router.get('/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const userResult = await pool.query(
      `SELECT id, email, username, is_admin, is_suspended, tier, created_at
       FROM users WHERE id = $1`,
      [id]
    );
    const user = userResult.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const walletResult = await pool.query(
      `SELECT asset, balance, locked_balance FROM wallets WHERE user_id = $1`,
      [id]
    );
    res.json({ user, wallets: walletResult.rows });
  } catch (err) {
    logger.error({ err }, 'Admin: get user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/users/:id/suspend
router.post('/users/:id/suspend', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE users SET is_suspended = TRUE WHERE id = $1 RETURNING id, email, username, is_suspended`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Suspending should kill any active sessions immediately, not
    // just block future logins.
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [id]);
    res.json({ user: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Admin: suspend user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/users/:id/unsuspend
router.post('/users/:id/unsuspend', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE users SET is_suspended = FALSE WHERE id = $1 RETURNING id, email, username, is_suspended`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Admin: unsuspend user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/users/:id/balance  { asset, delta }
router.post('/users/:id/balance', async (req, res) => {
  const { id } = req.params;
  const { asset, delta } = req.body;
  const deltaNum = Number(delta);

  if (!VALID_ASSETS.includes(asset)) {
    return res.status(400).json({ error: `asset must be one of ${VALID_ASSETS.join(', ')}` });
  }
  if (!Number.isFinite(deltaNum) || deltaNum === 0) {
    return res.status(400).json({ error: 'delta must be a non-zero number' });
  }

  try {
    const result = await pool.query(
      `UPDATE wallets SET balance = balance + $1
       WHERE user_id = $2 AND asset = $3
       RETURNING asset, balance, locked_balance`,
      [deltaNum, id, asset]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wallet row not found for this user/asset' });
    }
    logger.info(
      { adminId: req.user.id, targetUserId: id, asset, delta: deltaNum },
      'Admin adjusted user balance'
    );
    res.json({ wallet: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Admin: adjust balance error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/admin/users/:id/tier  { tier }
router.patch('/users/:id/tier', async (req, res) => {
  const { id } = req.params;
  const tier = Number(req.body.tier);

  if (!VALID_TIERS.includes(tier)) {
    return res.status(400).json({ error: `tier must be one of ${VALID_TIERS.join(', ')}` });
  }

  try {
    const result = await pool.query(
      `UPDATE users SET tier = $1 WHERE id = $2 RETURNING id, email, username, tier`,
      [tier, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    logger.info({ adminId: req.user.id, targetUserId: id, tier }, 'Admin changed user tier');
    res.json({ user: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Admin: update tier error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/tickets?status=OPEN
router.get('/tickets', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : null;
  try {
    const result =
      status === 'OPEN' || status === 'RESOLVED'
        ? await pool.query(
            `SELECT t.id, t.subject, t.message, t.status, t.created_at,
                    u.id AS user_id, u.email, u.username
             FROM support_tickets t
             JOIN users u ON u.id = t.user_id
             WHERE t.status = $1
             ORDER BY t.created_at DESC`,
            [status]
          )
        : await pool.query(
            `SELECT t.id, t.subject, t.message, t.status, t.created_at,
                    u.id AS user_id, u.email, u.username
             FROM support_tickets t
             JOIN users u ON u.id = t.user_id
             ORDER BY t.created_at DESC`
          );
    res.json({ tickets: result.rows });
  } catch (err) {
    logger.error({ err }, 'Admin: list tickets error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/tickets/:id/resolve
router.post('/tickets/:id/resolve', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE support_tickets SET status = 'RESOLVED' WHERE id = $1 RETURNING id, status`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    res.json({ ticket: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Admin: resolve ticket error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/transactions?status=PENDING&asset=BTC
router.get('/transactions', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : null;
  const asset = typeof req.query.asset === 'string' ? req.query.asset.toUpperCase() : null;

  const conditions = [];
  const params = [];
  if (status && ['PENDING', 'SENT', 'FAILED'].includes(status)) {
    params.push(status);
    conditions.push(`t.status = $${params.length}`);
  }
  if (asset) {
    params.push(asset);
    conditions.push(`t.asset = $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT t.id, t.asset, t.to_address, t.amount, t.status, t.fake_tx_hash, t.created_at, t.updated_at,
              u.id AS user_id, u.email, u.username
       FROM simulated_transactions t
       JOIN users u ON u.id = t.user_id
       ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    logger.error({ err }, 'Admin: list transactions error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/admin/transactions/:id/status  { status: 'SENT' | 'FAILED' }
// Only a PENDING transaction can be updated. This is the only place
// that resolves the hold created by POST /wallet/simulated-send: SENT
// finalizes it (the locked amount is simply removed — the "money" left
// for good), FAILED releases it back to the user's available balance.
router.patch('/transactions/:id/status', async (req, res) => {
  const { id } = req.params;
  const status = typeof req.body.status === 'string' ? req.body.status.toUpperCase() : '';
  if (!['SENT', 'FAILED'].includes(status)) {
    return res.status(400).json({ error: "status must be 'SENT' or 'FAILED'" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      `SELECT id, user_id, asset, amount, status FROM simulated_transactions WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const tx = txResult.rows[0];
    if (!tx) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found' });
    }
    if (tx.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only pending transactions can be updated' });
    }

    if (status === 'SENT') {
      // Finalize: remove the held amount entirely.
      await client.query(
        `UPDATE wallets SET locked_balance = locked_balance - $3
         WHERE user_id = $1 AND asset = $2`,
        [tx.user_id, tx.asset, tx.amount]
      );
    } else {
      // Failed: release the hold back to available balance.
      await client.query(
        `UPDATE wallets SET locked_balance = locked_balance - $3, balance = balance + $3
         WHERE user_id = $1 AND asset = $2`,
        [tx.user_id, tx.asset, tx.amount]
      );
    }

    const updated = await client.query(
      `UPDATE simulated_transactions SET status = $2, updated_at = now() WHERE id = $1
       RETURNING id, asset, to_address, amount, status, fake_tx_hash, created_at, updated_at`,
      [id, status]
    );

    await client.query('COMMIT');
    res.json({ transaction: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Admin: update transaction status error');
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;