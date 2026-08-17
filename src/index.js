const logger = require('./config/logger');
const { validateEnv } = require('./config/env');

// Runs before any other require — so a missing DATABASE_URL/JWT secret
// fails fast with a clear message instead of surfacing later as an
// obscure Postgres or "secretOrPrivateKey must have a value" error.
validateEnv();

const http = require('http');
const app = require('./app');
const { startPriceFeed } = require('./services/priceFeed');
const { createWsServer } = require('./services/wsServer');
const pool = require('./config/db');
const redis = require('./config/redis');

const httpServer = http.createServer(app);
const { broadcastPrice, closeAll: closeWsServer } = createWsServer(httpServer);

// Kick off the live price feed once the server is listening — every
// tick both updates pending orders (via orderEngine) and gets
// pushed out to connected frontend clients.
startPriceFeed((symbol, price) => {
  broadcastPrice(symbol, price);
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
  logger.info(`Price WebSocket available at ws://localhost:${PORT}/ws/prices`);
});

// Graceful shutdown — stop accepting new connections, close the price
// WebSocket server, the DB pool, and Redis, then exit cleanly. Without
// this, SIGINT/SIGTERM (Ctrl+C, a container stop, a process manager
// restart) just kills the process mid-request/mid-transaction instead
// of winding down.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully...`);

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit.');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  try {
    closeWsServer();
    await new Promise((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    await pool.end();
    redis.disconnect();
    logger.info('Shutdown complete.');
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));