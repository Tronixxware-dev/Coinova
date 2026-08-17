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

describe('GET /api/trades', () => {
  test('requires auth', async () => {
    const res = await request(app).get('/api/trades');
    expect(res.status).toBe(401);
  });

  test('returns an empty list for a user with no trades yet', async () => {
    const token = await signupAndGetToken();
    const res = await request(app).get('/api/trades').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.trades).toEqual([]);
  });

  test('records a trade the moment a market order fills', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01' });

    const res = await request(app).get('/api/trades').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.trades).toHaveLength(1);
    expect(res.body.trades[0]).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: '0.0100000000',
      price: '65000.0000000000',
    });
  });

  test('only returns the requesting user\'s own trades, never another user\'s', async () => {
    const tokenA = await signupAndGetToken('usera@example.com', 'usera');
    const tokenB = await signupAndGetToken('userb@example.com', 'userb');
    await setPrice('BTCUSDT', '65000');

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01' });

    const res = await request(app).get('/api/trades').set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(200);
    expect(res.body.trades).toEqual([]);
  });

  test('filters by symbol', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');
    await setPrice('ETHUSDT', '3000');

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01' });
    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: '0.1' });

    const res = await request(app)
      .get('/api/trades?symbol=ETHUSDT')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.trades).toHaveLength(1);
    expect(res.body.trades[0].symbol).toBe('ETHUSDT');
  });

  test('newest trades come first', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01' });
    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.02' });

    const res = await request(app).get('/api/trades').set('Authorization', `Bearer ${token}`);

    expect(res.body.trades).toHaveLength(2);
    // Most recent fill (the 0.02 buy) should be first.
    expect(res.body.trades[0].quantity).toBe('0.0200000000');
    expect(res.body.trades[1].quantity).toBe('0.0100000000');
  });
});