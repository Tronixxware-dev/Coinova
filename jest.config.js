module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/env.setup.js'],
  // Test files share one Postgres test database and truncate tables
  // between tests — running files in parallel workers would let them
  // stomp on each other's data. Force everything serial.
  maxWorkers: 1,
  testTimeout: 15000,
};