require('dotenv').config();
const { getOrCreateDepositAddress } = require('./src/services/depositAddressService');

getOrCreateDepositAddress(1, 'BTC')
  .then((row) => console.log(row))
  .catch((err) => console.error(err))
  .finally(() => process.exit());