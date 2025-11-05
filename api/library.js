// api/library.js  (CommonJS; safe alongside your existing files)
const ALLOWED_ORIGIN = process.env.SITE_ORIGIN;    // e.g. https://www.brainwaveentrainmentstore.net
const CSV_URL        = process.env.CSV_SOURCE_URL; // your DAV CSV link

function setCORS(res, origin) {
  if (origin && ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function parseCSV(str) {
  const rows = [];
  let i = 0, f = '', row = [], q = false, c;
  while (i < str.length) {
    c = str[i++];
    if (q) {
      if (c === '"') { if (str[i] === '"') { f += '"'; i++; } else { q = false; } }
      else { f += c; }
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); f = ''; row = []; }
      else if (c === '\r') {}
      else { f += c; }
    }
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

module.exports = async (req, res) => {
  setCORS(res, req.headers.origin);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!CSV_URL) {
    res.status(500).json({ ok:false, error:'CSV_SOURCE_URL missing' });
    return;
  }

  try {
    const r = await fetch(CSV_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('Failed to fetch CSV');
    const text = await r.text();

    const rows = parseCSV(text);
    const headers = (rows.shift() || []).map(h => (h || '').trim().toLowerCase());
    const idx = n => headers.indexOf(n);

    const iCat = idx('categoryid');
    const iId  = idx('id');
    const iT   = idx('title');
    const iD   = idx('description');
    const iImg = idx('image');
    const iS   = idx('stream');
    const iA   = idx('active');
    const iTags= idx('tags');

    const items = rows.map(r => ({
      categoryId:  (r[iCat] || '').trim(),
      id:          (r[iId]  || '').trim(),
      title:       (r[iT]   || '').trim(),
      description:  iD  >= 0 ? (r[iD]  || '').trim() : '',
      image:        iImg >= 0 ? (r[iImg] || '').trim() : '',
      stream:      (r[iS]   || '').trim(),
      active:       iA  >= 0 ? String(r[iA]).toLowerCase() === 'true' : true,
      tags:         iTags >= 0 ? String(r[iTags] || '').split(',').map(s => s.trim()).filter(Boolean) : []
    })).filter(x => x.active);

    res.setHeader('Content-Type','application/json');
    res.status(200).json({ ok:true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || 'unknown error' });
  }
};
