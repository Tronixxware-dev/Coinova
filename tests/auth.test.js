const request = require('supertest');
const app = require('../src/app');
const { resetDb, closeAll, pool } = require('./helpers/db');
const logger = require('../src/config/logger');

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeAll();
});

describe('POST /api/auth/signup', () => {
  test('creates a user with starting balances and returns tokens', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      email: 'alice@example.com',
      username: 'alice',
      password: 'password123',
    });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.body.user.username).toBe('alice');
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  test('normalizes email to lowercase', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      email: 'Bob@Example.COM',
      username: 'bob',
      password: 'password123',
    });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('bob@example.com');
  });

  test('rejects a duplicate email with 409', async () => {
    await request(app).post('/api/auth/signup').send({
      email: 'carol@example.com',
      username: 'carol1',
      password: 'password123',
    });

    const res = await request(app).post('/api/auth/signup').send({
      email: 'carol@example.com',
      username: 'carol2',
      password: 'password123',
    });

    expect(res.status).toBe(409);
  });

  test('rejects passwords shorter than 8 characters', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      email: 'dave@example.com',
      username: 'dave',
      password: 'short',
    });

    expect(res.status).toBe(400);
  });

  test('rejects missing fields', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      email: 'incomplete@example.com',
    });

    expect(res.status).toBe(400);
  });

  test('concurrent duplicate signups resolve to exactly one 201 and the rest clean 409s, never 500', async () => {
    const attempt = () =>
      request(app)
        .post('/api/auth/signup')
        .send({
          email: 'racer@example.com',
          username: `racer-${Math.random()}`,
          password: 'password123',
        });

    const results = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()]);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
    expect(statuses.filter((s) => s === 500)).toHaveLength(0);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/auth/signup').send({
      email: 'eve@example.com',
      username: 'eve',
      password: 'password123',
    });
  });

  test('logs in with correct credentials', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'eve@example.com',
      password: 'password123',
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  test('logs in regardless of email casing', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'EVE@EXAMPLE.COM',
      password: 'password123',
    });

    expect(res.status).toBe(200);
  });

  test('rejects the wrong password with 401', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'eve@example.com',
      password: 'wrongpassword',
    });

    expect(res.status).toBe(401);
  });

  test('rejects an unknown email with 401 (not 404, to avoid leaking which emails exist)', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'nobody@example.com',
      password: 'password123',
    });

    expect(res.status).toBe(401);
  });

  test('concurrent same-second logins all succeed (duplicate refresh token fix)', async () => {
    const attempt = () =>
      request(app).post('/api/auth/login').send({
        email: 'eve@example.com',
        password: 'password123',
      });

    const results = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()]);
    results.forEach((r) => expect(r.status).toBe(200));

    const tokens = new Set(results.map((r) => r.body.refreshToken));
    expect(tokens.size).toBe(5);
  });
});

describe('refresh / logout flow', () => {
  let refreshToken;

  beforeEach(async () => {
    const res = await request(app).post('/api/auth/signup').send({
      email: 'frank@example.com',
      username: 'frank',
      password: 'password123',
    });
    refreshToken = res.body.refreshToken;
  });

  test('refresh returns a new access token for a valid refresh token', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  test('refresh rejects a garbage token', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: 'not-a-real-token' });

    expect(res.status).toBe(403);
  });

  test('logout revokes the refresh token so it can no longer be used', async () => {
    const logoutRes = await request(app).post('/api/auth/logout').send({ refreshToken });
    expect(logoutRes.status).toBe(200);

    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(403);
  });

  test('refresh tokens are stored as a hash in the DB, never the raw JWT', async () => {
    const result = await pool.query('SELECT token FROM refresh_tokens ORDER BY id DESC LIMIT 1');

    expect(result.rows[0].token).not.toBe(refreshToken);
    expect(result.rows[0].token).toHaveLength(64); // sha256 hex digest length
  });
});

// The raw reset token is deliberately never returned in the API
// response (only a generic "if that email exists..." message is) —
// in production it only ever reaches the user via the logged/emailed
// reset link. Tests intercept it the same way: spy on the logger call
// that would have been the email send, and pull the token back out of
// the URL it logged.
async function requestPasswordResetAndGetToken(email) {
  const spy = jest.spyOn(logger, 'info').mockImplementation(() => {});
  await request(app).post('/api/auth/forgot-password').send({ email });
  const call = spy.mock.calls.find(([msg]) => typeof msg === 'string' && msg.includes('reset link:'));
  spy.mockRestore();
  if (!call) return null;
  const match = call[0].match(/token=([a-f0-9]+)/);
  return match ? match[1] : null;
}

describe('POST /api/auth/forgot-password', () => {
  test('requires an email', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({});
    expect(res.status).toBe(400);
  });

  test('returns the same generic response for a registered and an unregistered email', async () => {
    await request(app).post('/api/auth/signup').send({
      email: 'gina@example.com',
      username: 'gina',
      password: 'password123',
    });

    const registered = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'gina@example.com' });
    const unregistered = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@example.com' });

    expect(registered.status).toBe(200);
    expect(unregistered.status).toBe(200);
    expect(registered.body.message).toBe(unregistered.body.message);
  });

  test('creates a password_resets row only for a registered email', async () => {
    await request(app).post('/api/auth/signup').send({
      email: 'henry@example.com',
      username: 'henry',
      password: 'password123',
    });

    await request(app).post('/api/auth/forgot-password').send({ email: 'henry@example.com' });
    await request(app).post('/api/auth/forgot-password').send({ email: 'ghost@example.com' });

    const rows = await pool.query('SELECT * FROM password_resets');
    expect(rows.rows).toHaveLength(1);
  });
});

describe('POST /api/auth/reset-password', () => {
  async function signupUser(email = 'ivy@example.com', username = 'ivy') {
    await request(app).post('/api/auth/signup').send({ email, username, password: 'password123' });
  }

  test('requires token and newPassword', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({});
    expect(res.status).toBe(400);
  });

  test('rejects a new password shorter than 8 characters', async () => {
    await signupUser();
    const token = await requestPasswordResetAndGetToken('ivy@example.com');
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  test('rejects a garbage/unknown token', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'not-a-real-token', newPassword: 'newpassword123' });
    expect(res.status).toBe(400);
  });

  test('rejects an expired token', async () => {
    await signupUser();
    const token = await requestPasswordResetAndGetToken('ivy@example.com');

    await pool.query(
      `UPDATE password_resets SET expires_at = NOW() - INTERVAL '1 hour'
       WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      ['ivy@example.com']
    );

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'newpassword123' });
    expect(res.status).toBe(400);
  });

  test('rejects a token that has already been used', async () => {
    await signupUser();
    const token = await requestPasswordResetAndGetToken('ivy@example.com');

    const first = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'newpassword123' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'anothernewpass456' });
    expect(second.status).toBe(400);
  });

  test('updates the password, and old credentials no longer work', async () => {
    await signupUser();
    const token = await requestPasswordResetAndGetToken('ivy@example.com');

    const resetRes = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'brandnewpassword' });
    expect(resetRes.status).toBe(200);

    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ivy@example.com', password: 'password123' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ivy@example.com', password: 'brandnewpassword' });
    expect(newLogin.status).toBe(200);
  });

  test('revokes every existing refresh token on a successful reset', async () => {
    const signupRes = await request(app).post('/api/auth/signup').send({
      email: 'jack@example.com',
      username: 'jack',
      password: 'password123',
    });
    const oldRefreshToken = signupRes.body.refreshToken;

    const token = await requestPasswordResetAndGetToken('jack@example.com');
    await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'brandnewpassword' });

    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken: oldRefreshToken });
    expect(refreshRes.status).toBe(403);
  });

  test('concurrent reset attempts with the same token only succeed once', async () => {
    await signupUser('kelly@example.com', 'kelly');
    const token = await requestPasswordResetAndGetToken('kelly@example.com');

    const attempt = () =>
      request(app).post('/api/auth/reset-password').send({ token, newPassword: 'racecondition1' });

    const results = await Promise.all([attempt(), attempt(), attempt()]);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 400)).toHaveLength(2);
  });
});