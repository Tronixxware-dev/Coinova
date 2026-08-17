CREATE TABLE IF NOT EXISTS stakes (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    principal        NUMERIC(30, 10) NOT NULL,
    duration_days    INTEGER NOT NULL,
    daily_rate       NUMERIC(6, 4) NOT NULL,
    staked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    matures_at       TIMESTAMPTZ NOT NULL,
    claimed_rewards  NUMERIC(30, 10) NOT NULL DEFAULT 0,
    status           VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stakes_user ON stakes(user_id);

CREATE TABLE IF NOT EXISTS stake_withdrawals (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stake_id      INTEGER NOT NULL REFERENCES stakes(id) ON DELETE CASCADE,
    principal     NUMERIC(30, 10) NOT NULL,
    interest      NUMERIC(30, 10) NOT NULL,
    total         NUMERIC(30, 10) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stake_withdrawals_user ON stake_withdrawals(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(64) NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);