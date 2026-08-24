require('dotenv').config();
const { deriveTronWallet } = require('./src/services/tronWallet');
console.log(deriveTronWallet(9999).address);