require('dotenv').config();
const { pollBtcDeposits } = require('./src/services/btcDepositPoller');

pollBtcDeposits()
  .then(() => console.log('Poll complete — check the wallets/onchain_deposits tables.'))
  .catch((err) => console.error(err))
  .finally(() => process.exit());