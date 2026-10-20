const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'trade_journal',
  charset: 'utf8mb4',
  dateStrings: true,        // return DATE / DATETIME as plain strings
  waitForConnections: true,
  connectionLimit: 10,
});

// JSON columns: MySQL returns objects, MariaDB may return strings
function json(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
}

module.exports = { pool, json };
