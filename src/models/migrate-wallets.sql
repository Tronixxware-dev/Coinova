-- One deposit address per user per chain. The private key is never
-- stored here — it's re-derived on demand from WALLET_MNEMONIC +
-- derivation_index whenever we need to sign something.
CREATE TABLE IF NOT EXISTS deposit_addresses (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chain              VARCHAR(20) NOT NULL,       -- 'ETH', 'BTC', 'TRON'
    address            VARCHAR(255) NOT NULL,
    derivation_index   INTEGER NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, chain),
    UNIQUE(chain, address)
);

-- One row per on-chain deposit we've detected. `status` tracks it from
-- first-seen through confirmed through actually credited to the user's
-- internal balance, so a crashed/restarted poller can't double-credit.
CREATE TABLE IF NOT EXISTS onchain_deposits (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chain              VARCHAR(20) NOT NULL,
    asset              VARCHAR(20) NOT NULL,       -- 'ETH', 'USDT', 'BTC'
    tx_hash            VARCHAR(255) NOT NULL,
    amount             NUMERIC(30, 10) NOT NULL,
    confirmations      INTEGER NOT NULL DEFAULT 0,
    status             VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'CONFIRMED', 'CREDITED')),
    credited_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(chain, tx_hash, asset)
);

CREATE INDEX IF NOT EXISTS idx_onchain_deposits_status ON onchain_deposits(status);