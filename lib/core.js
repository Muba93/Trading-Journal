// Shared helpers for the Cloudflare Pages Functions
const enc = new TextEncoder();

export const COOKIE = 'tj_session';
export const SESSION_DAYS = 30;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
export const fail = (message, status = 400, headers = {}) => json({ error: message }, status, headers);

export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const randHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
export async function sha256(text) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))); }

// ---------- passwords (PBKDF2-SHA256, built into Workers) ----------
// Stored as: pbkdf2$<iterations>$<salt>$<hash>. Raise ITERATIONS if you are on a paid Workers plan.
const ITERATIONS = 50000;
export async function hashPassword(password, salt = randHex(16), iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256);
  return `pbkdf2$${iterations}$${salt}$${hex(bits)}`;
}
export async function verifyPassword(password, stored) {
  const [alg, iter, salt] = String(stored || '').split('$');
  if (alg !== 'pbkdf2' || !salt) return false;
  const again = await hashPassword(password, salt, Number(iter));
  if (again.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < again.length; i++) diff |= again.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

// ---------- sessions ----------
export function cookies(req) {
  const out = {};
  (req.headers.get('Cookie') || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function cookieHeader(req, value, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
export async function createSession(env, req, userId) {
  const token = randHex(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), userId, expires).run();
  // tidy up expired sessions now and then
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()).run();
  return cookieHeader(req, token, SESSION_DAYS * 86400);
}
export async function endSession(env, req) {
  const token = cookies(req)[COOKIE];
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return cookieHeader(req, '', 0);
}
export async function currentUserId(env, req) {
  const token = cookies(req)[COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await env.DB.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').bind(await sha256(token)).first();
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return row.user_id;
}

// ---------- small validators ----------
export const num = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
export const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
export const dt = (v) => { const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/); return m ? `${m[1]} ${m[2]}:00` : null; };
export const day = (v) => { const m = String(v || '').match(/^\d{4}-\d{2}-\d{2}$/); return m ? m[0] : null; };
export const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
export const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
