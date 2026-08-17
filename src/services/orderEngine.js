const Decimal = require('decimal.js');
const pool = require('../config/db');
const redis = require('../config/redis');
const { splitSymbol } = require('./symbols');

/**
 * Reads the latest cached price for a symbol from Redis.
 * The price feed service is responsible for keeping this fresh.
 * Returned as a string (not a float) so callers can hand it straight
 * to Decimal without an extra binary-float round trip.
 */
async function getLatestPrice(symbol) {
  const price = await redis.get(`price:${symbol.toUpperCase()}`);
  return price || null;
}

/**
 * Parses user-supplied input into a Decimal, throwing our own
 * (route-safe) error instead of letting decimal.js's error escape.
 */
function toDecimal(value, label) {
  try {
    const d = new Decimal(value);
    if (!d.isFinite()) throw new Error('not finite');
    return d;
  } catch {
    throw new Error(`${label} must be a valid number`);
  }
}

/**
 * Ensures a wallet row exists for a user/asset pair (lazily creates
 * one at zero balance the first time a user touches a new asset).
 */
async function ensureWallet(client, userId, asset) {
  await client.query(
    `INSERT INTO wallets (user_id, asset, balance)
     VALUES ($1, $2, 0)
     ON CONFLICT (user_id, asset) DO NOTHING`,
    [userId, asset]
  );
}

/**
 * Locks funds for a new order (moves from `balance` to `locked_balance`).
 * Throws if the user doesn't have enough free balance.
 */
async function lockFunds(client, userId, asset, amount) {
  const amountStr = Decimal.isDecimal(amount) ? amount.toFixed() : amount;
  const result = await client.query(
    `UPDATE wallets
     SET balance = balance - $3, locked_balance = locked_balance + $3
     WHERE user_id = $1 AND asset = $2 AND balance >= $3
     RETURNING balance, locked_balance`,
    [userId, asset, amountStr]
  );
  if (result.rows.length === 0) {
    throw new Error(`Insufficient ${asset} balance`);
  }
}

/**
 * Releases previously locked funds without spending them (used on cancel).
 */
async function unlockFunds(client, userId, asset, amount) {
  const amountStr = Decimal.isDecimal(amount) ? amount.toFixed() : amount;
  await client.query(
    `UPDATE wallets
     SET balance = balance + $3, locked_balance = locked_balance - $3
     WHERE user_id = $1 AND asset = $2`,
    [userId, asset, amountStr]
  );
}

/**
 * Settles a fill: consumes locked funds on the spent side, credits
 * the received side, and records the trade. Must run inside a
 * transaction the caller owns (client is already BEGIN'd).
 */
async function settleFill(client, order, fillPrice) {
  const { base, quote } = splitSymbol(order.symbol);
  // order.quantity / order.locked_amount / fillPrice all arrive as
  // strings (either straight from a NUMERIC column via `pg`, or from
  // a caller-side Decimal's .toFixed()) — Decimal parses those exactly,
  // unlike parseFloat which rounds to a binary float first. That
  // matters here because this same rounding error would otherwise
  // compound across every trade a user makes.
  const quantity = new Decimal(order.quantity);
  const price = new Decimal(fillPrice);
  const quoteAmount = quantity.times(price);

  if (order.side === 'BUY') {
    // Spend locked quote (e.g. USDT), receive base (e.g. BTC).
    // The amount originally locked was an estimate (limit/stop price
    // or price-at-placement for market orders) — release any
    // difference between what was locked and what was actually spent.
    const originalLock = new Decimal(order.locked_amount);
    const refund = originalLock.minus(quoteAmount);

    await client.query(
      `UPDATE wallets
       SET locked_balance = locked_balance - $3
       WHERE user_id = $1 AND asset = $2`,
      [order.user_id, quote, originalLock.toFixed()]
    );
    if (refund.greaterThan(0)) {
      await client.query(
        `UPDATE wallets SET balance = balance + $3
         WHERE user_id = $1 AND asset = $2`,
        [order.user_id, quote, refund.toFixed()]
      );
    }
    await ensureWallet(client, order.user_id, base);
    await client.query(
      `UPDATE wallets SET balance = balance + $3
       WHERE user_id = $1 AND asset = $2`,
      [order.user_id, base, quantity.toFixed()]
    );
  } else {
    // SELL: spend locked base (e.g. BTC), receive quote (e.g. USDT).
    await client.query(
      `UPDATE wallets
       SET locked_balance = locked_balance - $3
       WHERE user_id = $1 AND asset = $2`,
      [order.user_id, base, quantity.toFixed()]
    );
    await ensureWallet(client, order.user_id, quote);
    await client.query(
      `UPDATE wallets SET balance = balance + $3
       WHERE user_id = $1 AND asset = $2`,
      [order.user_id, quote, quoteAmount.toFixed()]
    );
  }

  await client.query(
    `UPDATE orders
     SET status = 'FILLED', filled_at = NOW(), filled_price = $2
     WHERE id = $1`,
    [order.id, price.toFixed()]
  );

  await client.query(
    `INSERT INTO trades (order_id, user_id, symbol, side, quantity, price)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [order.id, order.user_id, order.symbol, order.side, quantity.toFixed(), price.toFixed()]
  );
}

/**
 * Places a new order. Market orders fill immediately against the
 * latest cached price. Limit/stop orders lock funds and sit as
 * PENDING until a price tick satisfies their trigger condition.
 */
async function placeOrder(userId, { symbol, side, type, quantity, price, stopPrice }) {
  symbol = symbol.toUpperCase();
  side = side.toUpperCase();
  type = type.toUpperCase();
  const qty = toDecimal(quantity, 'quantity');

  if (!['BUY', 'SELL'].includes(side)) throw new Error('side must be BUY or SELL');
  if (!['MARKET', 'LIMIT', 'STOP_LOSS'].includes(type)) throw new Error('invalid order type');
  if (!qty.isPositive() || qty.isZero()) throw new Error('quantity must be positive');

  const { base, quote } = splitSymbol(symbol);
  const latestPrice = await getLatestPrice(symbol);
  if (!latestPrice) throw new Error(`No live price available yet for ${symbol}`);
  const latestPriceDec = new Decimal(latestPrice);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureWallet(client, userId, base);
    await ensureWallet(client, userId, quote);

    if (type === 'MARKET') {
      // Lock exactly what's needed, then settle immediately.
      const lockAsset = side === 'BUY' ? quote : base;
      const lockAmount = side === 'BUY' ? qty.times(latestPriceDec) : qty;
      await lockFunds(client, userId, lockAsset, lockAmount);

      const orderResult = await client.query(
        `INSERT INTO orders (user_id, symbol, side, type, quantity, status)
         VALUES ($1, $2, $3, $4, $5, 'PENDING')
         RETURNING *`,
        [userId, symbol, side, type, qty.toFixed()]
      );
      const order = { ...orderResult.rows[0], locked_amount: lockAmount.toFixed() };
      await settleFill(client, order, latestPriceDec.toFixed());

      await client.query('COMMIT');
      return { ...order, status: 'FILLED', filled_price: latestPriceDec.toFixed() };
    }

    // LIMIT or STOP_LOSS: lock funds against the specified trigger
    // price and leave the order pending for the price feed to check.
    const triggerPrice = toDecimal(
      type === 'LIMIT' ? price : stopPrice,
      type === 'LIMIT' ? 'price' : 'stopPrice'
    );
    if (!triggerPrice.isPositive() || triggerPrice.isZero()) {
      throw new Error(`${type} orders require a valid ${type === 'LIMIT' ? 'price' : 'stopPrice'}`);
    }

    const lockAsset = side === 'BUY' ? quote : base;
    const lockAmount = side === 'BUY' ? qty.times(triggerPrice) : qty;
    await lockFunds(client, userId, lockAsset, lockAmount);

    const orderResult = await client.query(
      `INSERT INTO orders (user_id, symbol, side, type, quantity, price, stop_price, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
       RETURNING *`,
      [
        userId,
        symbol,
        side,
        type,
        qty.toFixed(),
        type === 'LIMIT' ? triggerPrice.toFixed() : null,
        type === 'STOP_LOSS' ? triggerPrice.toFixed() : null,
      ]
    );

    await client.query('COMMIT');
    return orderResult.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancels a pending order owned by the user and releases locked funds.
 */
async function cancelOrder(userId, orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [orderId, userId]
    );
    const order = result.rows[0];
    if (!order) throw new Error('Order not found');
    if (order.status !== 'PENDING') throw new Error('Only pending orders can be cancelled');

    const { base, quote } = splitSymbol(order.symbol);
    const triggerPrice = new Decimal(order.type === 'LIMIT' ? order.price : order.stop_price);
    const quantity = new Decimal(order.quantity);
    const lockAsset = order.side === 'BUY' ? quote : base;
    const lockAmount = order.side === 'BUY' ? quantity.times(triggerPrice) : quantity;

    await unlockFunds(client, userId, lockAsset, lockAmount);
    await client.query(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [orderId]);

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Called by the price feed service on every tick. Checks all pending
 * LIMIT and STOP_LOSS orders for the symbol and fills any whose
 * trigger condition is satisfied by the new price.
 */
async function processTick(symbol, price) {
  const client = await pool.connect();
  try {
    const pending = await client.query(
      `SELECT * FROM orders
       WHERE symbol = $1 AND status = 'PENDING' AND type IN ('LIMIT', 'STOP_LOSS')`,
      [symbol]
    );

    const priceDec = new Decimal(price);

    for (const order of pending.rows) {
      const orderPrice = order.price !== null ? new Decimal(order.price) : null;
      const stopPrice = order.stop_price !== null ? new Decimal(order.stop_price) : null;

      const triggers =
        order.type === 'LIMIT'
          ? order.side === 'BUY'
            ? priceDec.lessThanOrEqualTo(orderPrice)
            : priceDec.greaterThanOrEqualTo(orderPrice)
          : order.side === 'SELL'
          ? priceDec.lessThanOrEqualTo(stopPrice)
          : priceDec.greaterThanOrEqualTo(stopPrice);

      if (!triggers) continue;

      const triggerPrice = order.type === 'LIMIT' ? orderPrice : stopPrice;
      const quantity = new Decimal(order.quantity);
      const lockAmount = order.side === 'BUY' ? quantity.times(triggerPrice) : quantity;

      const fillClient = await pool.connect();
      try {
        await fillClient.query('BEGIN');
        // Re-check status under lock in case it was cancelled concurrently.
        const check = await fillClient.query(
          `SELECT status FROM orders WHERE id = $1 FOR UPDATE`,
          [order.id]
        );
        if (check.rows[0]?.status !== 'PENDING') {
          await fillClient.query('ROLLBACK');
          continue;
        }
        // Fill limit orders at their limit price; stop-loss orders
        // execute as a market fill at the current tick price once triggered.
        const fillPrice = order.type === 'LIMIT' ? triggerPrice : priceDec;
        await settleFill(fillClient, { ...order, locked_amount: lockAmount.toFixed() }, fillPrice.toFixed());
        await fillClient.query('COMMIT');
      } catch (err) {
        await fillClient.query('ROLLBACK');
        console.error(`Failed to fill order ${order.id}:`, err);
      } finally {
        fillClient.release();
      }
    }
  } finally {
    client.release();
  }
}

module.exports = { placeOrder, cancelOrder, processTick, getLatestPrice };