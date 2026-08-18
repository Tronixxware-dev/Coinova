const pool = require('../config/db');

const MIN_STAKE_AMOUNT = 50;

const AMOUNT_TIERS = [
  { min: 50, label: '$50 – $999.99' },
  { min: 1000, label: '$1,000 – $9,999.99' },
  { min: 10000, label: '$10,000+' },
];

const DURATION_PLANS = [
  { durationDays: 7, label: '7 Days', rates: [0.005, 0.0075, 0.01] },
  { durationDays: 30, label: '30 Days (1 Month)', rates: [0.01, 0.015, 0.02] },
  { durationDays: 90, label: '90 Days (3 Months)', rates: [0.015, 0.0225, 0.03] },
  { durationDays: 180, label: '180 Days (6 Months)', rates: [0.02, 0.03, 0.035] },
  { durationDays: 365, label: '365 Days (1 Year)', rates: [0.025, 0.035, 0.04] },
];

function tierIndexForAmount(amount) {
  let idx = -1;
  for (let i = 0; i < AMOUNT_TIERS.length; i++) {
    if (amount >= AMOUNT_TIERS[i].min) idx = i;
  }
  return idx;
}

function getDailyRate(durationDays, amount) {
  const plan = DURATION_PLANS.find((p) => p.durationDays === durationDays);
  if (!plan) return null;
  const tierIndex = tierIndexForAmount(amount);
  if (tierIndex === -1) return null;
  return plan.rates[tierIndex];
}

function listPlans() {
  return DURATION_PLANS.map((plan) => ({
    durationDays: plan.durationDays,
    label: plan.label,
    tiers: AMOUNT_TIERS.map((tier, i) => ({
      min: tier.min,
      label: tier.label,
      dailyRate: plan.rates[i],
    })),
  }));
}

function computeAccrued(stakeRow, now) {
  const principal = Number(stakeRow.principal);
  const dailyRate = Number(stakeRow.daily_rate);
  const stakedAt = new Date(stakeRow.staked_at).getTime();
  const maturesAt = new Date(stakeRow.matures_at).getTime();
  const elapsedMs = Math.max(now.getTime() - stakedAt, 0);
  const daysElapsed = Math.min(
    Math.floor(elapsedMs / (24 * 60 * 60 * 1000)),
    stakeRow.duration_days
  );
  const accrued = principal * dailyRate * daysElapsed;
  return { daysElapsed, accrued, matured: now.getTime() >= maturesAt };
}

async function getStakingSummary(userId) {
  const result = await pool.query(
    `SELECT * FROM stakes WHERE user_id = $1 AND status = 'ACTIVE' ORDER BY staked_at DESC`,
    [userId]
  );

  const now = new Date();
  let totalPrincipal = 0;
  let totalAccruedInterest = 0;

  const stakes = result.rows.map((row) => {
    const { daysElapsed, accrued, matured } = computeAccrued(row, now);
    totalPrincipal += Number(row.principal);
    totalAccruedInterest += accrued;
    return {
      id: row.id,
      principal: row.principal,
      durationDays: row.duration_days,
      dailyRate: Number(row.daily_rate),
      stakedAt: row.staked_at,
      maturesAt: row.matures_at,
      daysElapsed,
      accruedInterest: accrued,
      matured,
      totalIfWithdrawn: Number(row.principal) + accrued,
    };
  });

  return {
    totalPrincipal,
    totalAccruedInterest,
    minStakeAmount: MIN_STAKE_AMOUNT,
    plans: listPlans(),
    stakes,
  };
}

async function getStakingHistory(userId) {
  const result = await pool.query(
    `SELECT * FROM stake_withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [userId]
  );
  return {
    withdrawals: result.rows.map((row) => ({
      id: row.id,
      stakeId: row.stake_id,
      principal: row.principal,
      interest: row.interest,
      total: row.total,
      createdAt: row.created_at,
    })),
  };
}

async function stake(userId, { amount, durationDays }) {
  const numericAmount = Number(amount);
  const numericDuration = Number(durationDays);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    const err = new Error('amount must be a positive number');
    err.status = 400;
    throw err;
  }
  if (numericAmount < MIN_STAKE_AMOUNT) {
    const err = new Error(`Minimum stake amount is ${MIN_STAKE_AMOUNT} USDT`);
    err.status = 400;
    throw err;
  }

  const plan = DURATION_PLANS.find((p) => p.durationDays === numericDuration);
  if (!plan) {
    const err = new Error(
      `durationDays must be one of: ${DURATION_PLANS.map((p) => p.durationDays).join(', ')}`
    );
    err.status = 400;
    throw err;
  }

  const dailyRate = getDailyRate(numericDuration, numericAmount);
  const maturesAt = new Date(Date.now() + numericDuration * 24 * 60 * 60 * 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walletResult = await client.query(
      `SELECT balance FROM wallets WHERE user_id = $1 AND asset = 'USDT' FOR UPDATE`,
      [userId]
    );
    const wallet = walletResult.rows[0];
    if (!wallet || Number(wallet.balance) < numericAmount) {
      await client.query('ROLLBACK');
      const err = new Error('Insufficient USDT balance');
      err.status = 400;
      throw err;
    }

    await client.query(
      `UPDATE wallets SET balance = balance - $1 WHERE user_id = $2 AND asset = 'USDT'`,
      [numericAmount, userId]
    );

    const stakeResult = await client.query(
      `INSERT INTO stakes (user_id, principal, duration_days, daily_rate, matures_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, numericAmount, numericDuration, dailyRate, maturesAt]
    );

    await client.query('COMMIT');
    return stakeResult.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function withdrawStake(userId, stakeId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const stakeResult = await client.query(
      `SELECT * FROM stakes WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE' FOR UPDATE`,
      [stakeId, userId]
    );
    const row = stakeResult.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      const err = new Error('Stake not found');
      err.status = 404;
      throw err;
    }

    const now = new Date();
    const { accrued, matured } = computeAccrued(row, now);
    if (!matured) {
      await client.query('ROLLBACK');
      const err = new Error(`This stake is still locked until ${row.matures_at.toISOString()}`);
      err.status = 400;
      throw err;
    }

    const principal = Number(row.principal);
    const total = principal + accrued;

    await client.query(
      `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2 AND asset = 'USDT'`,
      [total, userId]
    );

    await client.query(
      `UPDATE stakes SET status = 'CLOSED', claimed_rewards = $1 WHERE id = $2`,
      [accrued, row.id]
    );

    await client.query(
      `INSERT INTO stake_withdrawals (user_id, stake_id, principal, interest, total)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, row.id, principal, accrued, total]
    );

    await client.query('COMMIT');
    return { principal, interest: accrued, total };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getStakingSummary,
  getStakingHistory,
  stake,
  withdrawStake,
  listPlans,
  DURATION_PLANS,
  AMOUNT_TIERS,
  MIN_STAKE_AMOUNT,
};