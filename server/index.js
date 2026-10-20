// Trade Journal server: Express + MySQL
// - Email/password login (bcrypt) and optional Google sign-in
// - Login kept in an httpOnly cookie (JWT)
// - All journal data stored per user in MySQL
// - Chart images saved in the uploads folder, path stored in MySQL (trade_images)
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');
const { pool, json } = require('./db');

// ---------- config ----------
const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || '';
if (JWT_SECRET.length < 32) {
  console.error('JWT_SECRET is missing or too short. Set a random value of 32+ characters in .env');
  process.exit(1);
}
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const ROOT = path.join(__dirname, '..');
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const COOKIE = 'tj_session';
const SESSION_DAYS = 30;

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
      scriptSrcAttr: ["'unsafe-inline'"],                 // the app uses inline onclick handlers
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com'],
      connectSrc: ["'self'", 'https://accounts.google.com'],
      frameSrc: ['https://accounts.google.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // needed for the Google popup
}));
app.use(express.json({ limit: '3mb' }));
app.use(cookieParser());

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const num = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
const dt = (v) => { const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/); return m ? `${m[1]} ${m[2]}:00` : null; };
const day = (v) => { const m = String(v || '').match(/^\d{4}-\d{2}-\d{2}$/); return m ? m[0] : null; };
const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function setSession(res, userId) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: SESSION_DAYS * 864e5, path: '/' });
}
function publicUser(u) { return { id: u.id, email: u.email, name: u.name, hasPassword: !!u.password_hash, google: !!u.google_id }; }

function auth(req, res, next) {
  const token = req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Please log in' });
  try { req.userId = jwt.verify(token, JWT_SECRET).uid; next(); }
  catch { res.clearCookie(COOKIE, { path: '/' }); res.status(401).json({ error: 'Your session expired. Please log in again.' }); }
}

// ---------- auth routes ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' } });

app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID || null }));

app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = str(req.body.name, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const [ex] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (ex.length) return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
  const hash = await bcrypt.hash(password, 12);
  const [r] = await pool.query('INSERT INTO users (email, name, password_hash, last_login_at) VALUES (?, ?, ?, NOW())', [email, name, hash]);
  setSession(res, r.insertId);
  res.json({ user: { id: r.insertId, email, name, hasPassword: true, google: false } });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  const u = rows[0];
  if (u && !u.password_hash) return res.status(400).json({ error: 'This account uses Google sign-in. Please continue with Google.' });
  if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'Wrong email or password.' });
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [u.id]);
  setSession(res, u.id);
  res.json({ user: publicUser(u) });
}));

app.post('/api/auth/google', authLimiter, wrap(async (req, res) => {
  if (!googleClient) return res.status(400).json({ error: 'Google sign-in is not enabled on this server.' });
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: String(req.body.credential || ''), audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch { return res.status(401).json({ error: 'Google sign-in failed. Please try again.' }); }
  if (!payload || !payload.email || !payload.email_verified) return res.status(401).json({ error: 'Your Google email is not verified.' });
  const email = payload.email.toLowerCase();
  let [rows] = await pool.query('SELECT * FROM users WHERE google_id = ?', [payload.sub]);
  let u = rows[0];
  if (!u) {
    [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    u = rows[0];
    if (u) await pool.query('UPDATE users SET google_id = ? WHERE id = ?', [payload.sub, u.id]); // link existing email account
    else {
      const [r] = await pool.query('INSERT INTO users (email, name, google_id) VALUES (?, ?, ?)', [email, str(payload.name, 120), payload.sub]);
      u = { id: r.insertId, email, name: payload.name || null, password_hash: null };
    }
    u.google_id = payload.sub;
  }
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [u.id]);
  setSession(res, u.id);
  res.json({ user: publicUser(u) });
}));

app.post('/api/auth/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

app.get('/api/auth/me', auth, wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.userId]);
  if (!rows[0]) { res.clearCookie(COOKIE, { path: '/' }); return res.status(401).json({ error: 'Please log in' }); }
  res.json({ user: publicUser(rows[0]) });
}));

// ---------- journal data ----------
app.get('/api/data', auth, wrap(async (req, res) => {
  const uid = req.userId;
  const [[s], [tr], [tx], [wk]] = await Promise.all([
    pool.query('SELECT data FROM settings WHERE user_id = ?', [uid]),
    pool.query('SELECT id, data FROM trades WHERE user_id = ?', [uid]),
    pool.query('SELECT id, data FROM transactions WHERE user_id = ?', [uid]),
    pool.query('SELECT week_start, data FROM weekly_notes WHERE user_id = ?', [uid]),
  ]);
  const trades = {}; tr.forEach((r) => { trades[r.id] = json(r.data); });
  const cash = {}; tx.forEach((r) => { cash[r.id] = json(r.data); });
  const weeks = {}; wk.forEach((r) => { weeks[String(r.week_start).slice(0, 10)] = json(r.data); });
  res.json({ settings: s[0] ? json(s[0].data) : null, trades, cash, weeks });
}));

app.put('/api/settings', auth, wrap(async (req, res) => {
  if (!isObj(req.body)) return res.status(400).json({ error: 'Invalid settings' });
  await pool.query('INSERT INTO settings (user_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)', [req.userId, JSON.stringify(req.body)]);
  res.json({ ok: true });
}));

// Trades
app.put('/api/trades/:id', auth, wrap(async (req, res) => {
  const id = req.params.id; const t = req.body; const uid = req.userId;
  if (!validId(id) || !isObj(t)) return res.status(400).json({ error: 'Invalid trade' });
  t.id = id;
  const dir = t.dir === 'Short' ? 'Short' : t.dir === 'Long' ? 'Long' : null;
  const rating = num(t.rating);
  await pool.query(
    `INSERT INTO trades (user_id, id, pair, direction, platform_id, entry_at, exit_at, timezone, entry_price, exit_price, lot_size,
       sl_initial, tp_initial, sl_final, tp_final, fees, pnl_override, rating, data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE pair=VALUES(pair), direction=VALUES(direction), platform_id=VALUES(platform_id), entry_at=VALUES(entry_at),
       exit_at=VALUES(exit_at), timezone=VALUES(timezone), entry_price=VALUES(entry_price), exit_price=VALUES(exit_price), lot_size=VALUES(lot_size),
       sl_initial=VALUES(sl_initial), tp_initial=VALUES(tp_initial), sl_final=VALUES(sl_final), tp_final=VALUES(tp_final), fees=VALUES(fees),
       pnl_override=VALUES(pnl_override), rating=VALUES(rating), data=VALUES(data)`,
    [uid, id, str(t.pair, 20), dir, str(t.platform, 40), dt(t.entryAt), dt(t.exitAt), num(t.tz), num(t.entry), num(t.exit), num(t.lot),
      num(t.sl0), num(t.tp0), num(t.slF), num(t.tpF), num(t.fees), num(t.pnlOverride), rating ? Math.min(10, Math.max(0, rating)) : null, JSON.stringify(t)]);

  // Link uploaded images to this trade; remove images that are no longer used by it
  const keep = [];
  for (const [field, kind] of [['imgBefore', 'before'], ['imgAfter', 'after']]) {
    const img = t[field];
    if (img && /^[a-f0-9]{32}$/.test(img.id || '')) {
      keep.push(img.id);
      await pool.query('UPDATE trade_images SET trade_id = ?, kind = ? WHERE user_id = ? AND id = ?', [id, kind, uid, img.id]);
    }
  }
  const [old] = await pool.query(
    `SELECT id, file_path FROM trade_images WHERE user_id = ? AND trade_id = ?${keep.length ? ' AND id NOT IN (?)' : ''}`,
    keep.length ? [uid, id, keep] : [uid, id]);
  await removeImages(uid, old);
  res.json({ ok: true });
}));

app.delete('/api/trades/:id', auth, wrap(async (req, res) => {
  const id = req.params.id; const uid = req.userId;
  if (!validId(id)) return res.status(400).json({ error: 'Invalid trade' });
  const [imgs] = await pool.query('SELECT id, file_path FROM trade_images WHERE user_id = ? AND trade_id = ?', [uid, id]);
  await removeImages(uid, imgs);
  await pool.query('DELETE FROM trades WHERE user_id = ? AND id = ?', [uid, id]);
  res.json({ ok: true });
}));

// Money transactions
const TX_TYPES = ['deposit', 'withdrawal', 'fee', 'payout', 'refund'];
app.put('/api/cash/:id', auth, wrap(async (req, res) => {
  const id = req.params.id; const c = req.body;
  if (!validId(id) || !isObj(c) || !TX_TYPES.includes(c.type) || num(c.amount) == null || !day(c.date)) return res.status(400).json({ error: 'Invalid transaction' });
  c.id = id;
  await pool.query(
    `INSERT INTO transactions (user_id, id, platform_id, type, amount, tx_date, note, data) VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE platform_id=VALUES(platform_id), type=VALUES(type), amount=VALUES(amount), tx_date=VALUES(tx_date), note=VALUES(note), data=VALUES(data)`,
    [req.userId, id, str(c.platform, 40), c.type, num(c.amount), day(c.date), str(c.note, 500), JSON.stringify(c)]);
  res.json({ ok: true });
}));
app.delete('/api/cash/:id', auth, wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid transaction' });
  await pool.query('DELETE FROM transactions WHERE user_id = ? AND id = ?', [req.userId, req.params.id]);
  res.json({ ok: true });
}));

// Weekly notes
app.put('/api/weeks/:week', auth, wrap(async (req, res) => {
  const wk = day(req.params.week);
  if (!wk || !isObj(req.body)) return res.status(400).json({ error: 'Invalid weekly note' });
  await pool.query('INSERT INTO weekly_notes (user_id, week_start, data) VALUES (?,?,?) ON DUPLICATE KEY UPDATE data = VALUES(data)',
    [req.userId, wk, JSON.stringify({ ...req.body, week: wk })]);
  res.json({ ok: true });
}));
app.delete('/api/weeks/:week', auth, wrap(async (req, res) => {
  const wk = day(req.params.week); if (!wk) return res.status(400).json({ error: 'Invalid week' });
  await pool.query('DELETE FROM weekly_notes WHERE user_id = ? AND week_start = ?', [req.userId, wk]);
  res.json({ ok: true });
}));

// ---------- images ----------
const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const month = new Date().toISOString().slice(0, 7);             // e.g. 2026-10
      const dir = path.join(UPLOAD_DIR, String(req.userId), month);
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename(req, file, cb) {
      req.imageId = crypto.randomBytes(16).toString('hex');
      cb(null, req.imageId + MIME_EXT[file.mimetype]);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) { cb(null, !!MIME_EXT[file.mimetype]); },
});

app.post('/api/upload', auth, upload.single('image'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please upload a JPG, PNG, WEBP or GIF image (max 10 MB).' });
  const rel = path.relative(UPLOAD_DIR, req.file.path).split(path.sep).join('/');   // 7/2026-10/abc.jpg
  const url = '/uploads/' + rel;
  await pool.query('INSERT INTO trade_images (id, user_id, file_path, url, mime_type, size_bytes) VALUES (?,?,?,?,?,?)',
    [req.imageId, req.userId, rel, url, req.file.mimetype, req.file.size]);
  res.json({ id: req.imageId, url });
}));

// Images are private: only the owner can open them
app.get('/uploads/:uid/:month/:file', auth, wrap(async (req, res) => {
  const { uid, month, file } = req.params;
  if (String(req.userId) !== uid || !/^\d{4}-\d{2}$/.test(month) || !/^[a-f0-9]{32}\.(jpg|png|webp|gif)$/.test(file)) return res.status(404).end();
  const full = path.join(UPLOAD_DIR, uid, month, file);
  if (!full.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(full)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(full);
}));

async function removeImages(uid, rows) {
  for (const r of rows) {
    const full = path.join(UPLOAD_DIR, r.file_path);
    if (full.startsWith(UPLOAD_DIR + path.sep)) fs.promises.unlink(full).catch(() => {});
    await pool.query('DELETE FROM trade_images WHERE user_id = ? AND id = ?', [uid, r.id]);
  }
}

// Remove images that were uploaded but never attached to a saved trade (older than 1 day)
async function cleanOrphans() {
  try {
    const [rows] = await pool.query('SELECT id, user_id, file_path FROM trade_images WHERE trade_id IS NULL AND created_at < NOW() - INTERVAL 1 DAY LIMIT 500');
    for (const r of rows) await removeImages(r.user_id, [r]);
  } catch (e) { console.error('Image cleanup failed:', e.message); }
}
setInterval(cleanOrphans, 6 * 60 * 60 * 1000).unref();

// ---------- account ----------
app.delete('/api/account', auth, wrap(async (req, res) => {
  const uid = req.userId;
  await pool.query('DELETE FROM users WHERE id = ?', [uid]);               // cascades to all data
  fs.promises.rm(path.join(UPLOAD_DIR, String(uid)), { recursive: true, force: true }).catch(() => {});
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}));

// ---------- frontend ----------
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: PROD ? '1h' : 0 }));
app.get(/^\/(?!api\/|uploads\/).*/, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 10 MB).' : 'Upload failed.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, async () => {
  try { await pool.query('SELECT 1'); console.log('Connected to MySQL.'); }
  catch (e) { console.error('Cannot connect to MySQL:', e.message, '\nCheck DB_* settings in .env and run: npm run db:init'); }
  console.log(`Trade Journal running on http://localhost:${PORT}`);
  cleanOrphans();
});
