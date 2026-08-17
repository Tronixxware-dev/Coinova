const request = require('supertest');
const app = require('../src/app');
const { resetDb, closeAll, redis } = require('./helpers/db');

async function signupAndGetToken(email = 'trader@example.com', username = 'trader') {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ email, username, password: 'password123' });
  return res.body.accessToken;
}

async function setPrice(symbol, price) {
  await redis.set(`price:${symbol}`, price);
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeAll();
});

describe('POST /api/wallet/deposit', () => {
  test('requires auth', async () => {
    const res = await request(app).post('/api/wallet/deposit').send({ asset: 'USDT', amount: '100' });
    expect(res.status).toBe(401);
  });

  test('adds to an existing balance', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/wallet/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'USDT', amount: '500' });

    expect(res.status).toBe(201);
    expect(res.body.balance).toBe('10500.0000000000');
  });

  test('lazily creates a wallet for an asset the user has never held', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/wallet/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'SOL', amount: '10' });

    expect(res.status).toBe(201);
    expect(res.body.balance).toBe('10.0000000000');
  });

  test('rejects an unsupported asset', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/wallet/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'DOGE', amount: '10' });

    expect(res.status).toBe(400);
  });

  test('rejects a zero or negative amount', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/wallet/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'USDT', amount: '-5' });

    expect(res.status).toBe(400);
  });

  test('rejects an amount above the per-deposit cap', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/wallet/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'USDT', amount: '99999999' });

    expect(res.status).toBe(400);
  });

  test('records a DEPOSIT entry in the transaction ledger', async () => {
    const token = await signupAndGetToken();
    await request(app)
      .post('/api/wallet/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'USDT', amount: '500' });

    const res = await request(app)
      .get('/api/wallet/transactions')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0]).toMatchObject({
      asset: 'USDT',
      type: 'DEPOSIT',
      amount: '500.0000000000',
      balance_after: '10500.0000000000',
    });
  });
});

describe('POST /api/wallet/withdraw', () => {
  test('requires auth', async () => {
    const res = await request(app).post('/api/wallet/withdraw').send({ asset: 'USDT', amount: '100' });
    expect(res.status).toBe(401);
  });

  test('deducts from an existing balance', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/wallet/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'USDT', amount: '4000' });

    expect(res.status).toBe(201);
    expect(res.body.balance).toBe('6000.0000000000');
  });

  test('rejects a withdrawal larger than the free balance', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/wallet/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'USDT', amount: '20000' });

    expect(res.status).toBe(400);
  });

  test('cannot withdraw funds that are locked in an open order', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');

    // Locks 6500 USDT (0.1 * 65000) into a pending LIMIT order.
    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.1', price: '65000' });

    // Only 3500 of the original 10000 USDT is still free.
    const res = await request(app)
      .post('/api/wallet/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'USDT', amount: '4000' });

    expect(res.status).toBe(400);
  });

  test('rejects withdrawing an unsupported asset', async () => {
    const token = await signupAndGetToken();
    const res = await request(app)
      .post('/api/wallet/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'DOGE', amount: '1' });

    expect(res.status).toBe(400);
  });

  test('concurrent withdrawals never overdraft the balance', async () => {
    const token = await signupAndGetToken();
    // Starting balance is 10000 USDT. Fire five concurrent withdrawals
    // of 3000 each (15000 total) — at most three can succeed.
    const attempt = () =>
      request(app)
        .post('/api/wallet/withdraw')
        .set('Authorization', `Bearer ${token}`)
        .send({ asset: 'USDT', amount: '3000' });

    const results = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()]);
    const succeeded = results.filter((r) => r.status === 201);
    const failed = results.filter((r) => r.status === 400);

    expect(succeeded).toHaveLength(3);
    expect(failed).toHaveLength(2);

    const walletRes = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
    const usdt = walletRes.body.wallets.find((w) => w.asset === 'USDT');
    expect(usdt.balance).toBe('1000.0000000000');
  });

  test('records a WITHDRAWAL entry in the transaction ledger', async () => {
    const token = await signupAndGetToken();
    await request(app)
      .post('/api/wallet/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'USDT', amount: '1000' });

    const res = await request(app)
      .get('/api/wallet/transactions')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0]).toMatchObject({
      asset: 'USDT',
      type: 'WITHDRAWAL',
      amount: '1000.0000000000',
      balance_after: '9000.0000000000',
    });
  });
});

describe('GET /api/wallet/transactions', () => {
  test('requires auth', async () => {
    const res = await request(app).get('/api/wallet/transactions');
    expect(res.status).toBe(401);
  });

  test('filters by asset and shows newest first', async () => {
    const token = await signupAndGetToken();
    await request(app)
      .post('/api/wallet/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'USDT', amount: '100' });
    await request(app)
      .post('/api/wallet/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'SOL', amount: '5' });
    await request(app)
      .post('/api/wallet/deposit')
      .set('Authorization', `Bearer ${token}`)
      .send({ asset: 'USDT', amount: '50' });

    const res = await request(app)
      .get('/api/wallet/transactions?asset=USDT')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.transactions).toHaveLength(2);
    expect(res.body.transactions[0].amount).toBe('50.0000000000'); // most recent first
    expect(res.body.transactions[1].amount).toBe('100.0000000000');
  });
});