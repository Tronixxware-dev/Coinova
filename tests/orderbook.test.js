const request = require('supertest');
const app = require('../src/app');
const { resetDb, closeAll, redis } = require('./helpers/db');
const { processTick } = require('../src/services/orderEngine');

async function signupAndGetToken(email, username) {
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

describe('GET /api/orderbook/:symbol', () => {
  test('requires auth', async () => {
    const res = await request(app).get('/api/orderbook/BTCUSDT');
    expect(res.status).toBe(401);
  });

  test('rejects a symbol with an unrecognized quote asset', async () => {
    const token = await signupAndGetToken('trader1@example.com', 'trader1');
    const res = await request(app)
      .get('/api/orderbook/NOTAREALPAIR')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  test('returns empty bids/asks when nothing is resting', async () => {
    const token = await signupAndGetToken('trader2@example.com', 'trader2');
    const res = await request(app)
      .get('/api/orderbook/BTCUSDT')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.bids).toEqual([]);
    expect(res.body.asks).toEqual([]);
    expect(res.body.lastPrice).toBeNull();
  });

  test('includes the cached live price as lastPrice', async () => {
    const token = await signupAndGetToken('trader3@example.com', 'trader3');
    await setPrice('BTCUSDT', '65000.5');

    const res = await request(app)
      .get('/api/orderbook/BTCUSDT')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.lastPrice).toBe('65000.5');
  });

  test('aggregates orders at the same price level, across different users', async () => {
    const tokenA = await signupAndGetToken('bidder1@example.com', 'bidder1');
    const tokenB = await signupAndGetToken('bidder2@example.com', 'bidder2');
    await setPrice('BTCUSDT', '65000');

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '60000' });
    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.02', price: '60000' });

    const res = await request(app)
      .get('/api/orderbook/BTCUSDT')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.body.bids).toHaveLength(1);
    expect(res.body.bids[0]).toMatchObject({ price: '60000.0000000000', quantity: '0.0300000000' });
  });

  test('sorts bids highest-first and asks lowest-first', async () => {
    const token = await signupAndGetToken('trader4@example.com', 'trader4');
    await setPrice('BTCUSDT', '65000');

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '59000' });
    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '61000' });

    const res = await request(app)
      .get('/api/orderbook/BTCUSDT')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.bids.map((b) => b.price)).toEqual(['61000.0000000000', '59000.0000000000']);
  });

  test('excludes STOP_LOSS orders and filled/cancelled orders from the book', async () => {
    const token = await signupAndGetToken('trader5@example.com', 'trader5');
    await setPrice('BTCUSDT', '65000');

    // Buy BTC first so there's something to place a stop-loss against.
    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01' });

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_LOSS', quantity: '0.01', stopPrice: '60000' });

    // A LIMIT order that gets filled shouldn't linger in the book either.
    const limitRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '65000' });
    await processTick('BTCUSDT', '65000');

    const res = await request(app)
      .get('/api/orderbook/BTCUSDT')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.bids).toEqual([]);
    expect(res.body.asks).toEqual([]);
  });
});