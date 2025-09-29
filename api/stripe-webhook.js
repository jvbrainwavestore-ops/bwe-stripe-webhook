// 4) Upsert customer in BigCommerce and set group
try {
  const base = `https://api.bigcommerce.com/stores/${process.env.BC_STORE_HASH}/v3`;
  const headers = {
    'X-Auth-Token': process.env.BC_ACCESS_TOKEN,
    'X-Auth-Client': process.env.BC_CLIENT_ID,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  // Split name (non-blocking)
  const firstName = fullName ? fullName.split(' ')[0] : '';
  const lastName  = fullName ? fullName.split(' ').slice(1).join(' ') : '';

  // Find-or-create (email:in filter)
  const searchUrl = `${base}/customers?email:in=${encodeURIComponent(email)}`;
  const sRes = await fetch(searchUrl, { headers });
  const sTxt = await sRes.text().catch(()=> '');
  if (!sRes.ok) throw new Error(`BC search failed (${sRes.status}): ${sTxt}`);
  let sJson = {};
  try { sJson = JSON.parse(sTxt); } catch {}
  let bcCustomerId = Array.isArray(sJson?.data) && sJson.data[0]?.id ? sJson.data[0].id : null;

  if (!bcCustomerId) {
    // CREATE — v3 accepts { customers: [...] }
    const createPayload = { customers: [{
      email, first_name: firstName || '', last_name: lastName || ''
    }]};
    const cRes = await fetch(`${base}/customers`, {
      method: 'POST', headers, body: JSON.stringify(createPayload)
    });
    const cTxt = await cRes.text().catch(()=> '');
    if (!cRes.ok) throw new Error(`BC create failed (${cRes.status}): ${cTxt}`);
    let cJson = {}; try { cJson = JSON.parse(cTxt); } catch {}
    bcCustomerId = Array.isArray(cJson?.data) ? cJson.data[0]?.id : null;
    if (!bcCustomerId) throw new Error(`BC create returned no id. Raw: ${cTxt}`);
    console.log(`✅ Created BC customer ${bcCustomerId} for ${email}`);
  } else {
    console.log(`ℹ️ Found BC customer ${bcCustomerId} for ${email}`);
  }

  // Assign group if we mapped one
  if (targetGroupId) {
    const updPayload = { customers: [{ id: bcCustomerId, customer_group_id: Number(targetGroupId) }] };
    const uRes = await fetch(`${base}/customers`, {
      method: 'PUT', headers, body: JSON.stringify(updPayload)
    });
    const uTxt = await uRes.text().catch(()=> '');
    if (!uRes.ok) throw new Error(`BC group update failed (${uRes.status}): ${uTxt}`);
    console.log(`✅ Set group ${targetGroupId} for ${email} (BC id ${bcCustomerId})`);
  } else {
    console.log(`ℹ️ No Intro tier in this purchase for ${email}. Prices seen: ${[...foundPriceIds].join(', ')}`);
  }

  res.status(200).json({ ok: true });
} catch (e) {
  console.error('❌ BigCommerce error:', e);
  res.status(500).json({ ok: false, error: e.message });
}
