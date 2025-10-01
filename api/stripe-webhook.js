// Vercel Serverless Function: Stripe → BigCommerce (Intro -> group 2)
import Stripe from 'stripe';

// Keep raw body for Stripe signature verification
export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2024-06-20' });

// Helper: read raw body (required for Stripe signature verification)
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

// ---------- BC HELPERS ----------
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
  const url = `https://api.bigcommerce.com/stores/${hash}/v3`;
  console.log('BC v3 base URL:', url);
  return url;
}
function bcBaseV2() {
  const hash = (process.env.BC_STORE_HASH || '').trim();
  const url = `https://api.bigcommerce.com/stores/${hash}/v2`;
  console.log('BC v2 base URL:', url);
  return url;
}

// Lookup by email (try v3 /customers/lookup, fall back to v2 /customers?email=)
async function lookupBcCustomerIdByEmail(email) {
  const normalized = (email || '').trim().toLowerCase();

  // Try v3
  try {
    const url = `${bcBaseV3()}/customers/lookup`;
    const res = await fetch(url, { method: 'POST', headers: bcHeaders(), body: JSON.stringify({ emails: [normalized] }) });
    const txt = await res.text().catch(() => '');
    if (res.status === 404) {
      console.warn('BC v3 /customers/lookup returned 404; will try v2 fallback.');
      throw new Error('__TRY_V2__');
    }
    if (!res.ok) throw new Error(`BC v3 lookup failed (${res.status}): ${txt}`);
    let json = {};
    try { json = JSON.parse(txt); } catch {}
    const first = Array.isArray(json?.data) ? json.data.find(r => (r?.email || '').toLowerCase() === normalized) : null;
    return first?.id || null;
  } catch (e) {
    if (e.message !== '__TRY_V2__') console.warn('v3 lookup error:', e.message);
    // Fallback: v2
    const url2 = `${bcBaseV2()}/customers?email=${encodeURIComponent(normalized)}`;
    const res2 = await fetch(url2, { method: 'GET', headers: bcHeaders() });
    const txt2 = await res2.text().catch(() => '');
    if (!res2.ok) throw new Error(`BC v2 lookup failed (${res2.status}): ${txt2}`);
    let arr = [];
    try { arr = JSON.parse(txt2); } catch {}
    const first = Array.isArray(arr) ? arr.find(r => (r?.email || '').toLowerCase() === normalized) : null;
    return first?.id || null;
  }
}

// Create a BC customer (prefer v3; fall back to v2). Optionally apply group at creation.
async function createBcCustomer({ email, firstName = 'Member', lastName = 'Account', groupId = null }) {
  const normalized = (email || '').trim().toLowerCase();

  // Attempt v3 create (can set customer_group_id at create)
  try {
    const payloadV3 = {
      customers: [{
        email: normalized,
        first_name: firstName || 'Member',
        last_name: lastName || 'Account',
        ...(groupId ? { customer_group_id: Number(groupId) } : {})
      }]
    };
    const res = await fetch(`${bcBaseV3()}/customers`, {
      method: 'POST', headers: bcHeaders(), body: JSON.stringify(payloadV3)
    });
    const txt = await res.text().catch(() => '');
    if (!res.ok) {
      console.warn(`BC v3 create failed (${res.status}): ${txt}`);
      // v3 validation/route issues? fall back to v2
      throw new Error('__TRY_V2_CREATE__');
    }
    let json = {};
    try { json = JSON.parse(txt); } catch {}
    const id = Array.isArray(json?.data) ? json.data[0]?.id : null;
    if (!id) throw new Error('BC v3 create returned no id');
    return { id, groupAppliedAtCreate: Boolean(groupId) };
  } catch (e) {
    if (e.message !== '__TRY_V2_CREATE__') console.warn('v3 create error:', e.message);
  }

  // Fallback: v2 create (minimal fields)
  const payloadV2 = {
    email: normalized,
    first_name: firstName || 'Member',
    last_name: lastName || 'Account'
  };
  const res2 = await fetch(`${bcBaseV2()}/customers`, {
    method: 'POST', headers: bcHeaders(), body: JSON.stringify(payloadV2)
  });
  const txt2 = await res2.text().catch(() => '');
  if (!res2.ok) throw new Error(`BC v2 create failed (${res2.status}): ${txt2}`);
  let json2 = {};
  try { json2 = JSON.parse(txt2); } catch {}
  const id2 = json2?.id || (Array.isArray(json2?.data) ? json2.data[0]?.id : null);
  if (!id2) throw new Error('BC v2 create returned no id');
  return { id: id2, groupAppliedAtCreate: false };
}

// UPDATED: assign customer group with PATCH (single) → fallback to PUT (array)
async function setBcCustomerGroup(customerId, groupId) {
  const headers = bcHeaders();
  const v3 = bcBaseV3();

  // 1) Preferred: single-customer endpoint with PATCH (object body)
  try {
    const url = `${v3}/customers/${Number(customerId)}`;
    const body = JSON.stringify({ customer_group_id: Number(groupId) });
    const res = await fetch(url, { method: 'PATCH', headers, body });
    const txt = await res.text().catch(() => '');
    if (res.ok) {
      // Some stores return 204 No Content; if there is a body, we can sanity-check it.
      if (txt) {
        try {
          const json = JSON.parse(txt);
          if (json?.data?.customer_group_id && Number(json.data.customer_group_id) !== Number(groupId)) {
            throw new Error(`BC PATCH returned different group: ${json.data.customer_group_id}`);
          }
        } catch { /* ignore parse issues if not JSON */ }
      }
      return; // success
    }
    // If BC complains about expecting array, fall through to array PUT
    const mustUseArray = res.status === 422 || /array/i.test(txt || '');
    if (!mustUseArray) {
      throw new Error(`BC group PATCH failed (${res.status}): ${txt}`);
    }
  } catch (e) {
    // Proceed to fallback
    console.warn('PATCH group failed or not supported, trying bulk PUT:', e.message);
  }

  // 2) Fallback: bulk endpoint with PUT (array body)
  const url2 = `${v3}/customers`;
  const body2 = JSON.stringify({
    customers: [{ id: Number(customerId), customer_group_id: Number(groupId) }]
  });
  const res2 = await fetch(url2, { method: 'PUT', headers, body: body2 });
  const txt2 = await res2.text().catch(() => '');
  if (!res2.ok) throw new Error(`BC group PUT failed (${res2.status}): ${txt2}`);
}
// ---------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // 1) Verify Stripe signature with RAW body
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  // 2) Collect price IDs + purchaser email (handle both new & old shapes)
  const foundPriceIds = new Set();
  const type = event.type;

  async function collectFromSession(sessionId) {
    try {
      const s = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price.product'] });
      (s.line_items?.data || []).forEach(li => {
        const pidNew = li?.pricing?.price_details?.price;
        const pidOld = li?.price?.id;
        if (pidNew) foundPriceIds.add(pidNew);
        if (pidOld) foundPriceIds.add(pidOld);
      });
      return s;
    } catch (e) {
      console.error('Session retrieve failed', e);
      return null;
    }
  }

  function collectFromInvoice(invoice) {
    (invoice.lines?.data || []).forEach(li => {
      const pidNew = li?.pricing?.price_details?.price;
      const pidOld = li?.price?.id;
      if (pidNew) foundPriceIds.add(pidNew);
      if (pidOld) foundPriceIds.add(pidOld);
    });
  }

  let email = null;
  let fullName = '';

  if (type === 'checkout.session.completed') {
    const s = await collectFromSession(event.data.object.id);
    email = s?.customer_details?.email || s?.customer_email || null;
    fullName = s?.customer_details?.name || '';
    if (!email && s?.customer) {
      try { const c = await stripe.customers.retrieve(s.customer); email = c?.email || null; fullName = fullName || c?.name || ''; } catch {}
    }
  } else if (type === 'invoice.payment_succeeded') {
    const inv = event.data.object;
    collectFromInvoice(inv);
    email = inv?.customer_email || inv?.customer_details?.email || null;
    if (inv?.customer) {
      try { const c = await stripe.customers.retrieve(inv.customer); fullName = fullName || c?.name || ''; if (!email) email = c?.email || null; } catch {}
    }
  } else {
    // Ignore other events
    res.status(200).json({ ok: true, ignored: type });
    return;
  }

  if (!email) {
    console.warn('⚠️ No purchaser email on event; skipping');
    res.status(200).json({ ok: true });
    return;
  }

  // 3) Map Stripe Price IDs → BigCommerce group id via JSON env
  let map = {};
  try { map = JSON.parse(process.env.PRICE_TO_GROUP_MAP || '{}'); } catch {}
  let targetGroupId = null;
  for (const pid of foundPriceIds) {
    if (pid && map[pid]) { targetGroupId = map[pid]; break; }
  }
  console.log(`Prices in event: ${[...foundPriceIds].join(', ') || '(none)'} → target group: ${targetGroupId ?? '(none)'} for ${email}`);

  // 4) Upsert customer in BigCommerce and set group
  try {
    // Split name safely (fallbacks for stores that require names)
    const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || 'Member';
    const lastName  = parts.slice(1).join(' ') || 'Account';

    // A) Lookup by email (v3→v2)
    let bcCustomerId = await lookupBcCustomerIdByEmail(email);

    // B) Create if missing (v3 create→v2 create). If we know the group, try to set it at create time.
    let groupAppliedAtCreate = false;
    if (!bcCustomerId) {
      const created = await createBcCustomer({ email, firstName, lastName, groupId: targetGroupId || null });
      bcCustomerId = created.id;
      groupAppliedAtCreate = created.groupAppliedAtCreate;
      console.log(`✅ Created BC customer ${bcCustomerId} for ${email} (group at create: ${groupAppliedAtCreate})`);
    } else {
      console.log(`ℹ️ Found BC customer ${bcCustomerId} for ${email}`);
    }

    // C) Assign group if we didn’t apply it during create
    if (targetGroupId && !groupAppliedAtCreate) {
      await setBcCustomerGroup(bcCustomerId, targetGroupId);
      console.log(`✅ Set group ${targetGroupId} for ${email} (BC id ${bcCustomerId})`);
    } else if (!targetGroupId) {
      console.log(`ℹ️ No mapped membership in this purchase for ${email}.`);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('❌ BigCommerce error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
