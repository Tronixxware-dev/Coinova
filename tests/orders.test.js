const request = require('supertest');
const app = require('../src/app');
const { resetDb, closeAll, redis, pool } = require('./helpers/db');
const { processTick } = require('../src/services/orderEngine');

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

describe('GET /api/wallet', () => {
  test('requires auth', async () => {
    const res = await request(app).get('/api/wallet');
    expect(res.status).toBe(401);
  });

  test('returns the seeded starting balances', async () => {
    const token = await signupAndGetToken();
    const res = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const usdt = res.body.wallets.find((w) => w.asset === 'USDT');
    const btc = res.body.wallets.find((w) => w.asset === 'BTC');
    expect(usdt.balance).toBe('10000.0000000000');
    expect(btc.balance).toBe('0.0000000000');
  });
});

describe('MARKET orders', () => {
  test('fills instantly and settles the wallet with exact decimal precision', async () => {
    const token = await signupAndGetToken();
    // A price with 8 decimal places and a tiny quantity — the kind of
    // input that would drift under float arithmetic but shouldn't
    // under Decimal.
    await setPrice('BTCUSDT', '65432.12345678');

    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.00000001' });

    expect(orderRes.status).toBe(201);
    expect(orderRes.body.order.status).toBe('FILLED');

    const walletRes = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
    const usdt = walletRes.body.wallets.find((w) => w.asset === 'USDT');
    const btc = walletRes.body.wallets.find((w) => w.asset === 'BTC');

    // 10000 - (0.00000001 * 65432.12345678) = 9999.9993456787654322,
    // rounded to the wallets table's NUMERIC(30,10) precision.
    expect(usdt.balance).toBe('9999.9993456788');
    expect(btc.balance).toBe('0.0000000100');
  });

  test('rejects when no live price is cached yet for the symbol', async () => {
    const token = await signupAndGetToken();

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: '1' });

    expect(res.status).toBe(400);
  });

  test('rejects when funds are insufficient', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');

    // 1 BTC at 65000 needs 65000 USDT; the account only has 10000.
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '1' });

    expect(res.status).toBe(400);
  });

  test('rejects a zero or negative quantity', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '-1' });

    expect(res.status).toBe(400);
  });
});

describe('LIMIT orders', () => {
  test('sits PENDING and locks the exact quote amount needed', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');

    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '60000.55' });

    expect(orderRes.body.order.status).toBe('PENDING');

    const walletRes = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
    const usdt = walletRes.body.wallets.find((w) => w.asset === 'USDT');
    expect(usdt.locked_balance).toBe('600.0055000000'); // 0.01 * 60000.55
  });

  test('fills at the limit price (not the tick price) once the market crosses it', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '60000.55' });

    // Simulate a price tick crossing the limit — the same function the
    // live Binance feed calls per tick.
    await processTick('BTCUSDT', '59999.99');

    const ordersRes = await request(app)
      .get('/api/orders?status=FILLED')
      .set('Authorization', `Bearer ${token}`);

    expect(ordersRes.body.orders).toHaveLength(1);
    expect(ordersRes.body.orders[0].filled_price).toBe('60000.5500000000');
  });

  test('does not fill while the price stays on the wrong side of the trigger', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');

    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '60000' });

    await processTick('BTCUSDT', '64000'); // still above the limit — shouldn't trigger

    const ordersRes = await request(app)
      .get('/api/orders?status=PENDING')
      .set('Authorization', `Bearer ${token}`);
    expect(ordersRes.body.orders).toHaveLength(1);
  });

  test('cancelling a pending order releases exactly the locked funds', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');

    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '60000' });

    const cancelRes = await request(app)
      .delete(`/api/orders/${orderRes.body.order.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(cancelRes.status).toBe(200);

    const walletRes = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
    const usdt = walletRes.body.wallets.find((w) => w.asset === 'USDT');
    expect(usdt.balance).toBe('10000.0000000000');
    expect(usdt.locked_balance).toBe('0.0000000000');
  });

  test('cannot cancel a pending order that belongs to someone else', async () => {
    const tokenA = await signupAndGetToken('usera@example.com', 'usera');
    const tokenB = await signupAndGetToken('userb@example.com', 'userb');
    await setPrice('BTCUSDT', '65000');

    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '60000' });

    const cancelRes = await request(app)
      .delete(`/api/orders/${orderRes.body.order.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(cancelRes.status).toBe(400);
  });

  test('requires a positive price', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '0' });

    expect(res.status).toBe(400);
  });
});

describe('STOP_LOSS orders', () => {
  test('fills at the tick price (not the stop price) once triggered', async () => {
    const token = await signupAndGetToken();
    await setPrice('BTCUSDT', '65000');

    // Need BTC on hand before we can place a SELL stop-loss.
    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01' });

    const stopRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_LOSS', quantity: '0.01', stopPrice: '64000' });
    expect(stopRes.body.order.status).toBe('PENDING');

    await processTick('BTCUSDT', '63500.25');

    const ordersRes = await request(app)
      .get('/api/orders?status=FILLED&symbol=BTCUSDT')
      .set('Authorization', `Bearer ${token}`);
    const stopOrder = ordersRes.body.orders.find((o) => o.type === 'STOP_LOSS');

    expect(stopOrder).toBeDefined();
    expect(stopOrder.filled_price).toBe('63500.2500000000');
  });
});

describe('GET /api/orders', () => {
  test('filters by status and symbol', async () => {
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
      .send({ symbol: 'ETHUSDT', side: 'BUY', type: 'LIMIT', quantity: '1', price: '2900' });

    const res = await request(app)
      .get('/api/orders?status=PENDING&symbol=ETHUSDT')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].symbol).toBe('ETHUSDT');
  });
});

describe('decimal precision regression (float vs exact decimal arithmetic)', () => {
  // This quantity/price pair was found by brute-force search (using the
  // same default 20-significant-digit Decimal precision orderEngine.js
  // actually uses) specifically because native JS float multiplication
  // produces a different result (64196.9508649478) than exact decimal
  // multiplication (64196.9508649477) — a real, if small, one-unit-in-
  // the-last-decimal-place divergence.
  //
  // This has to be a SELL, not a BUY: for a BUY, the wallet debit is
  // already fixed by the correctly-computed lock amount from
  // placeOrder() before settleFill() ever runs, so settleFill's
  // internal recompute barely affects the final balance (any tiny
  // discrepancy just becomes a refund that rounds to zero). A SELL's
  // quote-currency credit, on the other hand, is computed *only* in
  // settleFill — nothing upstream already got it right — so this is
  // the code path that actually needs protecting.
  const QTY = '0.98359144';
  const PRICE = '65267.90317019';
  const EXACT_PROCEEDS = '64196.9508649477'; // qty * price, exact decimal product
  const FLOAT_PROCEEDS = '64196.9508649478'; // what the old parseFloat-based code produced

  test('SELL settles the wallet credit to the exact decimal product, not the float-rounded one', async () => {
    const token = await signupAndGetToken('precision@example.com', 'precisionuser');

    // Seed BTC directly rather than buying it first, so this test is
    // only exercising the SELL-side settleFill computation.
    await pool.query(
      "UPDATE wallets SET balance = $1 WHERE user_id = (SELECT id FROM users WHERE email = 'precision@example.com') AND asset = 'BTC'",
      [QTY]
    );

    await setPrice('BTCUSDT', PRICE);

    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: QTY });

    expect(orderRes.status).toBe(201);

    const walletRes = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
    const usdt = walletRes.body.wallets.find((w) => w.asset === 'USDT');

    const expectedBalance = new (require('decimal.js'))('10000').plus(EXACT_PROCEEDS).toFixed(10);
    expect(usdt.balance).toBe(expectedBalance);
    // Explicitly rule out the float-arithmetic answer, so this test
    // actually fails if the code ever reverts to parseFloat.
    const floatBalance = new (require('decimal.js'))('10000').plus(FLOAT_PROCEEDS).toFixed(10);
    expect(usdt.balance).not.toBe(floatBalance);
  });
});