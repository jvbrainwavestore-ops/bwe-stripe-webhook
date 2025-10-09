// api/categories.js
// GET  /api/categories?email=...  -> { categories:[...], groupId, limit }
// POST /api/categories { email, categories:[...] }  -> saves (enforces limit by BigCommerce group)
//
// Stores selection inside the BigCommerce customer "notes" field under a tagged line:
// [[BWE_CATEGORIES:focus,sleep]]
//
// Future-proof: change GROUP_LIMITS below when you add new tiers.
// Your existing Stripe webhook still controls which group a buyer belongs to.

export const config = { api: { bodyParser: true } };

// ---- CONFIG: group -> max categories (works TODAY for Intro=2; ready for later) ----
const GROUP_LIMITS = {
  2: 2, // Intro (live today)
  3: 3, // Standard (later)
  4: 4  // Collective (later)
};

// ---- BigCommerce helpers ----
function bcHeaders() {
  return {
    'X-Auth-Client': process.env.BC_CLIENT_ID,
    'X-Auth-Token': process.env.BC_ACCESS_TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}
function bcBaseV3() {
  const hash = (process.env.BC_STORE_HASH || '').trim();
  return `https://api.bigcommerce.com/stores/${hash}/v3`;
}
function bcBaseV2() {
  const hash = (process.env.BC_STORE_HASH || '').trim();
  return `https://api.bigcommerce.com/stores/${hash}/v2`;
}

async function lookupCustomerByEmail(email) {
  const normalized = (email || '').trim().toLowerCase();

  // Try v3 lookup
  try {
    const r = await fetch(`${bcBaseV3()}/customers/lookup`, {
      method: 'POST', headers: bcHeaders(),
      body: JSON.stringify({ emails: [normalized] })
    });
    const txt = await r.text().catch(() => '');
    if (!r.ok) throw new Error(`v3 lookup ${r.status}: ${txt}`);
    const json = JSON.parse(txt || '{}');
    const first = Array.isArray(json?.data)
      ? json.data.find(x => (x?.email || '').toLowerCase() === normalized)
      : null;
    if (first) return first.id;
  } catch (_) { /* fall through */ }

  // Fallback v2 search
  const r2 = await fetch(`${bcBaseV2()}/customers?email=${encodeURIComponent(normalized)}`, {
    method: 'GET', headers: bcHeaders()
  });
  const txt2 = await r2.text().catch(() => '');
  if (!r2.ok) throw new Error(`v2 lookup ${r2.status}: ${txt2}`);
  const arr = JSON.parse(txt2 || '[]');
  const first = Array.isArray(arr)
    ? arr.find(x => (x?.email || '').toLowerCase() === normalized)
    : null;
  return first?.id || null;
}

async function getCustomerById(id) {
  const r = await fetch(`${bcBaseV3()}/customers?id:in=${id}`, { headers: bcHeaders() });
  const txt = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`v3 get ${r.status}: ${txt}`);
  const json = JSON.parse(txt || '{}');
  return Array.isArray(json?.data) ? json.data[0] : null;
}

async function createCustomer(email) {
  const r = await fetch(`${bcBaseV3()}/customers`, {
    method: 'POST', headers: bcHeaders(),
    body: JSON.stringify({ customers: [{ email, first_name: 'Member', last_name: 'Account' }] })
  });
  const txt = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`v3 create ${r.status}: ${txt}`);
  const json = JSON.parse(txt || '{}');
  return Array.isArray(json?.data) ? json.data[0]?.id : null;
}

async function updateCustomerNotes(id, notes) {
  const r = await fetch(`${bcBaseV3()}/customers`, {
    method: 'PUT', headers: bcHeaders(),
    body: JSON.stringify({ customers: [{ id: Number(id), notes }] })
  });
  const txt = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`v3 update ${r.status}: ${txt}`);
}

// ---- encode/decode categories inside notes (non-destructive) ----
const TAG_START = '[[BWE_CATEGORIES:';
const TAG_END = ']]';

function extractCatsFromNotes(notes) {
  const s = String(notes || '');
  const i = s.indexOf(TAG_START);
  if (i === -1) return [];
  const j = s.indexOf(TAG_END, i + TAG_START.length);
  if (j === -1) return [];
  const raw = s.slice(i + TAG_START.length, j).trim();
  return raw ? raw.split(',').map(x => x.trim()).filter(Boolean) : [];
}
function setCatsInNotes(prevNotes, cats) {
  const s = String(prevNotes || '');
  const tag = `${TAG_START}${cats.join(',')}${TAG_END}`;
  const i = s.indexOf(TAG_START);
  if (i === -1) return (s ? s + '\n' : '') + tag;
  const j = s.indexOf(TAG_END, i + TAG_START.length);
  if (j === -1) return (s ? s + '\n' : '') + tag;
  return s.slice(0, i) + tag + s.slice(j + TAG_END.length);
}

function limitForGroup(groupId) {
  return GROUP_LIMITS[Number(groupId)] || 2; // default to 2 if unknown
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const email = (req.query?.email || '').trim();
      if (!email) return res.status(400).json({ error: 'Missing email' });

      const id = await lookupCustomerByEmail(email);
      if (!id) return res.status(200).json({ categories: [], groupId: 0, limit: 2 });

      const cust = await getCustomerById(id);
      const groupId = Number(cust?.customer_group_id || 0);
      const cats = extractCatsFromNotes(cust?.notes || '');
      const limit = limitForGroup(groupId);

      return res.status(200).json({ categories: cats, groupId, limit });
    }

    if (req.method === 'POST') {
      const email = (req.body?.email || '').trim();
      let cats = Array.isArray(req.body?.categories) ? req.body.categories : [];
      if (!email) return res.status(400).json({ error: 'Missing email' });

      let id = await lookupCustomerByEmail(email);
      if (!id) id = await createCustomer(email);
      if (!id) return res.status(500).json({ error: 'Could not resolve or create customer' });

      const cust = await getCustomerById(id);
      const groupId = Number(cust?.customer_group_id || 0);
      const limit = limitForGroup(groupId);

      // Enforce limit for the member’s group
      cats = cats.map(c => String(c || '').trim().toLowerCase()).filter(Boolean);
      const unique = Array.from(new Set(cats));
      if (unique.length !== limit) {
        return res.status(400).json({ error: `Your plan allows exactly ${limit} categories`, groupId, limit });
      }

      const newNotes = setCatsInNotes(cust?.notes || '', unique);
      await updateCustomerNotes(id, newNotes);

      return res.status(200).json({ ok: true, categories: unique, groupId, limit });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    console.error('categories endpoint error:', e);
    return res.status(500).json({ error: e.message || 'server error' });
  }
}
