-- Connections of outside AI clients (MCP) to a person. A connection acts as that Telegram user, in every group
-- they are a member of. Codes and tokens are stored as SHA-256 hashes only.
CREATE TABLE mcp_pairing (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  -- Held by the client that started the pairing, to collect its token.
  secret_hash TEXT NOT NULL,
  client_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','approved','denied','collected')),
  telegram_user_id INTEGER,
  connection_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE mcp_connection (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  client_name TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX mcp_connection_user ON mcp_connection(telegram_user_id);
-- Wrong or expired codes sent to the bot, to pause pairing after too many.
CREATE TABLE mcp_pair_attempt (
  id INTEGER PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX mcp_pair_attempt_user ON mcp_pair_attempt(telegram_user_id, created_at);
CREATE TABLE mcp_usage (
  id INTEGER PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES mcp_connection(id),
  day TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX mcp_usage_connection_day ON mcp_usage(connection_id, day);
