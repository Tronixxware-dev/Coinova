const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
require('dotenv').config({ quiet: true });

const logger = require('./config/logger');
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const orderRoutes = require('./routes/orders');
const tradeRoutes = require('./routes/trades');
const orderbookRoutes = require('./routes/orderbook');
const stakingRoutes = require('./routes/staking');
const accountRoutes = require('./routes/account');

const app = express();

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(cors());
app.use(express.json());

app.use(
  pinoHttp({
    logger,
    autoLogging: process.env.NODE_ENV !== 'test',
    customLogLevel: (req, res) => {
      if (req.url === '/api/health') return 'debug';
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  })
);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: (req) => req.path === '/health' || process.env.NODE_ENV === 'test',
});
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/orderbook', orderbookRoutes);
app.use('/api/staking', stakingRoutes);
app.use('/api/account', accountRoutes);

app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;