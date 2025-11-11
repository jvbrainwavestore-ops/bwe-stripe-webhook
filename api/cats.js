// /api/cats.js
// Shim for frontend calling /api/cats with key="email::groupId".
// Proxies to /api/categories and adds permissive CORS so the store can call it.

export const config = { api: { bodyParser: true } };

function allowCORS(res) {
  // You can hardcode your store origin if you prefer:
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
