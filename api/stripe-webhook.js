// Vercel Serverless Function: Stripe → BigCommerce (maps Stripe prices to BC customer groups)
// Adds removal on customer.subscription.deleted (+ optional on invoice.payment_failed)

import Stripe from 'stripe';

// Keep raw body for Stripe signature verification
export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2024-06-20' });

// === SETTINGS ===
// Set to true if you want to drop members from their group immediately when a payment fails
const REMOVE_ON_PAYMENT_FAILED = true;
// BigCommerce “no group” value. BC treats 0 as “no customer group”.
const NO_GROUP = 0;

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
  return `https://api.bigcommerce.com/stores/${hash}/v3`;
}
function bcBaseV2() {
  const hash = (process.env.BC_STORE_HASH || '').trim();
  return `https://api.bigcommerce.com/stores/${hash}/v2`;
}

// Lookup by email (try v3 /customers/lookup, fall back to v2 /customers?email=)
async function lookupBcCustomerIdByEmail(email) {
  const normalized = (email || '').trim().toLowerCase();

  // Try v3
  try {
    const url = `${bcBaseV3()}/customers/lookup`;
    const res = await fetch(url, { method: 'POST', headers: bcHeaders(), body: JSON.stringify({ emails: [normalized] }) });
    const txt = await res.text().catch(() => '');
    if (res.status === 404) throw new Error('__TRY_V2__');
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

// Assign customer group with PATCH → fallback to bulk PUT
async function setBcCustomerGroup(customerId, groupId) {
  const headers = bcHeaders();
  const v3 = bcBaseV3();

  // 1) Preferred: single PATCH
  try {
    const url = `${v3}/customers/${Number(customerId)}`;
    const body = JSON.stringify({ customer_group_id: Number(groupId) });
    const res = await fetch(url, { method: 'PATCH', headers, body });
    const txt = await res.text().catch(() => '');
    if (res.ok) return;
    const mustUseBulk = res.status === 422 || res.status === 404 || /array/i.test(txt || '');
    if (!mustUseBulk) throw new Error(`BC group PATCH failed (${res.status}): ${txt}`);
  } catch (e) {
    console.warn('PATCH group failed; trying bulk PUT:', e.message);
  }

  // 2) Bulk PUT requires a TOP-LEVEL ARRAY
  const url2 = `${v3}/customers`;
  const payloadArray = [{ id: Number(customerId), customer_group_id: Number(groupId) }];
  const res2 = await fetch(url2, { method: 'PUT', headers, body: JSON.stringify(payloadArray) });
  const txt2 = await res2.text().catch(() => '');
  if (!res2.ok) throw new Error(`BC group PUT failed (${res2.status}): ${txt2}`);
}

// === STRIPE HELPERS ===
function priceToGroupId(priceIdSet) {
  let map = {};
  try { map = JSON.parse(process.env.PRICE_TO_GROUP_MAP || '{}'); } catch {}
  for (const pid of priceIdSet) {
    if (pid && map[pid]) return Number(map[pid]);
  }
  return null;
}

async function collectFromSession(sessionId, foundPriceIds) {
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
function collectFromInvoice(invoice, foundPriceIds) {
  (invoice.lines?.data || []).forEach(li => {
    const pidNew = li?.pricing?.price_details?.price;
    const pidOld = li?.price?.id;
    if (pidNew) foundPriceIds.add(pidNew);
    if (pidOld) foundPriceIds.add(pidOld);
  });
}

// === MAIN HANDLER ===
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

  const type = event.type;
  const foundPriceIds = new Set();
  let email = null;
  let fullName = '';

  if (type === 'checkout.session.completed') {
    const s = await collectFromSession(event.data.object.id, foundPriceIds);
    email = s?.customer_details?.email || s?.customer_email || null;
    fullName = s?.customer_details?.name || '';
    if (!email && s?.customer) {
      try { const c = await stripe.customers.retrieve(s.customer); email = c?.email || null; fullName = fullName || c?.name || ''; } catch {}
    }
  } else if (type === 'invoice.payment_succeeded' || type === 'invoice.payment_failed') {
    const inv = event.data.object;
    collectFromInvoice(inv, foundPriceIds);
    email = inv?.customer_email || inv?.customer_details?.email || null;
    if (inv?.customer) {
      try { const c = await stripe.customers.retrieve(inv.customer); fullName = fullName || c?.name || ''; if (!email) email = c?.email || null; } catch {}
    }
  } else if (type === 'customer.subscription.deleted') {
    // handled below (no prices needed)
  } else {
    // Ignore other events
    res.status(200).json({ ok: true, ignored: type });
    return;
  }

  // === ROUTING BY EVENT ===
  try {
    if (type === 'customer.subscription.deleted') {
      // Remove from group on cancellation
      const sub = event.data.object;
      // Try to get customer email
      let custEmail = null;
      try {
        const c = await stripe.customers.retrieve(sub.customer);
        custEmail = c?.email || null;
        fullName = c?.name || '';
      } catch {}
      if (!custEmail) {
        console.warn('No email on subscription.deleted; skipping');
        res.status(200).json({ ok: true });
        return;
      }
      const bcId = await lookupBcCustomerIdByEmail(custEmail);
      if (!bcId) {
        console.warn(`No BC customer for ${custEmail}; nothing to remove.`);
        res.status(200).json({ ok: true });
        return;
      }
      await setBcCustomerGroup(bcId, NO_GROUP);
      console.log(`✅ Removed BC group for ${custEmail} (cancelled subscription).`);
      res.status(200).json({ ok: true });
      return;
    }

    // For successful charges → assign group
    if (type === 'checkout.session.completed' || type === 'invoice.payment_succeeded') {
      if (!email) {
        console.warn('No purchaser email; skipping');
        res.status(200).json({ ok: true });
        return;
      }
      const targetGroupId = priceToGroupId(foundPriceIds);
      console.log(`Prices in event: ${[...foundPriceIds].join(', ') || '(none)'} → target group: ${targetGroupId ?? '(none)'} for ${email}`);

      const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
      const firstName = parts[0] || 'Member';
      const lastName  = parts.slice(1).join(' ') || 'Account';

      let bcCustomerId = await lookupBcCustomerIdByEmail(email);
      let groupAppliedAtCreate = false;
      if (!bcCustomerId) {
        const created = await createBcCustomer({ email, firstName, lastName, groupId: targetGroupId || null });
        bcCustomerId = created.id;
        groupAppliedAtCreate = created.groupAppliedAtCreate;
        console.log(`✅ Created BC customer ${bcCustomerId} for ${email} (group at create: ${groupAppliedAtCreate})`);
      } else {
        console.log(`ℹ️ Found BC customer ${bcCustomerId} for ${email}`);
      }

      if (targetGroupId && !groupAppliedAtCreate) {
        await setBcCustomerGroup(bcCustomerId, targetGroupId);
        console.log(`✅ Set group ${targetGroupId} for ${email} (BC id ${bcCustomerId})`);
      } else if (!targetGroupId) {
        console.log(`ℹ️ No mapped membership in this purchase for ${email}.`);
      }

      res.status(200).json({ ok: true });
      return;
    }

    // Optional: drop access on payment failure
    if (type === 'invoice.payment_failed' && REMOVE_ON_PAYMENT_FAILED) {
      if (!email) { res.status(200).json({ ok: true }); return; }
      const bcId = await lookupBcCustomerIdByEmail(email);
      if (bcId) {
        await setBcCustomerGroup(bcId, NO_GROUP);
        console.log(`⚠️ Payment failed — removed group for ${email}.`);
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('❌ BigCommerce error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
