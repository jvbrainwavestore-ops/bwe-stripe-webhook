// api/library.js
export default async function handler(req, res) {
  try {
    // Use env var if present, otherwise fall back to your known CSV (safe for now)
    const CSV =
      process.env.CSV_SOURCE_URL ||
      'https://store-dkje2os.mybigcommerce.com/content/library-7f4b9a3c.csv';

    // Basic sanity check to avoid cryptic errors
    if (!CSV || !/^https?:\/\//i.test(CSV)) {
      console.error('Bad CSV url:', CSV);
      res.status(500).send('Server misconfigured: CSV URL is missing or invalid.');
      return;
    }

    // Fetch the CSV from BigCommerce (no caching so updates show up quickly)
    const upstream = await fetch(CSV, {
      redirect: 'follow',
      // headers: { 'User-Agent': 'bwe-csv-proxy/1.0' } // optional
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      console.error('Upstream fetch failed:', upstream.status, text.slice(0, 200));
      res.status(502).send('Upstream CSV fetch failed.');
      return;
    }

    const csvText = await upstream.text();

    // Security & SEO headers (bots shouldn’t index this endpoint)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    // CORS: allow your storefront when calling from the browser
    const allowed = process.env.SITE_ORIGIN || 'https://www.brainwaveentrainmentstore.net';
    const origin = req.headers.origin || '';
    if (origin === allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.status(200).send(csvText);
  } catch (err) {
    console.error('Library endpoint crashed:', err);
    res.status(500).send('Internal error fetching CSV.');
  }
}
