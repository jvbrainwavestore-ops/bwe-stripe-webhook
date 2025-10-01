// Vercel Serverless Function: Stripe → BigCommerce (auto-assign groups)
// - Supports both checkout.session.completed and invoice.payment_succeeded
// - Reads price IDs from li.price.id OR li.pricing.price_details.price
// - Uses PRICE_TO_GROUP_MAP env JSON (e.g. {"price_ABC":2,"price_DEF":2})

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

// ---------- BigCommerce HELPERS ----------
function bcHeaders() {
  return {
    'X-Auth-Client': process.env.BC_CLIENT_ID,
    'X-Auth-Token': process.env.BC_ACCESS_TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}
function bcBase() {
  return `https://api.bigcommerce.com/stores/${process.env.BC_STORE_HASH}/v3`;
}

// /v3/customers/lookup → get by email
async function lookupBcCustomerIdByEmail(email) {
  const url = `${bcBase()}/customers/lookup`;
  const res = await fetch(url, {
    method: 'POST',
    headers: bcHeaders(),
    body: JSON.stringify({ emails: [email] })
  });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`BC lookup failed (${res.status}): ${txt}`);
  let json = {};
  try { json = JSON.parse(txt); } catch {}
  const first = Array.isArray(json?.data) ? json.data[0] : null;
  return first?.id || null;
}

async function createBcCustomer(email, firstName = '', lastName = '') {
  const payload = { customers: [{ email, first_name: firstName || '', last_name: lastName || '' }] };
  const res = await fetch(`${bcBase()}/customers`, {
    method: 'POST',
    headers: bcHeaders(),
    body: JSON.stringify(payload)
  });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`BC create failed (${res.status}): ${txt}`);
  let json = {};
  try { json = JSON.parse(txt); } catch {}
  return Array.isArray(json?.data) ? json.data[0]?.id : null;
}

async function setBcCustomerGroup(customerId, groupId) {
  const payload = { customers: [{ id: Number(customerId), customer_group_id: Number(groupId) }] };
  const res = await fetch(`${bcBase()}/customers`, {
    method: 'PUT',
    headers: bcHeaders(),
    body: JSON.stringify(payload)
  });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`BC group update failed (${res.status}): ${txt}`);
}

// ---------- PRICE COLLECTION ----------
function pushPriceIdFromLine(foundPriceIds, li) {
  // Supports both older and newer Stripe shapes
  const pid =
    li?.price?.id /* classic */ ||
    li?.pricing?.price_details?.price /* newer invoice line shape */;
  if (pid) foundPriceIds.add(pid);
}

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

  // 2) Collect price IDs + purchaser email
  const foundPriceIds = new Set();
  const type = event.type;
  let email = null;
  let fullName = '';

  async function collectFromSession(sessionId) {
    try {
      const s = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['line_items.data.price.product']
      });
      (s.line_items?.data || []).forEach(li => pushPriceIdFromLine(foundPriceIds, li));
      return s;
    } catch (e) {
      console.error('Session retrieve failed', e);
      return null;
    }
  }

  function collectFromInvoice(invoice) {
    (invoice.lines?.data || []).forEach(li => pushPriceIdFromLine(foundPriceIds, li));
  }

  if (type === 'checkout.session.completed') {
    const s = await collectFromSession(event.data.object.id);
    email = s?.customer_details?.email || s?.customer_email || null;
    fullName = s?.customer_details?.name || '';
    if (!email && s?.customer) {
      try {
        const c = await stripe.customers.retrieve(s.customer);
        email = c?.email || email;
        fullName = fullName || c?.name || '';
      } catch {}
    }
  } else if (type === 'invoice.payment_succeeded') {
    const inv = event.data.object;
    collectFromInvoice(inv);
    email = inv?.customer_email || inv?.customer_details?.email || null;
    if (inv?.customer) {
      try {
        const c = await stripe.customers.retrieve(inv.customer);
        if (!email) email = c?.email || null;
        fullName = fullName || c?.name || '';
      } catch {}
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

  // 3) Map Stripe Price IDs → BigCommerce group id via PRICE_TO_GROUP_MAP env
  let MAP = {};
  try { MAP = JSON.parse(process.env.PRICE_TO_GROUP_MAP || '{}'); } catch {}
  let targetGroupId = null;
  for (const pid of foundPriceIds) {
    if (pid && MAP[pid]) { targetGroupId = MAP[pid]; break; }
  }

  console.log(
    `Prices in event: ${[...foundPriceIds].join(', ') || '(none)'} → target group: ${targetGroupId ?? '(none)'} for ${email}`
  );

  // 4) Upsert customer in BigCommerce and set group
  try {
    const firstName = fullName ? fullName.split(' ')[0] : '';
    const lastName  = fullName ? fullName.split(' ').slice(1).join(' ') : '';

    let bcCustomerId = await lookupBcCustomerIdByEmail(email);

    if (!bcCustomerId) {
      bcCustomerId = await createBcCustomer(email, firstName, lastName);
      if (!bcCustomerId) throw new Error('BC create returned no id.');
      console.log(`✅ Created BC customer ${bcCustomerId} for ${email}`);
    } else {
      console.log(`ℹ️ Found BC customer ${bcCustomerId} for ${email}`);
    }

    if (targetGroupId) {
      await setBcCustomerGroup(bcCustomerId, targetGroupId);
      console.log(`✅ Set group ${targetGroupId} for ${email} (BC id ${bcCustomerId})`);
    } else {
      console.log(`ℹ️ No mapped tier in this purchase for ${email}.`);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('❌ BigCommerce error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
