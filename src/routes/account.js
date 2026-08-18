const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();
const SALT_ROUNDS = 12;
const PG_UNIQUE_VIOLATION = '23505';

// These accept a password and are only otherwise gated by an existing
// access token — someone with a stolen token could try to brute-force
// the actual password through here. Same guard as the auth routes.
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: () => process.env.NODE_ENV === 'test',
});
router.use(accountLimiter);

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : email;
}

// PATCH /api/account/password
router.patch('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

    // Changing the password invalidates every existing session
    // (this one included) — an attacker holding a stolen refresh
    // token loses access immediately instead of staying logged in.
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [req.user.id]);

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Change password error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/account/email
router.patch('/email', requireAuth, async (req, res) => {
  const newEmail = normalizeEmail(req.body.newEmail);
  const { password } = req.body;

  if (!newEmail || !password) {
    return res.status(400).json({ error: 'newEmail and password are required' });
  }

  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Password is incorrect' });
    }

    const updateResult = await pool.query(
      'UPDATE users SET email = $1 WHERE id = $2 RETURNING id, email, username',
      [newEmail, req.user.id]
    );

    res.json({ user: updateResult.rows[0] });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    logger.error({ err }, 'Change email error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/account
router.delete('/', requireAuth, async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'password is required' });
  }

  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Password is incorrect' });
    }

    // ON DELETE CASCADE on every user_id foreign key cleans up
    // wallets, orders, trades, refresh_tokens, stakes, and
    // stake_withdrawals in this one query.
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Delete account error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const MAX_AVATAR_DATA_URL_LENGTH = 2 * 1024 * 1024; // generous cap on the base64 string

// PATCH /api/account/avatar
router.patch('/avatar', requireAuth, async (req, res) => {
  const { avatarDataUrl } = req.body;

  if (!avatarDataUrl || typeof avatarDataUrl !== 'string' || !avatarDataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'avatarDataUrl must be a data:image/... URL' });
  }
  if (avatarDataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
    return res.status(400).json({ error: 'Image is too large — please use a smaller photo' });
  }

  try {
    const updateResult = await pool.query(
      `UPDATE users SET avatar_data_url = $1 WHERE id = $2
       RETURNING id, email, username, avatar_data_url AS "avatarDataUrl"`,
      [avatarDataUrl, req.user.id]
    );
    res.json({ user: updateResult.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Update avatar error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/account/avatar
router.delete('/avatar', requireAuth, async (req, res) => {
  try {
    const updateResult = await pool.query(
      `UPDATE users SET avatar_data_url = NULL WHERE id = $1
       RETURNING id, email, username, avatar_data_url AS "avatarDataUrl"`,
      [req.user.id]
    );
    res.json({ user: updateResult.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Remove avatar error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;