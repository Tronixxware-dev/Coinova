const path = require('path');

// Load .env.test BEFORE requiring anything that reads process.env, with
// override:true so it wins (mirrors tests/env.setup.js) — this points
// the pool at your TEST database, not dev.
require('dotenv').config({
  path: path.join(__dirname, '..', '.env.test'),
  quiet: true,
  override: true,
});

const fs = require('fs');
const pool = require('../src/config/db');

async function tableExists(client, name) {
  const res = await client.query(
    `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
    [name]
  );
  return res.rows[0].exists;
}

async function columnExists(client, table, column) {
  const res = await client.query(
    `SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_name = $1 AND column_name = $2)`,
    [table, column]
  );
  return res.rows[0].exists;
}

async function migrate() {
  const client = await pool.connect();
  try {
    const stakesExists = await tableExists(client, 'stakes');
    if (stakesExists) {
      const hasNewSchema = await columnExists(client, 'stakes', 'duration_days');
      if (!hasNewSchema) {
        console.log('Old staking schema detected in the TEST db — dropping (test data is disposable).');
        await client.query('DROP TABLE IF EXISTS stake_withdrawals');
        await client.query('DROP TABLE IF EXISTS stakes');
      } else {
        console.log('Test DB staking tables already on the new schema.');
      }
    }

    console.log('Applying schema.sql to the TEST database...');
    const schemaPath = path.join(__dirname, '..', 'src', 'models', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await client.query(sql);
    console.log('Done.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});