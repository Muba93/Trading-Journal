// Creates the database and tables from schema.sql using the settings in .env
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  const name = process.env.DB_NAME || 'trade_journal';
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('DB_NAME may only contain letters, numbers and _');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/trade_journal/g, name);
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });
  await conn.query(sql);
  await conn.end();
  console.log(`Database "${name}" is ready.`);
})().catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
