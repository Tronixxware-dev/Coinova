-- Guarantee email/username can never collide across concurrent signups,
-- no matter what's already on the table today.
DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
EXCEPTION
  WHEN duplicate_table THEN NULL;  -- constraint (by any name) already covers this
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

-- Profile picture support: stored as a data URL (base64) directly in
-- Postgres, so no extra file-storage service is needed for a project
-- this size.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data_url TEXT;

-- Support/contact form submissions.
CREATE TABLE IF NOT EXISTS support_tickets (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject     VARCHAR(200) NOT NULL,
    message     TEXT NOT NULL,
    status      VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id);