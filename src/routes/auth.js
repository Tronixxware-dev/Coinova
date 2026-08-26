const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const logger = require('../config/logger');
require('dotenv').config({ quiet: true });

const router = express.Router();

const SALT_ROUNDS = 12;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const PG_UNIQUE_VIOLATION = '23505';

const STARTING_BALANCES = {
  USDT: 0,
  BTC: 0,
  ETH: 0,
};

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: () => process.env.NODE_ENV === 'test',
});
router.use(authLimiter);

function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    { id: user.id, jti: crypto.randomUUID() },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_TTL }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : email;
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { username, password } = req.body;

  if (!email || !username || !password) {
    return res.status(400).json({ error: 'email, username, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Email or username already in use' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const userResult = await client.query(
      `INSERT INTO users (email, username, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, username, created_at`,
      [email, username, passwordHash]
    );
    const user = userResult.rows[0];

    for (const [asset, balance] of Object.entries(STARTING_BALANCES)) {
      await client.query(
        `INSERT INTO wallets (user_id, asset, balance)
         VALUES ($1, $2, $3)`,
        [user.id, asset, balance]
      );
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    await client.query(
      'INSERT INTO refresh_tokens (user_id, token) VALUES ($1, $2)',
      [user.id, hashToken(refreshToken)]
    );

    await client.query('COMMIT');

    res.status(201).json({
      user: { id: user.id, email: user.email, username: user.username },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'Email or username already in use' });
    }
    logger.error({ err }, 'Signup error');
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, username, password_hash, avatar_data_url AS "avatarDataUrl" FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token) VALUES ($1, $2)',
      [user.id, hashToken(refreshToken)]
    );

    res.json({
      user: { id: user.id, email: user.email, username: user.username, avatarDataUrl: user.avatarDataUrl },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    logger.error({ err }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  try {
    const stored = await pool.query(
      'SELECT * FROM refresh_tokens WHERE token = $1 AND revoked = FALSE',
      [hashToken(refreshToken)]
    );
    if (stored.rows.length === 0) {
      return res.status(403).json({ error: 'Refresh token invalid or revoked' });
    }

    jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, async (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: 'Refresh token expired or invalid' });
      }

      const userResult = await pool.query(
        'SELECT id, email, username FROM users WHERE id = $1',
        [decoded.id]
      );
      const user = userResult.rows[0];
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const accessToken = signAccessToken(user);
      res.json({ accessToken });
    });
  } catch (err) {
    logger.error({ err }, 'Refresh error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  try {
    await pool.query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE token = $1',
      [hashToken(refreshToken)]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Logout error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body.email);

  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }

  try {
    const result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    // Always return the same generic response whether or not the
    // email is registered, so this endpoint can't be used to check
    // which emails have accounts (same reasoning as login's 401s).
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

      await pool.query(
        'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, hashToken(rawToken), expiresAt]
      );

      const resetLink = `${FRONTEND_URL}/reset-password?token=${rawToken}`;
      // No real email provider is wired up for this simulated app —
      // the reset link is logged here instead. Swap this for an
      // actual email send (SendGrid, SES, etc.) before this ever
      // touches real users.
      logger.info(`Password reset requested for ${email} — reset link: ${resetLink}`);
    }

    res.json({ success: true, message: 'If that email is registered, a password reset link has been sent.' });
  } catch (err) {
    logger.error({ err }, 'Forgot password error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'token and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT * FROM password_resets
       WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()
       FOR UPDATE`,
      [hashToken(token)]
    );
    const reset = result.rows[0];
    if (!reset) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This reset link is invalid or has expired' });
    }

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, reset.user_id]);
    await client.query('UPDATE password_resets SET used = TRUE WHERE id = $1', [reset.id]);
    // Same as a manual password change — invalidate every existing
    // session, since a reset means the old credential is no longer
    // trusted.
    await client.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [reset.user_id]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Reset password error');
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;