// Serves chart images from R2. Images are private: only the logged-in owner can open them.
import { currentUserId } from '../../lib/core.js';

export async function onRequestGet({ request, env, params }) {
  const parts = [].concat(params.path || []);
  const [uid, month, file] = parts;
  if (parts.length !== 3 || !/^\d+$/.test(uid || '') || !/^\d{4}-\d{2}$/.test(month || '') || !/^[a-f0-9]{32}\.(jpg|png|webp|gif)$/.test(file || '')) {
    return new Response('Not found', { status: 404 });
  }
  if (!env.DB || !env.IMAGES) return new Response('Storage not connected', { status: 500 });
  const me = await currentUserId(env, request);
  if (!me || String(me) !== uid) return new Response('Not found', { status: 404 });
  const obj = await env.IMAGES.get(`${uid}/${month}/${file}`);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
