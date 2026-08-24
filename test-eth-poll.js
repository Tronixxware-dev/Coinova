require('dotenv').config();
const { pollEthDeposits } = require('./src/services/ethDepositPoller');

pollEthDeposits()
  .then(() => console.log('Poll complete — check the wallets/onchain_deposits tables.'))
  .catch((err) => console.error(err))
  .finally(() => process.exit());