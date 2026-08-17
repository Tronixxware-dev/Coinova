const redis = require('../config/redis');
const { processTick } = require('./orderEngine');

// Symbols this app offers for trading. Kept in the same lowercase
// Binance-pair format as before ('btcusdt', etc.) so anything else in
// the app that imports SYMBOLS keeps working unchanged.
const SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt'];

// Maps each symbol to its CoinGecko coin id so we can pull a live USD
// price for it.
const COINGECKO_IDS = {
  btcusdt: 'bitcoin',
  ethusdt: 'ethereum',
  solusdt: 'solana',
  bnbusdt: 'binancecoin',
  xrpusdt: 'ripple',
};

// CoinGecko's free public API works fine from cloud-hosted servers
// (Render, Vercel, etc.) — unlike Binance, which blocks connections
// from most cloud/datacenter IP ranges. The fully anonymous version of
// this endpoint shares a fairly tight rate limit across everyone
// hitting it without a key, which is easy to trip — especially from a
// shared hosting IP range like Render's. A free CoinGecko Demo API key
// (no credit card needed) raises that to a guaranteed 30 calls/minute,
// which is very comfortable since we only make ~6-10 calls/minute
// (one combined request for all symbols per poll). The app still works
// without a key, just with a higher chance of an occasional 429 that
// self-heals on the next poll.
const POLL_INTERVAL_MS = 10000;

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=' +
  Object.values(COINGECKO_IDS).join(',') +
  '&vs_currencies=usd';

/**
 * Starts the price feed. `onPrice(symbol, price)` is called for every
 * symbol on every poll so the caller (index.js) can broadcast it to
 * connected frontend clients over its own WebSocket server.
 */
function startPriceFeed(onPrice) {
  console.log(
    'Starting CoinGecko price polling for:',
    SYMBOLS.join(', ').toUpperCase(),
    COINGECKO_API_KEY ? '(using API key)' : '(no API key — set COINGECKO_API_KEY to raise rate limits)'
  );
  poll(onPrice);
  setInterval(() => poll(onPrice), POLL_INTERVAL_MS);
}

// Chains polls onto a single promise so a slow/hanging fetch can't
// overlap with the next interval and pile up concurrent Postgres pool
// connections (max: 10 in config/db.js).
let queue = Promise.resolve();

function poll(onPrice) {
  queue = queue
    .then(() => fetchAndBroadcast(onPrice))
    .catch((err) => {
      console.error('Error fetching prices from CoinGecko:', err.message);
    });
}

async function fetchAndBroadcast(onPrice) {
  const headers = COINGECKO_API_KEY ? { 'x-cg-demo-api-key': COINGECKO_API_KEY } : {};
  const res = await fetch(COINGECKO_URL, { headers });
  if (!res.ok) {
    throw new Error(`CoinGecko responded with ${res.status}`);
  }
  const data = await res.json();

  for (const symbol of SYMBOLS) {
    const coingeckoId = COINGECKO_IDS[symbol];
    const usd = data[coingeckoId]?.usd;
    if (usd === undefined) continue;

    const binanceStyleSymbol = symbol.toUpperCase(); // e.g. 'BTCUSDT'
    const priceStr = String(usd);

    try {
      // Cache latest price for the order engine / REST reads.
      await redis.set(`price:${binanceStyleSymbol}`, priceStr);

      // Check pending limit/stop orders against this new price.
      await processTick(binanceStyleSymbol, priceStr);

      // Let the caller push this out to connected frontend clients.
      onPrice(binanceStyleSymbol, usd);
    } catch (err) {
      console.error(`Error processing price tick for ${binanceStyleSymbol}:`, err.message);
    }
  }
}

module.exports = { startPriceFeed, SYMBOLS };