-- Trade Journal database schema (MySQL 5.7+ / 8.x, MariaDB 10.5+)
-- Run once:  npm run db:init   (or: mysql -u root -p < server/schema.sql)

CREATE DATABASE IF NOT EXISTS trade_journal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE trade_journal;

-- People who can log in
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  name          VARCHAR(120) NULL,
  password_hash VARCHAR(255) NULL,           -- NULL for Google-only accounts
  google_id     VARCHAR(64)  NULL UNIQUE,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per user: accounts/platforms, rules, goals, sessions, setups, lists, etc.
CREATE TABLE IF NOT EXISTS settings (
  user_id    INT UNSIGNED PRIMARY KEY,
  data       JSON NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Trades. Main fields are real columns (easy to query and report on);
-- `data` keeps the full trade (review, emotions, rules, notes...) exactly as the app uses it.
CREATE TABLE IF NOT EXISTS trades (
  user_id      INT UNSIGNED NOT NULL,
  id           VARCHAR(40)  NOT NULL,
  pair         VARCHAR(20)  NULL,
  direction    ENUM('Long','Short') NULL,
  platform_id  VARCHAR(40)  NULL,
  entry_at     DATETIME     NULL,             -- wall-clock time in the trade's timezone
  exit_at      DATETIME     NULL,
  timezone     DECIMAL(4,1) NULL,             -- UTC offset, e.g. 5.0 for Pakistan
  entry_price  DECIMAL(18,6) NULL,
  exit_price   DECIMAL(18,6) NULL,
  lot_size     DECIMAL(12,4) NULL,
  sl_initial   DECIMAL(18,6) NULL,
  tp_initial   DECIMAL(18,6) NULL,
  sl_final     DECIMAL(18,6) NULL,
  tp_final     DECIMAL(18,6) NULL,
  fees         DECIMAL(12,2) NULL,
  pnl_override DECIMAL(14,2) NULL,
  rating       TINYINT UNSIGNED NULL,
  data         JSON NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, id),
  KEY idx_trades_user_entry (user_id, entry_at),
  KEY idx_trades_user_platform (user_id, platform_id),
  CONSTRAINT fk_trades_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Chart screenshots. The image FILE is saved in the uploads folder;
-- this row stores where it is (file_path) and the URL the app uses to show it.
CREATE TABLE IF NOT EXISTS trade_images (
  id         CHAR(32)     NOT NULL PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  trade_id   VARCHAR(40)  NULL,                -- NULL until the trade is saved
  kind       ENUM('before','after') NULL,
  file_path  VARCHAR(255) NOT NULL,            -- relative to UPLOAD_DIR, e.g. 7/2026-10/abc123.jpg
  url        VARCHAR(255) NOT NULL,            -- e.g. /uploads/7/2026-10/abc123.jpg
  mime_type  VARCHAR(50)  NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_images_trade (user_id, trade_id),
  CONSTRAINT fk_images_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Money tab: deposits, withdrawals, challenge fees, payouts, fee refunds
CREATE TABLE IF NOT EXISTS transactions (
  user_id     INT UNSIGNED NOT NULL,
  id          VARCHAR(40)  NOT NULL,
  platform_id VARCHAR(40)  NULL,
  type        ENUM('deposit','withdrawal','fee','payout','refund') NOT NULL,
  amount      DECIMAL(14,2) NOT NULL,
  tx_date     DATE NOT NULL,
  note        VARCHAR(500) NULL,
  data        JSON NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, id),
  KEY idx_tx_user_date (user_id, tx_date),
  CONSTRAINT fk_tx_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Weekly notes (one row per user per week; week_start = Monday)
CREATE TABLE IF NOT EXISTS weekly_notes (
  user_id    INT UNSIGNED NOT NULL,
  week_start DATE NOT NULL,
  data       JSON NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, week_start),
  CONSTRAINT fk_weeks_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
