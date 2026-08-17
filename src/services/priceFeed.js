const WebSocket = require('ws');
const redis = require('../config/redis');
const { processTick } = require('./orderEngine');

// Symbols this app offers for trading. Extend as needed — each one
// needs to be a valid Binance trading pair (lowercase for the stream URL).
const SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt'];

const BINANCE_STREAM_URL =
  'wss://stream.binance.com:9443/stream?streams=' +
  SYMBOLS.map((s) => `${s}@trade`).join('/');

const RECONNECT_DELAY_MS = 3000;

/**
 * Starts the price feed. `onPrice(symbol, price)` is called on every
 * tick so the caller (index.js) can broadcast it to connected frontend
 * clients over its own WebSocket server.
 */
function startPriceFeed(onPrice) {
  connect(onPrice);
}

async function handleTick(raw, onPrice) {
  const parsed = JSON.parse(raw.toString());
  const trade = parsed.data;
  if (!trade || trade.e !== 'trade') return;

  const symbol = trade.s; // e.g. 'BTCUSDT'
  // Keep Binance's raw decimal string all the way through the money
  // math (Redis cache + order engine) — parseFloat'ing it here would
  // round it to a binary float before it ever reaches Decimal, which
  // defeats the point of doing exact decimal arithmetic downstream.
  const priceStr = trade.p;

  // Cache latest price for the order engine / REST reads.
  await redis.set(`price:${symbol}`, priceStr);

  // Check pending limit/stop orders against this new price.
  await processTick(symbol, priceStr);

  // Let the caller push this out to connected frontend clients —
  // a plain number is fine here since this leg is display-only.
  onPrice(symbol, parseFloat(priceStr));
}

function connect(onPrice) {
  const ws = new WebSocket(BINANCE_STREAM_URL);

  ws.on('open', () => {
    console.log('Connected to Binance price stream:', SYMBOLS.join(', ').toUpperCase());
  });

  // Binance can fire many trade ticks per second across these symbols.
  // `ws`'s 'message' event doesn't wait for an async handler to finish
  // before firing the next one, so without this chain, a burst of ticks
  // would kick off that many concurrent processTick() calls, each
  // grabbing its own Postgres pool connection — easily exhausting the
  // pool (max: 10 in config/db.js) and timing out. Chaining onto
  // `queue` forces ticks to be handled one at a time instead, so at
  // most one pool connection is ever in use for this work.
  let queue = Promise.resolve();

  ws.on('message', (raw) => {
    queue = queue
      .then(() => handleTick(raw, onPrice))
      .catch((err) => console.error('Error processing price tick:', err));
  });

  ws.on('close', () => {
    console.warn(`Price feed disconnected — reconnecting in ${RECONNECT_DELAY_MS}ms`);
    setTimeout(() => connect(onPrice), RECONNECT_DELAY_MS);
  });

  ws.on('error', (err) => {
    console.error('Price feed WebSocket error:', err.message);
    ws.close();
  });
}

module.exports = { startPriceFeed, SYMBOLS };