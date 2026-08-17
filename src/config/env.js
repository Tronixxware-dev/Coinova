require('dotenv').config({ quiet: true });

const REQUIRED_VARS = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];

// If src/config/redis.js reads its own env var (e.g. REDIS_URL), add
// its name to REQUIRED_VARS above too, so a missing Redis config fails
// fast here instead of surfacing later as a confusing connection error.

function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(
      `Missing required environment variable(s): ${missing.join(', ')}\n` +
        `Check your .env file — the server can't start without these.`
    );
    process.exit(1);
  }
}

module.exports = { validateEnv, REQUIRED_VARS };