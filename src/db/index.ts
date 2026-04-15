import { Pool } from 'pg';

let pool: Pool;

export function getDb(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected database pool error', err);
    });
  }
  return pool;
}

export async function runMigrations(): Promise<void> {
  const db = getDb();

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email       TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      business_name TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_credentials (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel     TEXT NOT NULL,  -- 'facebook' | 'whatsapp' | 'twilio'
      key         TEXT NOT NULL,  -- field name e.g. 'pageAccessToken'
      value       TEXT NOT NULL DEFAULT '',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, channel, key)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_type    TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      contact_name    TEXT NOT NULL DEFAULT 'Unknown',
      contact_id      TEXT NOT NULL DEFAULT '',
      page_name       TEXT NOT NULL DEFAULT '',
      unread_count    INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, channel_type, channel_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      direction       TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
      text            TEXT NOT NULL DEFAULT '',
      channel_type    TEXT NOT NULL,
      channel_msg_id  TEXT,
      is_read         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_user_credentials_user ON user_credentials(user_id, channel);
  `);

  console.log('Database migrations complete');
}
