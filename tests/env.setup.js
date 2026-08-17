const path = require('path');

// Runs before the test framework (and therefore before any test file's
// `require('../src/...')`) — loads .env.test's values into process.env
// first, so that when src/config/db.js etc. later call their own
// `dotenv.config()` (which loads .env and does NOT override already-set
// vars), the test database/Redis/secrets win instead of dev's.
require('dotenv').config({
  path: path.join(__dirname, '..', '.env.test'),
  quiet: true,
  override: true,
});