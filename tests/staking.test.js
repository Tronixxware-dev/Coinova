const request = require('supertest');
const app = require('../src/app');
const { resetDb, closeAll, pool } = require('./helpers/db');

async function signupAndGetToken(email = 'staker@example.com', username = 'staker') {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ email, username, password: 'password123' });
  return res.body.accessToken;
}

// Shifts a stake's whole timeline (staked_at AND matures_at) back by
// `days`, so we can simulate "N days into a stake" without waiting
// real time. Both fields move together since maturity is a fixed
// offset from stake time.
async function backdateStake(stakeId, days) {
  await pool.query(
    `UPDATE stakes
     SET staked_at = staked_at - ($2 || ' days')::interval,
         matures_at = matures_at - ($2 || ' days')::interval
     WHERE id = $1`,
    [stakeId, days]
  );
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeAll();
});

describe('GET /api/staking', () => {
  test('requires auth', async () => {
    const res = await request(app).get('/api/staking');
    expect(res.status).toBe(401);
  });

  test('returns zeroed totals and the plan/tier table for a fresh user', async () => {
    const token = await signupAndGetToken();
    const res = await request(app).get('/api/staking').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalPrincipal).toBe(0);
    expect(res.body.totalAccruedInterest).toBe(0);
    expect(res.body.stakes).toEqual([]);
    expect(res.body.minStakeAmount).toBe(50);

    const durations = res.body.plans.map((p) => p.durationDays);
    expect(durations).toEqual([7, 30, 90, 180, 365]);
    res.body.plans.forEach((p) => expect(p.tiers).toHaveLength(3));
  });
});

describe('POST /api/staking/stake', () => {
  test('requires auth', async () => {
    const res = await request(app).post('/api/staking/stake').send({ amount: 100, durationDays: 7 });
    expect(res.status).toBe(401);
  });

  test('rejects a zero or negative amount', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: -50, durationDays: 7 });

    expect(res.status).toBe(400);
  });

  test('rejects an amount below the $50 minimum', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 25, durationDays: 7 });

    expect(res.status).toBe(400);
  });

  test('rejects a duration that is not one of the offered plans', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 100, durationDays: 14 });

    expect(res.status).toBe(400);
  });

  test('rejects an amount greater than the available USDT balance', async () => {
    const token = await signupAndGetToken();
    // Starting balance is 10000 USDT.
    const res = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 20000, durationDays: 7 });

    expect(res.status).toBe(400);
  });

  test('deducts the staked amount from the wallet and creates an ACTIVE stake', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 100, durationDays: 7 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.duration_days).toBe(7);

    const walletRes = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
    const usdt = walletRes.body.wallets.find((w) => w.asset === 'USDT');
    expect(usdt.balance).toBe('9900.0000000000');
  });

  test('picks the correct daily rate tier based on amount, for the same duration', async () => {
    // Separate users, each starting fresh with the full 10000 USDT —
    // otherwise sequential stakes on one wallet would deplete the
    // balance and the larger amounts would get rejected.
    const smallToken = await signupAndGetToken('small@example.com', 'smallstaker');
    const small = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${smallToken}`)
      .send({ amount: 100, durationDays: 365 });
    expect(Number(small.body.daily_rate)).toBeCloseTo(0.025);

    const midToken = await signupAndGetToken('mid@example.com', 'midstaker');
    const mid = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${midToken}`)
      .send({ amount: 2000, durationDays: 365 });
    expect(Number(mid.body.daily_rate)).toBeCloseTo(0.035);

    const largeToken = await signupAndGetToken('large@example.com', 'largestaker');
    const large = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${largeToken}`)
      .send({ amount: 10000, durationDays: 365 });
    expect(Number(large.body.daily_rate)).toBeCloseTo(0.04);
  });
});

describe('interest accrual', () => {
  test('shows zero accrued interest immediately after staking', async () => {
    const token = await signupAndGetToken();
    await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 1000, durationDays: 30 });

    const res = await request(app).get('/api/staking').set('Authorization', `Bearer ${token}`);
    expect(res.body.stakes[0].daysElapsed).toBe(0);
    expect(res.body.stakes[0].accruedInterest).toBe(0);
    expect(res.body.stakes[0].matured).toBe(false);
  });

  test('accrues principal * dailyRate * daysElapsed while still within the term', async () => {
    const token = await signupAndGetToken();
    const stakeRes = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 1000, durationDays: 30 }); // 1.5%/day tier for $1,000-$9,999.99

    await backdateStake(stakeRes.body.id, 10);

    const res = await request(app).get('/api/staking').set('Authorization', `Bearer ${token}`);
    const stake = res.body.stakes[0];

    expect(stake.daysElapsed).toBe(10);
    expect(stake.matured).toBe(false);
    // 1000 * 0.015 * 10 = 150
    expect(stake.accruedInterest).toBeCloseTo(150);
  });

  test('caps accrued interest and days elapsed at the stake duration once matured', async () => {
    const token = await signupAndGetToken();
    const stakeRes = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 1000, durationDays: 7 }); // 0.75%/day tier

    // Backdate well past the 7-day term.
    await backdateStake(stakeRes.body.id, 20);

    const res = await request(app).get('/api/staking').set('Authorization', `Bearer ${token}`);
    const stake = res.body.stakes[0];

    expect(stake.matured).toBe(true);
    expect(stake.daysElapsed).toBe(7); // capped, not 20
    // 1000 * 0.0075 * 7 = 52.5, not 1000 * 0.0075 * 20
    expect(stake.accruedInterest).toBeCloseTo(52.5);
  });
});

describe('POST /api/staking/withdraw', () => {
  test('rejects withdrawing a stake that has not matured yet', async () => {
    const token = await signupAndGetToken();
    const stakeRes = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 1000, durationDays: 30 });

    const res = await request(app)
      .post('/api/staking/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ stakeId: stakeRes.body.id });

    expect(res.status).toBe(400);
  });

  test('rejects a stake id that does not belong to the caller', async () => {
    const tokenA = await signupAndGetToken('a@example.com', 'usera');
    const tokenB = await signupAndGetToken('b@example.com', 'userb');

    const stakeRes = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ amount: 1000, durationDays: 7 });

    const res = await request(app)
      .post('/api/staking/withdraw')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ stakeId: stakeRes.body.id });

    expect(res.status).toBe(404);
  });

  test('pays out principal + interest and closes the stake once matured', async () => {
    const token = await signupAndGetToken();
    const stakeRes = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 1000, durationDays: 7 }); // 0.75%/day

    await backdateStake(stakeRes.body.id, 7);

    const withdrawRes = await request(app)
      .post('/api/staking/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ stakeId: stakeRes.body.id });

    expect(withdrawRes.status).toBe(200);
    expect(withdrawRes.body.principal).toBeCloseTo(1000);
    // 1000 * 0.0075 * 7 = 52.5
    expect(withdrawRes.body.interest).toBeCloseTo(52.5);
    expect(withdrawRes.body.total).toBeCloseTo(1052.5);

    const walletRes = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
    const usdt = walletRes.body.wallets.find((w) => w.asset === 'USDT');
    // Started with 10000, staked 1000 (-> 9000), now credited 1052.5 back.
    expect(usdt.balance).toBe('10052.5000000000');

    const summaryRes = await request(app).get('/api/staking').set('Authorization', `Bearer ${token}`);
    expect(summaryRes.body.stakes).toEqual([]); // CLOSED stakes drop out of the active summary

    const closed = await pool.query('SELECT status, claimed_rewards FROM stakes WHERE id = $1', [
      stakeRes.body.id,
    ]);
    expect(closed.rows[0].status).toBe('CLOSED');
    expect(Number(closed.rows[0].claimed_rewards)).toBeCloseTo(52.5);

    const historyRes = await pool.query('SELECT * FROM stake_withdrawals WHERE stake_id = $1', [
      stakeRes.body.id,
    ]);
    expect(historyRes.rows).toHaveLength(1);
    expect(Number(historyRes.rows[0].total)).toBeCloseTo(1052.5);
  });

  test('concurrent withdrawal attempts on the same matured stake only pay out once', async () => {
    const token = await signupAndGetToken();
    const stakeRes = await request(app)
      .post('/api/staking/stake')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 1000, durationDays: 7 });

    await backdateStake(stakeRes.body.id, 7);

    const attempt = () =>
      request(app)
        .post('/api/staking/withdraw')
        .set('Authorization', `Bearer ${token}`)
        .send({ stakeId: stakeRes.body.id });

    const results = await Promise.all([attempt(), attempt(), attempt()]);
    const statuses = results.map((r) => r.status).sort();

    // Exactly one 200; the rest see the stake as already CLOSED (404).
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 404)).toHaveLength(2);

    const walletRes = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
    const usdt = walletRes.body.wallets.find((w) => w.asset === 'USDT');
    expect(usdt.balance).toBe('10052.5000000000'); // credited exactly once
  });
});