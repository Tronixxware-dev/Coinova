const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// GET /api/trades — the logged-in user's completed trade history.
// Optional query params: ?symbol=BTCUSDT&limit=50
router.get('/', requireAuth, async (req, res) => {
  const { symbol } = req.query;
  const conditions = ['user_id = $1'];
  const params = [req.user.id];

  if (symbol) {
    params.push(symbol.toUpperCase());
    conditions.push(`symbol = $${params.length}`);
  }

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);
  params.push(limit);

  try {
    const result = await pool.query(
      `SELECT id, order_id, symbol, side, quantity, price, executed_at
       FROM trades
       WHERE ${conditions.join(' AND ')}
       ORDER BY executed_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ trades: result.rows });
  } catch (err) {
    console.error('Trade history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;