// Vercel Serverless Function: Stripe → BigCommerce (Intro -> group 2)
import Stripe from 'stripe';

// Keep raw body for Stripe signature verification
export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2024-06-20' });

// ---------- helpers ----------
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

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

async function lookupBcCustomerIdByEmail(email) {
  const url = `${bcBase()}/customers/lookup`;
  const res = await fetch(url, { method: 'POST', headers: bcHeaders(), body: JSON.stringify({ emails: [email] }) });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`BC lookup failed (${res.status}): ${txt}`);
  let json = {};
  try { json = JSON.parse(txt); } catch {}
  const first = Array.isArray(json?.data) ? json.data[0] : null;
  return first?.id || null;
}

async function createBcCustomer(email, firstName = '', lastName = '') {
  const payload = { customers: [{ email, first_name: firstName || '', last_name: lastName || '' }] };
  const res = await fetch(`${bcBase()}/customers`, { method: 'POST', headers: bcHeaders(), body: JSON.stringify(payload) });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`BC create failed (${res.status}): ${txt}`);
  let json = {};
  try { json = JSON.parse(txt); } catch {}
  return Array.isArray(json?.data) ? json.data[0]?.id : null;
}

async function setBcCustomerGroup(customerId, groupId) {
  const payload = { customers: [{ id: Number(customerId), customer_group_id: Number(groupId) }] };
  const res = await fetch(`${bcBase()}/customers`, { method: 'PUT', headers: bcHeaders(), body: JSON.stringify(payload) });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`BC group update failed (${res.status}): ${txt}`);
}

// Normalize price id across Stripe API versions/shapes
function extractPriceIdFromLineItem(li) {
  // Older shapes (expanded price object)
  if (li?.price?.id) return li.price.id;
  // Sometimes price is a plain string id
  if (typeof li?.price === 'string') return li.price;
  // Newer shape (your live event)
  if (li?.pricing?.price_details?.price) return li.pricing.price_details.price;
  return null;
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

  // 2) Collect price IDs + purchaser email
  const foundPriceIds = new Set();
  const type = event.type;

  async function collectFromSession(sessionId) {
    try {
      const s = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price.product'] });
      (s.line_items?.data || []).forEach(li => {
        const pid = extractPriceIdFromLineItem(li);
        if (pid) foundPriceIds.add(pid);
      });
      return s;
    } catch (e) {
      console.error('Session retrieve failed', e);
      return null;
    }
  }

  function collectFromInvoice(invoice) {
    (invoice.lines?.data || []).forEach(li => {
      const pid = extractPriceIdFromLineItem(li);
      if (pid) foundPriceIds.add(pid);
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

  // 3) Map Stripe Price IDs → BigCommerce group id (Intro = Group 2)
  // Prefer the JSON map if provided; else fallback to two env vars.
  let PRICE_TO_GROUP = {};
  try {
    if (process.env.PRICE_TO_GROUP_MAP) PRICE_TO_GROUP = JSON.parse(process.env.PRICE_TO_GROUP_MAP);
  } catch {}
  if (!Object.keys(PRICE_TO_GROUP).length) {
    PRICE_TO_GROUP = {
      [process.env.PRICE_INTRO_MONTHLY]: 2,
      [process.env.PRICE_INTRO_YEARLY]:  2
    };
  }

  let targetGroupId = null;
  for (const pid of foundPriceIds) {
    if (pid && PRICE_TO_GROUP[pid]) { targetGroupId = PRICE_TO_GROUP[pid]; break; }
  }
  console.log(`Prices in event: ${[...foundPriceIds].join(', ') || '(none)'} → target group: ${targetGroupId ?? '(none)'} for ${email}`);

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
      console.log(`ℹ️ No mapped membership in this purchase for ${email}.`);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('❌ BigCommerce error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
