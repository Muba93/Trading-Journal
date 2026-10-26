-- Trade Journal - Cloudflare D1 schema (SQLite)
-- Paste into: Cloudflare dashboard -> Storage & Databases -> D1 -> your database -> Console
-- or run:     npx wrangler d1 execute trade-journal-db --remote --file=db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT,                 -- NULL for Google-only accounts
  google_id     TEXT UNIQUE,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,        -- SHA-256 of the login cookie (the cookie itself is never stored)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One row per user: accounts/platforms, rules, goals, sessions, setups, lists (JSON text)
CREATE TABLE IF NOT EXISTS settings (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Trades: main fields as columns (easy to query), full trade in `data` (JSON text)
CREATE TABLE IF NOT EXISTS trades (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  pair         TEXT,
  direction    TEXT,                  -- Long / Short
  platform_id  TEXT,
  entry_at     TEXT,                  -- 'YYYY-MM-DD HH:MM:00' wall-clock time in the trade's timezone
  exit_at      TEXT,
  timezone     REAL,                  -- UTC offset, e.g. 5 for Pakistan
  entry_price  REAL,
  exit_price   REAL,
  lot_size     REAL,
  sl_initial   REAL,
  tp_initial   REAL,
  sl_final     REAL,
  tp_final     REAL,
  fees         REAL,
  pnl_override REAL,
  rating       INTEGER,
  data         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_trades_user_entry ON trades(user_id, entry_at);
CREATE INDEX IF NOT EXISTS idx_trades_user_platform ON trades(user_id, platform_id);

-- Chart screenshots: the image FILE is in the R2 bucket; this row stores its path (R2 key) and URL
CREATE TABLE IF NOT EXISTS trade_images (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_id   TEXT,                    -- NULL until the trade is saved
  kind       TEXT,                    -- before / after
  file_path  TEXT NOT NULL,           -- R2 key, e.g. 3/2026-10/abc123.jpg
  url        TEXT NOT NULL,           -- e.g. /uploads/3/2026-10/abc123.jpg
  mime_type  TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_images_trade ON trade_images(user_id, trade_id);

-- Money tab: deposit, withdrawal, fee, payout, refund
CREATE TABLE IF NOT EXISTS transactions (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  platform_id TEXT,
  type        TEXT NOT NULL,
  amount      REAL NOT NULL,
  tx_date     TEXT NOT NULL,          -- YYYY-MM-DD
  note        TEXT,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, tx_date);

-- Weekly notes (week_start = Monday)
CREATE TABLE IF NOT EXISTS weekly_notes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, week_start)
);

-- Simple protection against password guessing
CREATE TABLE IF NOT EXISTS auth_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_ip_ts ON auth_attempts(ip, ts);

-- Password reset links (also created automatically by the app the first time it's needed)
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,         -- SHA-256 of the emailed token (the token itself is never stored)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
