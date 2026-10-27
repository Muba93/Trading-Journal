// Trade Journal service worker: makes the site installable as a phone app.
// - Pages: always fetched fresh (so updates show at once); a small "You're offline" page if there's no connection.
// - /vendor/ and /icons/: cached after first use, so the app opens faster.
// - /api/ and /uploads/ are never cached: journal data and screenshots stay private to the logged-in user.
// Bump VERSION when the cached file list changes; old caches are deleted on activate.
const VERSION = 'tj-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => offlinePage()));
    return;
  }
  if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/icons/')) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
  }
});

function offlinePage() {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Trade Journal</title><meta name="theme-color" content="#1e1b4b"></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0e0c22;color:#eeecff;font-family:system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box">
<div><img src="/icons/icon-192.png" width="72" height="72" alt="" style="border-radius:18px">
<h1 style="font-size:22px;margin:18px 0 8px">You're offline</h1>
<p style="color:#a6a2d4;margin:0 0 20px">Trade Journal needs an internet connection to load your journal.</p>
<button onclick="location.reload()" style="border:0;border-radius:12px;padding:12px 22px;font-weight:700;font-size:15px;color:#fff;background:linear-gradient(135deg,#6d28d9,#9333ea)">Try again</button></div>
</body></html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
