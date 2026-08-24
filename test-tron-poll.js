require('dotenv').config();
const { pollTronDeposits } = require('./src/services/tronDepositPoller');

pollTronDeposits()
  .then(() => console.log('Poll complete — check the wallets/onchain_deposits tables.'))
  .catch((err) => console.error(err))
  .finally(() => process.exit());