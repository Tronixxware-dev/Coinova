// Quote assets we support, longest first so 'USDT' matches before
// a hypothetical shorter clash. Extend this list as you add markets.
const KNOWN_QUOTES = ['USDT', 'BUSD', 'USD'];

/**
 * Splits a trading pair symbol like 'BTCUSDT' into
 * { base: 'BTC', quote: 'USDT' }. Throws if the quote isn't recognized.
 */
function splitSymbol(symbol) {
  const upper = symbol.toUpperCase();
  const quote = KNOWN_QUOTES.find((q) => upper.endsWith(q));
  if (!quote) {
    throw new Error(`Unrecognized quote asset for symbol: ${symbol}`);
  }
  const base = upper.slice(0, upper.length - quote.length);
  return { base, quote };
}

module.exports = { splitSymbol, KNOWN_QUOTES };
