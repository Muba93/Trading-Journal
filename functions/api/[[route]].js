// All /api/* requests: login, journal data, image uploads.
// Bindings (set in Cloudflare Pages -> Settings -> Bindings):
//   DB      -> D1 database
//   IMAGES  -> R2 bucket
//   GOOGLE_CLIENT_ID (optional variable) -> enables "Continue with Google"
import {
  json, fail, randHex, hashPassword, verifyPassword, createSession, endSession, currentUserId,
  num, str, dt, day, validId, isObj, parse,
} from '../../lib/core.js';

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const TX_TYPES = ['deposit', 'withdrawal', 'fee', 'payout', 'refund'];
const MAX_IMAGE = 10 * 1024 * 1024;

export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const path = '/' + [].concat(params.route || []).join('/');
  const m = req.method;
  try {
    if (!env.DB) return fail('Database not connected: add a D1 binding named DB in Cloudflare Pages settings.', 500);

    // ----- public routes -----
    if (path === '/config' && m === 'GET') return json({ googleClientId: env.GOOGLE_CLIENT_ID || null });
    if (path === '/auth/register' && m === 'POST') return register(req, env);
    if (path === '/auth/login' && m === 'POST') return login(req, env);
    if (path === '/auth/google' && m === 'POST') return googleLogin(req, env);
    if (path === '/auth/logout' && m === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': await endSession(env, req) });

    // ----- everything below needs a login -----
    const uid = await currentUserId(env, req);
    if (!uid) return fail('Please log in', 401);

    if (path === '/auth/me' && m === 'GET') {
      const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first();
      return u ? json({ user: publicUser(u) }) : fail('Please log in', 401);
    }
    if (path === '/data' && m === 'GET') return loadAll(env, uid);
    if (path === '/settings' && m === 'PUT') {
      const body = await req.json().catch(() => null);
      if (!isObj(body)) return fail('Invalid settings');
      await env.DB.prepare(`INSERT INTO settings (user_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`).bind(uid, JSON.stringify(body)).run();
      return json({ ok: true });
    }
    if (path === '/upload' && m === 'POST') return uploadImage(req, env, uid);
    if (path === '/candles' && m === 'GET') return candles(req, env, ctx);
    if (path === '/news' && m === 'GET') return news(ctx);
    if (path === '/account' && m === 'DELETE') return deleteAccount(req, env, uid);

    const [, kind, key] = path.split('/'); // e.g. /trades/abc123
    if (kind === 'trades' && key && m === 'PUT') return saveTrade(req, env, uid, key);
    if (kind === 'trades' && key && m === 'DELETE') return deleteTrade(env, uid, key);
    if (kind === 'cash' && key && m === 'PUT') return saveCash(req, env, uid, key);
    if (kind === 'cash' && key && m === 'DELETE') {
      if (!validId(key)) return fail('Invalid transaction');
      await env.DB.prepare('DELETE FROM transactions WHERE user_id = ? AND id = ?').bind(uid, key).run();
      return json({ ok: true });
    }
    if (kind === 'weeks' && key && m === 'PUT') return saveWeek(req, env, uid, key);
    if (kind === 'weeks' && key && m === 'DELETE') {
      const wk = day(key); if (!wk) return fail('Invalid week');
      await env.DB.prepare('DELETE FROM weekly_notes WHERE user_id = ? AND week_start = ?').bind(uid, wk).run();
      return json({ ok: true });
    }
    return fail('Not found', 404);
  } catch (e) {
    console.error(e);
    return fail('Something went wrong on the server.', 500);
  }
}

// ---------- auth ----------
function publicUser(u) { return { id: u.id, email: u.email, name: u.name, hasPassword: !!u.password_hash, google: !!u.google_id }; }

async function tooManyAttempts(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const since = Date.now() - 15 * 60 * 1000;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ? AND ts > ?').bind(ip, since).first();
  await env.DB.prepare('INSERT INTO auth_attempts (ip, ts) VALUES (?, ?)').bind(ip, Date.now()).run();
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM auth_attempts WHERE ts < ?').bind(since).run();
  return (row?.n || 0) >= 30;
}
const LIMIT_MSG = 'Too many attempts. Please wait a few minutes and try again.';

async function register(req, env) {
  if (await tooManyAttempts(req, env)) return fail(LIMIT_MSG, 429);
  const b = (await req.json().catch(() => null)) || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) return fail('Please enter a valid email address.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  if (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()) return fail('An account with this email already exists. Please log in.', 409);
  const hash = await hashPassword(password);
  const r = await env.DB.prepare('INSERT INTO users (email, name, password_hash, last_login_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
    .bind(email, str(b.name, 120), hash).run();
  const id = r.meta.last_row_id;
  return json({ user: { id, email, name: str(b.name, 120), hasPassword: true, google: false } }, 200, { 'Set-Cookie': await createSession(env, req, id) });
}

async function login(req, env) {
  if (await tooManyAttempts(req, env)) return fail(LIMIT_MSG, 429);
  const b = (await req.json().catch(() => null)) || {};
  const email = String(b.email || '').trim().toLowerCase();
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (u && !u.password_hash) return fail('This account uses Google sign-in. Please continue with Google.');
  if (!u || !(await verifyPassword(String(b.password || ''), u.password_hash))) return fail('Wrong email or password.', 401);
  await env.DB.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').bind(u.id).run();
  return json({ user: publicUser(u) }, 200, { 'Set-Cookie': await createSession(env, req, u.id) });
}

async function googleLogin(req, env) {
  if (!env.GOOGLE_CLIENT_ID) return fail('Google sign-in is not enabled.');
  if (await tooManyAttempts(req, env)) return fail(LIMIT_MSG, 429);
  const b = (await req.json().catch(() => null)) || {};
  // Google checks the signature for us and returns the token's contents
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(b.credential || '')));
  const p = r.ok ? await r.json() : null;
  if (!p || p.aud !== env.GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(p.iss)) return fail('Google sign-in failed. Please try again.', 401);
  if (!p.email || String(p.email_verified) !== 'true') return fail('Your Google email is not verified.', 401);
  const email = p.email.toLowerCase();
  let u = await env.DB.prepare('SELECT * FROM users WHERE google_id = ?').bind(p.sub).first();
  if (!u) {
    u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (u) await env.DB.prepare('UPDATE users SET google_id = ? WHERE id = ?').bind(p.sub, u.id).run(); // link existing account
    else {
      const ins = await env.DB.prepare('INSERT INTO users (email, name, google_id) VALUES (?, ?, ?)').bind(email, str(p.name, 120), p.sub).run();
      u = { id: ins.meta.last_row_id, email, name: p.name || null, password_hash: null };
    }
    u.google_id = p.sub;
  }
  await env.DB.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').bind(u.id).run();
  return json({ user: publicUser(u) }, 200, { 'Set-Cookie': await createSession(env, req, u.id) });
}

// ---------- journal data ----------
async function loadAll(env, uid) {
  const [s, tr, tx, wk] = await env.DB.batch([
    env.DB.prepare('SELECT data FROM settings WHERE user_id = ?').bind(uid),
    env.DB.prepare('SELECT id, data FROM trades WHERE user_id = ?').bind(uid),
    env.DB.prepare('SELECT id, data FROM transactions WHERE user_id = ?').bind(uid),
    env.DB.prepare('SELECT week_start, data FROM weekly_notes WHERE user_id = ?').bind(uid),
  ]);
  const trades = {}; tr.results.forEach((r) => { trades[r.id] = parse(r.data); });
  const cash = {}; tx.results.forEach((r) => { cash[r.id] = parse(r.data); });
  const weeks = {}; wk.results.forEach((r) => { weeks[r.week_start] = parse(r.data); });
  return json({ settings: s.results[0] ? parse(s.results[0].data) : null, trades, cash, weeks });
}

async function saveTrade(req, env, uid, id) {
  const t = await req.json().catch(() => null);
  if (!validId(id) || !isObj(t)) return fail('Invalid trade');
  t.id = id;
  const dir = t.dir === 'Short' ? 'Short' : t.dir === 'Long' ? 'Long' : null;
  const rating = num(t.rating);
  await env.DB.prepare(
    `INSERT INTO trades (user_id, id, pair, direction, platform_id, entry_at, exit_at, timezone, entry_price, exit_price, lot_size,
       sl_initial, tp_initial, sl_final, tp_final, fees, pnl_override, rating, data, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, id) DO UPDATE SET pair=excluded.pair, direction=excluded.direction, platform_id=excluded.platform_id,
       entry_at=excluded.entry_at, exit_at=excluded.exit_at, timezone=excluded.timezone, entry_price=excluded.entry_price,
       exit_price=excluded.exit_price, lot_size=excluded.lot_size, sl_initial=excluded.sl_initial, tp_initial=excluded.tp_initial,
       sl_final=excluded.sl_final, tp_final=excluded.tp_final, fees=excluded.fees, pnl_override=excluded.pnl_override,
       rating=excluded.rating, data=excluded.data, updated_at=CURRENT_TIMESTAMP`)
    .bind(uid, id, str(t.pair, 20), dir, str(t.platform, 40), dt(t.entryAt), dt(t.exitAt), num(t.tz), num(t.entry), num(t.exit), num(t.lot),
      num(t.sl0), num(t.tp0), num(t.slF), num(t.tpF), num(t.fees), num(t.pnlOverride), rating ? Math.min(10, Math.max(0, rating)) : null, JSON.stringify(t))
    .run();

  // Link uploaded images to this trade; remove images this trade no longer uses
  const keep = [];
  for (const [field, kind] of [['imgBefore', 'before'], ['imgAfter', 'after']]) {
    const img = t[field];
    if (img && /^[a-f0-9]{32}$/.test(img.id || '')) {
      keep.push(img.id);
      await env.DB.prepare('UPDATE trade_images SET trade_id = ?, kind = ? WHERE user_id = ? AND id = ?').bind(id, kind, uid, img.id).run();
    }
  }
  const q = `SELECT id, file_path FROM trade_images WHERE user_id = ? AND trade_id = ?${keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : ''}`;
  const old = await env.DB.prepare(q).bind(uid, id, ...keep).all();
  await removeImages(env, uid, old.results);
  return json({ ok: true });
}

async function deleteTrade(env, uid, id) {
  if (!validId(id)) return fail('Invalid trade');
  const imgs = await env.DB.prepare('SELECT id, file_path FROM trade_images WHERE user_id = ? AND trade_id = ?').bind(uid, id).all();
  await removeImages(env, uid, imgs.results);
  await env.DB.prepare('DELETE FROM trades WHERE user_id = ? AND id = ?').bind(uid, id).run();
  return json({ ok: true });
}

async function saveCash(req, env, uid, id) {
  const c = await req.json().catch(() => null);
  if (!validId(id) || !isObj(c) || !TX_TYPES.includes(c.type) || num(c.amount) == null || !day(c.date)) return fail('Invalid transaction');
  c.id = id;
  await env.DB.prepare(`INSERT INTO transactions (user_id, id, platform_id, type, amount, tx_date, note, data, updated_at)
      VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, id) DO UPDATE SET platform_id=excluded.platform_id, type=excluded.type, amount=excluded.amount,
        tx_date=excluded.tx_date, note=excluded.note, data=excluded.data, updated_at=CURRENT_TIMESTAMP`)
    .bind(uid, id, str(c.platform, 40), c.type, num(c.amount), day(c.date), str(c.note, 500), JSON.stringify(c)).run();
  return json({ ok: true });
}

async function saveWeek(req, env, uid, key) {
  const wk = day(key); const b = await req.json().catch(() => null);
  if (!wk || !isObj(b)) return fail('Invalid weekly note');
  await env.DB.prepare(`INSERT INTO weekly_notes (user_id, week_start, data, updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, week_start) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP`)
    .bind(uid, wk, JSON.stringify({ ...b, week: wk })).run();
  return json({ ok: true });
}

// ---------- images (R2) ----------
async function uploadImage(req, env, uid) {
  if (!env.IMAGES) return fail('Image storage not connected: add an R2 binding named IMAGES in Cloudflare Pages settings.', 500);
  const form = await req.formData().catch(() => null);
  const file = form && form.get('image');
  if (!file || typeof file === 'string' || !MIME_EXT[file.type]) return fail('Please upload a JPG, PNG, WEBP or GIF image (max 10 MB).');
  if (file.size > MAX_IMAGE) return fail('Image is too large (max 10 MB).');
  const id = randHex(16);
  const month = new Date().toISOString().slice(0, 7);          // e.g. 2026-10
  const key = `${uid}/${month}/${id}${MIME_EXT[file.type]}`;   // folder per user and month
  await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  const url = '/uploads/' + key;
  await env.DB.prepare('INSERT INTO trade_images (id, user_id, file_path, url, mime_type, size_bytes) VALUES (?,?,?,?,?,?)')
    .bind(id, uid, key, url, file.type, file.size).run();
  // remove this user's images that were uploaded but never attached to a saved trade (older than 1 day)
  const orphans = await env.DB.prepare(`SELECT id, file_path FROM trade_images WHERE user_id = ? AND trade_id IS NULL AND created_at < datetime('now','-1 day') LIMIT 50`).bind(uid).all();
  await removeImages(env, uid, orphans.results);
  return json({ id, url });
}

async function removeImages(env, uid, rows) {
  if (!rows || !rows.length) return;
  if (env.IMAGES) await env.IMAGES.delete(rows.map((r) => r.file_path));
  await env.DB.batch(rows.map((r) => env.DB.prepare('DELETE FROM trade_images WHERE user_id = ? AND id = ?').bind(uid, r.id)));
}

async function deleteAccount(req, env, uid) {
  if (env.IMAGES) {
    let cursor;
    do {
      const list = await env.IMAGES.list({ prefix: `${uid}/`, cursor });
      if (list.objects.length) await env.IMAGES.delete(list.objects.map((o) => o.key));
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }
  await env.DB.batch(['trade_images', 'trades', 'transactions', 'weekly_notes', 'settings', 'sessions']
    .map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(uid))
    .concat(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid)));
  return json({ ok: true }, 200, { 'Set-Cookie': await endSession(env, req) });
}

// ---------- price data for the Chart tab (Twelve Data, cached at Cloudflare) ----------
const INTERVALS = { M1: '1min', M5: '5min', M15: '15min', M30: '30min', H1: '1h', H4: '4h', D1: '1day' };
async function candles(req, env, ctx) {
  const apiKey = env.TWELVEDATA_API_KEY;
  if (!apiKey) return json({ error: 'Chart data is not set up yet.', code: 'no_key' }, 503);
  const u = new URL(req.url);
  const symbol = String(u.searchParams.get('symbol') || '').trim();
  const interval = INTERVALS[u.searchParams.get('tf') || 'M15'];
  const end = u.searchParams.get('end');                      // optional, UTC 'YYYY-MM-DD HH:MM:SS'
  if (!/^[A-Za-z0-9/._:-]{2,20}$/.test(symbol)) return fail('Invalid symbol');
  if (!interval) return fail('Invalid timeframe');
  if (end && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(end)) return fail('Invalid end date');

  const params = new URLSearchParams({ symbol, interval, outputsize: '500', timezone: 'UTC', order: 'ASC' });
  if (end) params.set('end_date', end);
  const cacheKey = new Request('https://candles.cache/v1?' + params.toString());
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=30', 'X-Cache': 'HIT' } });

  params.set('apikey', apiKey);
  const r = await fetch('https://api.twelvedata.com/time_series?' + params.toString());
  const j = await r.json().catch(() => null);
  if (!j || j.status === 'error' || !Array.isArray(j.values)) {
    const msg = (j && j.message) || 'The price data provider did not respond.';
    return json({ error: msg, code: j && j.code === 429 ? 'rate_limited' : 'provider' }, j && j.code === 429 ? 429 : 502);
  }
  const bars = j.values.map((v) => {
    const d = String(v.datetime || '');
    const t = Date.parse((d.length === 10 ? d + 'T00:00:00' : d.replace(' ', 'T')) + 'Z') / 1000;
    return { t, o: +v.open, h: +v.high, l: +v.low, c: +v.close };
  }).filter((b) => Number.isFinite(b.t) && Number.isFinite(b.o) && Number.isFinite(b.c)).sort((a, b) => a.t - b.t);
  const body = JSON.stringify({ symbol, interval, bars });
  // live data: cache 60 s; history (with end date in the past): cache 1 day
  const ttl = end && Date.parse(end.replace(' ', 'T') + 'Z') < Date.now() - 3600e3 ? 86400 : 60;
  ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } })));
  return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=30', 'X-Cache': 'MISS' } });
}

// ---------- economic calendar for the dashboard (Forex Factory weekly feed, cached 1 hour) ----------
const NEWS_FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'];
async function news(ctx) {
  const cache = caches.default;
  const events = []; let ok = false;
  for (const url of NEWS_FEEDS) {
    const key = new Request('https://news.cache/v1/' + encodeURIComponent(url));
    let res = await cache.match(key);
    if (!res) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'TradeJournal/1.0 (personal trading journal)' } });
        if (r.ok) {
          const text = await r.text();
          res = new Response(text, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
          ctx.waitUntil(cache.put(key, res.clone()));
        }
      } catch (e) { /* feed unreachable: try the next one */ }
    }
    if (!res) continue;
    const arr = await res.json().catch(() => null);
    if (!Array.isArray(arr)) continue;
    ok = true;
    for (const e of arr) {
      const t = Date.parse(e.date);
      if (!Number.isFinite(t)) continue;
      events.push({
        title: String(e.title || '').slice(0, 120),
        currency: String(e.country || '').toUpperCase().slice(0, 4),
        t,
        impact: String(e.impact || ''),          // High / Medium / Low / Holiday
        forecast: String(e.forecast || ''),
        previous: String(e.previous || ''),
      });
    }
  }
  if (!ok) return json({ error: 'The news calendar is not available right now. Please try again later.', code: 'feed' }, 502);
  const seen = new Set();
  const list = events.filter((e) => { const k = e.currency + e.t + e.title; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.t - b.t);
  return json({ events: list, source: 'Forex Factory', fetchedAt: Date.now() }, 200, { 'Cache-Control': 'private, max-age=300' });
}
