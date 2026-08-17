const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { placeOrder, cancelOrder } = require('../services/orderEngine');

const router = express.Router();

// POST /api/orders — place a MARKET, LIMIT, or STOP_LOSS order
router.post('/', requireAuth, async (req, res) => {
  const { symbol, side, type, quantity, price, stopPrice } = req.body;

  if (!symbol || !side || !type || !quantity) {
    return res.status(400).json({ error: 'symbol, side, type, and quantity are required' });
  }

  try {
    const order = await placeOrder(req.user.id, { symbol, side, type, quantity, price, stopPrice });
    res.status(201).json({ order });
  } catch (err) {
    // These are expected user errors (bad symbol, insufficient funds, etc.)
    res.status(400).json({ error: err.message });
  }
});

// GET /api/orders — order history for the logged-in user
// Optional query params: ?status=PENDING|FILLED|CANCELLED&symbol=BTCUSDT
router.get('/', requireAuth, async (req, res) => {
  const { status, symbol } = req.query;
  const conditions = ['user_id = $1'];
  const params = [req.user.id];

  if (status) {
    params.push(status.toUpperCase());
    conditions.push(`status = $${params.length}`);
  }
  if (symbol) {
    params.push(symbol.toUpperCase());
    conditions.push(`symbol = $${params.length}`);
  }

  try {
    const result = await pool.query(
      `SELECT * FROM orders WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
      params
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error('Order history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/orders/:id — cancel a pending order
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await cancelOrder(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
