const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { splitSymbol } = require('../services/symbols');
const { getLatestPrice } = require('../services/orderEngine');

const router = express.Router();

const MAX_DEPTH = 50;

// GET /api/orderbook/:symbol — aggregated resting LIMIT order depth,
// across all users. STOP_LOSS orders are intentionally excluded: on a
// real exchange they aren't visible resting liquidity, they only become
// market orders once triggered, so showing them here would misrepresent
// the book. This engine has no partial fills either (orders are always
// filled in full at once), so quantity here is always the order's
// original, un-touched size.
router.get('/:symbol', requireAuth, async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  try {
    splitSymbol(symbol); // throws for an unrecognized quote asset
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const [bidsResult, asksResult, lastPrice] = await Promise.all([
      pool.query(
        `SELECT price, SUM(quantity) AS quantity
         FROM orders
         WHERE symbol = $1 AND status = 'PENDING' AND type = 'LIMIT' AND side = 'BUY'
         GROUP BY price
         ORDER BY price DESC
         LIMIT $2`,
        [symbol, MAX_DEPTH]
      ),
      pool.query(
        `SELECT price, SUM(quantity) AS quantity
         FROM orders
         WHERE symbol = $1 AND status = 'PENDING' AND type = 'LIMIT' AND side = 'SELL'
         GROUP BY price
         ORDER BY price ASC
         LIMIT $2`,
        [symbol, MAX_DEPTH]
      ),
      getLatestPrice(symbol),
    ]);

    res.json({
      symbol,
      lastPrice,
      bids: bidsResult.rows,
      asks: asksResult.rows,
    });
  } catch (err) {
    console.error('Order book error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;