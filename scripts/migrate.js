const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');

async function migrate() {
  const schemaPath = path.join(__dirname, '..', 'src', 'models', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  await pool.query(sql);
  console.log('Schema applied successfully.');

  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});