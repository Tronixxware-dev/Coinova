const Redis = require('ioredis');
require('dotenv').config({ quiet: true });

// Used for: latest price cache, and sorted sets of pending
// limit/stop orders keyed by trigger price for fast lookups.
//
// REDIS_KEY_PREFIX lets the test suite share the same Upstash database
// as dev (free tier only allows one) while staying completely isolated —
// every key this client touches gets prefixed transparently, so tests
// never read or wipe the live price cache dev/prod actually use.
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  keyPrefix: process.env.REDIS_KEY_PREFIX || '',
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

module.exports = redis;