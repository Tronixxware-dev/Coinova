const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getOrCreateDepositAddress } = require('../services/depositAddressService');
const { withdrawTronUsdt } = require('../services/tronWithdrawalService');
const { withdrawEth } = require('../services/ethWithdrawalService');
const { withdrawBtc } = require('../services/btcWithdrawalService');

const SUPPORTED_CHAINS = ['ETH', 'TRON', 'BTC'];

router.get('/:chain/address', requireAuth, async (req, res, next) => {
  try {
    const chain = req.params.chain.toUpperCase();
    if (!SUPPORTED_CHAINS.includes(chain)) {
      return res.status(400).json({ error: `Unsupported chain: ${chain}` });
    }
    const row = await getOrCreateDepositAddress(req.user.id, chain);
    res.json({ chain: row.chain, address: row.address });
  } catch (err) {
    next(err);
  }
});

router.post('/:chain/withdraw', requireAuth, async (req, res, next) => {
  try {
    const chain = req.params.chain.toUpperCase();
    const { toAddress, amount } = req.body;

    let result;
    if (chain === 'TRON') {
      result = await withdrawTronUsdt(req.user.id, toAddress, amount);
    } else if (chain === 'ETH') {
      result = await withdrawEth(req.user.id, toAddress, amount);
    } else if (chain === 'BTC') {
      result = await withdrawBtc(req.user.id, toAddress, amount);
    } else {
      return res.status(400).json({ error: `Withdrawals not yet supported for chain: ${chain}` });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;