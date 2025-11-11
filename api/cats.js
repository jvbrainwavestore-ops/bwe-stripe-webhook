// /api/cats.js
// Shim for frontend calling /api/cats with key="email::groupId".
// Proxies to /api/categories, adds permissive CORS, and provides an admin URL-setter.

export const config = { api: { bodyParser: true } };

function allowCORS(res) {
  // You can hardcode your store origin later if you want:
  // res.setHeader('Access-Control-Allow-Origin', 'https://www.brainwaveentrainmentstore.net');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
}

function emailFromKey(key) {
  const s = String(key || '').trim();
  return (s.split('::')[0] || '').trim().toLowerCase();
}

export default async function handler(req, res) {
  allowCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const base = `https://${req.headers.host}`;

    // --- GET helper: admin URL-setter (no console; one-time seeding/override) ---
    // Usage:
    //   /api/cats?set=1&admin=YOUR_ADMIN_CATS_KEY&key=user@example.com::2&cats=isochiral%20affirmations,isochiral%20music
    if (req.method === 'GET' && String(req.query?.set || '') === '1') {
      const incoming = String(req.query?.admin || '').trim();
      const adminKey = String(process.env.ADMIN_CATS_KEY || '').trim();
      if (!adminKey || incoming !== adminKey) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const key = String(req.query?.key || '').trim();
      const email = emailFromKey(key);
      const catsRaw = String(req.query?.cats || '').trim();
      const categories = catsRaw
        ? catsRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : [];

      if (!email || !categories.length) {
        return res.status(400).json({ error: 'Missing email or categories' });
      }

      // Forward as admin POST to /api/categories (respects write-once with admin override)
      const r = await fetch(`${base}/api/categories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Admin-Key': adminKey
        },
        body: JSON.stringify({ email, categories })
      });
      const txt = await r.text().catch(() => '');
      if (!r.ok) return res.status(r.status).send(txt || 'Error');
      const j = JSON.parse(txt || '{}');
      return res.status(200).json({ ok: true, categories: j.categories || [] });
    }

    // --- GET reader: returns { categories: [...] } for key=email::groupId ---
    if (req.method === 'GET') {
      const key = (req.query?.key || '').trim();
      const email = emailFromKey(key);
      if (!email) return res.status(200).json({ categories: [] });

      const r = await fetch(`${base}/api/categories?email=${encodeURIComponent(email)}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      const txt = await r.text().catch(() => '');
      if (!r.ok) return res.status(200).json({ categories: [] });

      const j = JSON.parse(txt || '{}');
      return res.status(200).json({ categories: Array.isArray(j.categories) ? j.categories : [] });
    }

    // --- POST writer: proxy to /api/categories (passes optional X-Admin-Key through) ---
    if (req.method === 'POST') {
      const key = (req.body?.key || '').trim();
      const email = emailFromKey(key);
      const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
      if (!email) return res.status(400).json({ error: 'Missing email in key' });

      const adminKey = req.headers['x-admin-key'] || '';

      const r = await fetch(`${base}/api/categories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Admin-Key': String(adminKey)
        },
        body: JSON.stringify({ email, categories })
      });
      const txt = await r.text().catch(() => '');
      if (!r.ok) return res.status(r.status).send(txt || 'Error');

      const j = JSON.parse(txt || '{}');
      return res.status(200).json({ ok: true, categories: j.categories || [] });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    console.error('cats shim error:', e);
    return res.status(200).json({ categories: [] });
  }
}
