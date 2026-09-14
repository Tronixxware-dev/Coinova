const jwt = require('jsonwebtoken');
require('dotenv').config({ quiet: true });
const pool = require('../config/db');

/**
 * Verifies the Authorization: Bearer <token> header and attaches
 * the decoded user payload to req.user. Rejects with 401 if
 * missing/invalid, 403 if expired/malformed.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(token, process.env.JWT_ACCESS_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = decoded; // { id, username, email }
    next();
  });
}

/**
 * Must run after requireAuth. Looks up admin status fresh from the
 * database on every request rather than trusting a flag baked into
 * the JWT, so revoking admin access takes effect immediately instead
 * of waiting for the token to expire.
 */
async function requireAdmin(req, res, next) {
  try {
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user || !user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { requireAuth, requireAdmin };