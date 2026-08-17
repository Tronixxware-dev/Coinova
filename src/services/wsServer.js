const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
require('dotenv').config({ quiet: true });
const logger = require('../config/logger');

/**
 * Sets up a WebSocket server (attached to the existing HTTP server)
 * that broadcasts price ticks to every connected client. Clients
 * connect with ?token=<accessToken> so we know who's on the socket,
 * though price data itself isn't user-specific.
 */
function createWsServer(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws/prices' });
  const clients = new Set();

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    try {
      jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    } catch (err) {
      socket.close(4001, 'Unauthorized');
      return;
    }

    clients.add(socket);
    logger.info(`Client connected to price feed (${clients.size} total)`);

    socket.on('close', () => {
      clients.delete(socket);
    });

    socket.on('error', () => {
      clients.delete(socket);
    });
  });

  function broadcastPrice(symbol, price) {
    const payload = JSON.stringify({ type: 'price', symbol, price, timestamp: Date.now() });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // Cleanly closes every open client socket and the server itself —
  // used during graceful shutdown so clients get a proper close frame
  // instead of the connection just dying.
  function closeAll() {
    for (const client of clients) {
      client.close(1001, 'Server shutting down');
    }
    wss.close();
  }

  return { broadcastPrice, closeAll };
}

module.exports = { createWsServer };