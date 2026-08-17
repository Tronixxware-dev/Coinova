const express = require('express');
const { requireAuth } = require('../middleware/auth');
const stakingService = require('../services/stakingService');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const summary = await stakingService.getStakingSummary(req.user.id);
    res.json(summary);
  } catch (err) {
    console.error('Get staking summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/stake', requireAuth, async (req, res) => {
  try {
    const result = await stakingService.stake(req.user.id, req.body);
    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Stake error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/withdraw', requireAuth, async (req, res) => {
  try {
    const result = await stakingService.withdrawStake(req.user.id, req.body.stakeId);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Withdraw stake error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;