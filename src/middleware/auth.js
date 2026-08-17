const jwt = require('jsonwebtoken');
require('dotenv').config({ quiet: true });

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

module.exports = { requireAuth };
