// Vercel Serverless Function: Stripe → BigCommerce (Intro → group 2 only for now)
import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed'); return;
  }

  const sig = req.headers['stripe-signature'];
  const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2024-06-20' });

  // Verify signature with RAW body
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`); return;
  }

  // Collect purchased price IDs + email from the event
  const foundPriceIds = new Set();
  const type = event.type;

  async function collectFromSession(sessionId) {
    try {
      const s = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price.product'] });
      (s.line_items?.data || []).forEach(li => li.price?.id && foundPriceIds.add(li.price.id));
      return s;
    } catch (e) { console.error('Session retrieve failed', e); return null; }
  }

  function collectFromInvoice(invoice) {
    (invoice.lines?.data || []).forEach(li => li.price?.id && foundPriceIds.add(li.price.id));
  }

  let email = null;

  if (type === 'checkout.session.completed') {
    const s = await collectFromSession(event.data.object.id);
    email = s?.customer_details?.email || s?.customer_email || null;
    if (!email && s?.customer) {
      try { const c = await stripe.customers.retrieve(s.customer); email = c?.email || null; } catch {}
    }
  } else if (type === 'invoice.payment_succeeded') {
    const inv = event.data.object;
    collectFromInvoice(inv);
    email = inv?.customer_email || inv?.customer_details?.email || null;
    if (!email && inv?.customer) {
      try { const c = await stripe.customers.retrieve(inv.customer); email = c?.email || null; } catch {}
    }
  } else {
    res.status(200).json({ ok: true }); return;
  }

  if (!email) { console.warn('⚠️ No email; skipping'); res.status(200).json({ ok: true }); return; }

  // Map Stripe Price IDs → BigCommerce group id (Intro = Group 2)
  const PRICE_TO_GROUP = {
    [process.env.PRICE_INTRO_MONTHLY]: 2,
    [process.env.PRICE_INTRO_YEARLY]: 2
  };

  let targetGroupId = null;
  for (const pid of foundPriceIds) {
    if (pid && PRICE_TO_GROUP[pid]) { targetGroupId = PRICE_TO_GROUP[pid]; break; }
  }

  try {
    const base = `https://api.bigcommerce.com/stores/${process.env.BC_STORE_HASH}`;
    const headers = {
      'X-Auth-Token': process.env.BC_ACCESS_TOKEN,
      'X-Auth-Client': process.env.BC_CLIENT_ID,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    // Find or create customer by email
    const findRes = await fetch(`${base}/v3/customers?email:in=${encodeURIComponent(email)}`, { method: 'GET', headers });
    const findJson = await findRes.json();
    let customerId = findJson?.data?.[0]?.id || null;

    if (!customerId) {
      const createRes = await fetch(`${base}/v3/customers`, {
        method: 'POST', headers,
        body: JSON.stringify({ customers: [{ email, first_name: '', last_name: '' }] })
      });
      const createJson = await createRes.json();
      customerId = createJson?.data?.[0]?.id || null;
    }

    if (!customerId) throw new Error('Could not resolve BigCommerce customer id');

    // Set group if Intro was purchased
    if (targetGroupId) {
      const updRes = await fetch(`${base}/v3/customers`, {
        method: 'PUT', headers,
        body: JSON.stringify({ customers: [{ id: customerId, customer_group_id: targetGroupId }] })
      });
      if (!updRes.ok) { const txt = await updRes.text(); throw new Error(`BC update failed: ${txt}`); }
      console.log(`✅ Set group ${targetGroupId} for ${email} (customer ${customerId})`);
    } else {
      console.log(`ℹ️ No Intro tier in this purchase for ${email}.`);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('❌ BigCommerce error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}

// Disable parsing so Stripe signature works
export const config = { api: { bodyParser: false } };
