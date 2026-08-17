const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');

async function tableExists(client, name) {
  const res = await client.query(
    `SELECT EXISTS (
       SELECT FROM information_schema.tables WHERE table_name = $1
     )`,
    [name]
  );
  return res.rows[0].exists;
}

async function columnExists(client, table, column) {
  const res = await client.query(
    `SELECT EXISTS (
       SELECT FROM information_schema.columns WHERE table_name = $1 AND column_name = $2
     )`,
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
        console.log('Old staking schema detected — refunding any active stakes before migrating...');
        const active = await client.query(`SELECT * FROM stakes WHERE status = 'ACTIVE'`);
        for (const row of active.rows) {
          await client.query(
            `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2 AND asset = 'USDT'`,
            [row.principal, row.user_id]
          );
          console.log(`Refunded ${row.principal} USDT principal to user ${row.user_id} (stake #${row.id}).`);
        }

        await client.query('DROP TABLE IF EXISTS stake_withdrawals');
        await client.query('DROP TABLE IF EXISTS stakes');
      } else {
        console.log('Staking tables already on the new schema — nothing to migrate.');
      }
    }

    console.log('Applying schema.sql...');
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