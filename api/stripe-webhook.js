// Vercel Serverless Function: Stripe → BigCommerce (Intro -> group 2)
import Stripe from 'stripe';

// If this is a Next.js API route, keep the raw body available for Stripe signature verification:
export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2024-06-20' });

// Helper: read raw body (required for Stripe signature verification)
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Helper: find existing BC customer by email OR create one, then return id
async function getOrCreateBcCustomerIdByEmail(email, firstName = '', lastName = '') {
  const base = `https://api.bigcommerce.com/stores/${process.env.BC_STORE_HASH}/v3`;
  const headers = {
    'X-Auth-Client': process.env.BC_CLIENT_ID,
    'X-Auth-Token': process.env.BC_ACCESS_TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  // 1) Lookup by email
  const searchUrl = `${base}/customers?email=${encodeURIComponent(email)}`;
  const searchRes = await fetch(searchUrl, { headers });
  if (!searchRes.ok) {
    const t = await searchRes.text().catch(()=>'');
    throw new Error(`BC search failed (${searchRes.status}): ${t}`);
  }
  const searchJson = await searchRes.json().catch(() => ({}));
  const found = Array.isArray(searchJson?.data) ? searchJson.data[0] : null;
  if (found?.id) return found.id;

  // 2) Not found → create (payload is an ARRAY for v3)
  const payload = [{
    email,
    first_name: firstName || '',
    last_name:  lastName  || ''
    // If you ever want to set initial group at creation:
    // customer_group_id: Number(groupId)
  }];
  const createRes = await fetch(`${base}/customers`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  if (!createRes.ok) {
    const t = await createRes.text().catch(()=> '');
    throw new Error(`BC create failed (${createRes.status}): ${t}`);
  }
  const createJson = await createRes.json().catch(() => ({}));
  const newId = Array.isArray(createJson?.data) ? createJson.data[0]?.id : null;
  if (!newId) throw new Error('BC create returned no id');
  return newId;
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

  async function collectFromSession(sessionId) {
    try {
      const s = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['line_items.data.price.product']
      });
      (s.line_items?.data || []).forEach(li => li.price?.id && foundPriceIds.add(li.price.id));
      return s;
    } catch (e) {
      console.error('Session retrieve failed', e);
      return null;
    }
  }

  function collectFromInvoice(invoice) {
    (invoice.lines?.data || []).forEach(li => li.price?.id && foundPriceIds.add(li.price.id));
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
    // Try to back-fill name from the Stripe Customer if available
    if (inv?.customer) {
      try { const c = await stripe.customers.retrieve(inv.customer); fullName = c?.name || fullName; if (!email) email = c?.email || null; } catch {}
    }
  } else {
    // Ignore other events
    res.status(200).json({ ok: true });
    return;
  }

  if (!email) {
    console.warn('⚠️ No purchaser email on event; skipping');
    res.status(200).json({ ok: true });
    return;
  }

  // 3) Map Stripe Price IDs → BigCommerce group id (Intro = Group 2)
  // Using your two env price variables for now (stable & simple)
  const PRICE_TO_GROUP = {
    [process.env.PRICE_INTRO_MONTHLY]: 2,
    [process.env.PRICE_INTRO_YEARLY]:  2
  };

  let targetGroupId = null;
  for (const pid of foundPriceIds) {
    if (pid && PRICE_TO_GROUP[pid]) { targetGroupId = PRICE_TO_GROUP[pid]; break; }
  }

  // 4) Upsert customer in BigCommerce and set group (PUT body is ARRAY in v3)
  try {
    const base = `https://api.bigcommerce.com/stores/${process.env.BC_STORE_HASH}/v3`;
    const headers = {
      'X-Auth-Token': process.env.BC_ACCESS_TOKEN,
      'X-Auth-Client': process.env.BC_CLIENT_ID,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    // Split name, non-blocking
    const firstName = fullName ? fullName.split(' ')[0] : '';
    const lastName  = fullName ? fullName.split(' ').slice(1).join(' ') : '';

    // ✅ Find or create customer
    const bcCustomerId = await getOrCreateBcCustomerIdByEmail(email, firstName, lastName);

    // Set group if Intro was purchased
    if (targetGroupId) {
      const payload = [{ id: bcCustomerId, customer_group_id: Number(targetGroupId) }];
      const updRes = await fetch(`${base}/customers`, { method: 'PUT', headers, body: JSON.stringify(payload) });
      if (!updRes.ok) {
        const txt = await updRes.text().catch(()=> '');
        throw new Error(`BC group update failed (${updRes.status}): ${txt}`);
      }
      console.log(`✅ Set group ${targetGroupId} for ${email} (BC id ${bcCustomerId})`);
    } else {
      console.log(`ℹ️ No Intro tier in this purchase for ${email}. Prices seen: ${[...foundPriceIds].join(', ')}`);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('❌ BigCommerce error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
