# Crypto Exchange Sim — Backend

Simulated crypto trading backend: real live prices from Binance's public
market-data stream, fake/virtual funds. No real money, no real orders
ever touch a real exchange — this only reads public price data.

## Stack
- Express (REST API)
- PostgreSQL (users, wallets, orders, trades)
- Redis (latest price cache)
- `ws` (both: consuming Binance's price stream, and running our own
  WebSocket server to push prices to the frontend)
- JWT auth (access + refresh tokens)

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Create a PostgreSQL database and run the schema:
   ```
   createdb crypto_exchange_sim
   psql crypto_exchange_sim < src/models/schema.sql
   ```

3. Make sure Redis is running locally (or point `REDIS_URL` at a hosted instance).

4. Copy `.env.example` to `.env` and fill in your values:
   ```
   cp .env.example .env
   ```
   Generate strong JWT secrets, e.g.:
   ```
   openssl rand -hex 64
   ```

5. Run it:
   ```
   npm run dev
   ```
   The API will be on `http://localhost:4000`, and the price WebSocket
   on `ws://localhost:4000/ws/prices`.

## API overview

| Method | Route                | Auth | Description |
|--------|-----------------------|------|--------------|
| POST   | `/api/auth/signup`    | No   | Create account, seeds 10,000 virtual USDT |
| POST   | `/api/auth/login`     | No   | Returns access + refresh tokens |
| POST   | `/api/auth/refresh`   | No   | Exchange refresh token for new access token |
| POST   | `/api/auth/logout`    | No   | Revokes a refresh token |
| GET    | `/api/wallet`         | Yes  | List balances per asset |
| POST   | `/api/orders`         | Yes  | Place a MARKET, LIMIT, or STOP_LOSS order |
| GET    | `/api/orders`         | Yes  | Order history (filter by `?status=` / `?symbol=`) |
| DELETE | `/api/orders/:id`     | Yes  | Cancel a pending order |

### Placing an order
```json
POST /api/orders
Authorization: Bearer <accessToken>

{
  "symbol": "BTCUSDT",
  "side": "BUY",
  "type": "LIMIT",
  "quantity": 0.01,
  "price": 60000
}
```
`type` is one of `MARKET`, `LIMIT`, `STOP_LOSS`. `price` is required for
`LIMIT`, `stopPrice` for `STOP_LOSS`. `MARKET` orders fill instantly
against the latest streamed price.

### Live prices (frontend)
Connect to `ws://localhost:4000/ws/prices?token=<accessToken>`. You'll
receive messages like:
```json
{ "type": "price", "symbol": "BTCUSDT", "price": 61234.5, "timestamp": 1734000000000 }
```

## Tradable symbols
Currently: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `XRPUSDT` — see
`src/services/priceFeed.js` to add more (must be valid Binance pairs).

## Design notes
- Balances use a `balance` / `locked_balance` split — placing an order
  locks funds immediately so users can't overdraw across multiple
  pending orders; funds are only spent on actual fill.
- Limit and stop-loss orders are checked against every incoming price
  tick directly via PostgreSQL (`orderEngine.processTick`). This is
  simple and correct; if you scale up to many pending orders, moving
  that lookup to a Redis sorted set keyed by trigger price would cut
  down per-tick DB load.
- This is **not** production-hardened for real funds — no rate
  limiting, no KYC, no real custody. It's built for realistic
  simulated trading only.
