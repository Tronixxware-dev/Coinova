require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./src/config/db');

const fileArg = process.argv[2];
if (!fileArg) {
  console.error('Usage: node run-sql.js <path-to-sql-file>');
  process.exit(1);
}

const sql = fs.readFileSync(path.resolve(fileArg), 'utf8');

pool.query(sql)
  .then(() => console.log('Migration applied successfully:', fileArg))
  .catch((err) => console.error('Migration failed:', err))
  .finally(() => process.exit());