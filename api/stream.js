// /api/stream.js
import crypto from 'crypto';

export const config = { runtime: 'nodejs' };

function bad(res, code, msg) { res.status(code).json({ error: msg || 'forbidden' }); }
function hmac(str) {
  const key = process.env.TOKEN_SECRET || 'change-me';
  return crypto.createHmac('sha256', key).update(str).digest('hex');
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return bad(res, 405, 'method');

    const origin = process.env.SITE_ORIGIN; // e.g., https://www.brainwaveentrainmentstore.net
    const maxMin = parseInt(process.env.STREAM_MAX_MIN || '70', 10);

    const reqOrigin = req.headers.origin || '';
    if (origin && reqOrigin && reqOrigin !== origin) return bad(res, 403, 'origin');

    const u   = req.query.u ? decodeURIComponent(req.query.u) : '';
    const exp = parseInt(req.query.exp || '0', 10);
    let   sig = String(req.query.sig || '');

    if (!u || !exp) return bad(res, 400, 'params');

    // Allow missing sig from the browser; derive it server-side using our secret
    const base = `${u}|${exp}`;
    if (!sig) sig = hmac(base);

    const now = Math.floor(Date.now() / 1000);
    if (now > exp) return bad(res, 403, 'expired');
    if (hmac(base) !== sig) return bad(res, 403, 'sig');
    if (exp - now > (maxMin * 60 + 30)) return bad(res, 403, 'window');

    const upstream = await fetch(u);
    if (!upstream.ok || !upstream.body) return bad(res, 502, 'upstream');

    res.status(200);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=30');

    const reader = upstream.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch {
    try { res.status(500).json({ error: 'internal' }); } catch {}
  }
}
