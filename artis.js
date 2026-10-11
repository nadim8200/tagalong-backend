// ---------------------------------------------------------------
// A.R.T.I.S. — Florida Beauty's own EDI API (https://app.swaggerhub.com/apis/FloridaBeauty/EDI/1.0.0).
// READ-ONLY here: what cargo (boxes) was received / scanned for a ship date, per consignee, and the
// consignees' days of service. We never send orders (the XML "body" in their instructions is for
// shippers submitting shipments — not something Jarvis does).
// Sign-in: FBF_AUTH_USERNAME / FBF_AUTH_PASSWORD headers (+ Basic auth, which the spec also lists).
// Credentials live only in Render: ARTIS_API_USER, ARTIS_API_PASSWORD (ARTIS_API_URL optional).
// ---------------------------------------------------------------
const MIN = 60000;
const ymd = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export function artisConfig(env = process.env) {
  const url = String(env.ARTIS_API_URL || 'https://www.floridabeauty.com').replace(/\/+$/, '');
  const user = String(env.ARTIS_API_USER || '').trim();
  const pass = String(env.ARTIS_API_PASSWORD || '');
  return { url, user, pass, ready: !!(user && pass) };
}

// Boxes per consignee for one ship date: expected vs scanned (boxes + cubes), farms, products. Pure.
export function summarizeCargo(rows = []) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const id = String(r.consigneeId ?? '').trim(); const name = String(r.consigneeName || '').trim();
    const k = id || name.toUpperCase(); if (!k) continue;
    const c = by.get(k) || { consigneeId: id || null, consignee: name || null, boxes: 0, scanned: 0, cubes: 0, scannedCubes: 0, lines: 0, farms: new Set(), products: new Set() };
    c.boxes += Number(r.cargoQty) || 0; c.scanned += Number(r.scannedQty) || 0;
    c.cubes += Number(r.cargoCubes) || 0; c.scannedCubes += Number(r.scannedCubes) || 0; c.lines += 1;
    if (r.farmName) c.farms.add(String(r.farmName)); if (r.productDescription) c.products.add(String(r.productDescription));
    by.set(k, c);
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return [...by.values()].map((c) => ({ ...c, cubes: r2(c.cubes), scannedCubes: r2(c.scannedCubes), missing: Math.max(0, c.boxes - c.scanned), farms: [...c.farms].slice(0, 12), products: [...c.products].slice(0, 8) }))
    .sort((a, b) => b.missing - a.missing || String(a.consignee).localeCompare(String(b.consignee)));
}

export function initArtis(app, { requireAuth, requireAdmin = null, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const cache = new Map();   // "path?query" → { at, data }
  async function get(path, query = {}) {
    const cfg = artisConfig(env);
    if (!cfg.ready) throw Object.assign(new Error('ARTIS is not connected — add ARTIS_API_USER and ARTIS_API_PASSWORD in Render.'), { status: 503 });
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString();
    const key = `${path}?${qs}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < 10 * MIN) return hit.data;
    const r = await fetchFn(`${cfg.url}${path}${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: { 'Content-Type': 'text/xml', Accept: 'application/json', FBF_AUTH_USERNAME: cfg.user, FBF_AUTH_PASSWORD: cfg.pass, Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64')}` },
    });
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(`ARTIS answered ${r.status}${r.status === 401 || r.status === 403 ? ' — the login email / password in Render was refused' : ''}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`), { status: 502 });
    let data;
    try { data = JSON.parse(text); } catch { throw Object.assign(new Error(`ARTIS sent something other than JSON: ${text.replace(/\s+/g, ' ').slice(0, 200)}`), { status: 502 }); }
    cache.set(key, { at: now(), data });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return data;
  }
  const rowsOf = (d) => (Array.isArray(d) ? d : (d && (d.cargo || d.data || d.items)) || []);

  // what arrived for a ship date, per consignee (optionally one customer by name / ID)
  async function cargo({ date = ymd(new Date(now())), customer = '' } = {}) {
    const rows = rowsOf(await get('/artis/api/cargo/received', { shipDate: date }));
    let list = summarizeCargo(rows);
    const q = String(customer || '').trim().toUpperCase();
    if (q) list = list.filter((c) => String(c.consigneeId || '') === q.replace(/^0+/, '') || String(c.consigneeId || '').padStart(5, '0') === q.padStart(5, '0') || String(c.consignee || '').toUpperCase().includes(q));
    const tot = list.reduce((a, c) => ({ boxes: a.boxes + c.boxes, scanned: a.scanned + c.scanned }), { boxes: 0, scanned: 0 });
    return { date, consignees: list.length, boxes: tot.boxes, scanned: tot.scanned, missing: Math.max(0, tot.boxes - tot.scanned), list };
  }
  async function dayOfService({ consigneeId, shipperId, date }) {
    if (consigneeId) return get('/artis/api/day_of_service/validate', { consigneeId, shipperId, shipDate: date });
    return get('/artis/api/day_of_service/shipper/consignees', { shipperId, shipDate: date });
  }

  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });
  // admin: is the connection working? (counts + three consignees as a sample — never the credentials)
  app.get('/truckmate/artis/status', requireAdmin || requireAuth, async (req, res) => {
    const cfg = artisConfig(env);
    if (!cfg.ready) return res.json({ connected: false, url: cfg.url, note: 'Add ARTIS_API_USER and ARTIS_API_PASSWORD in Render → Environment.' });
    try { const c = await cargo({ date: String(req.query.date || '') || undefined }); return res.json({ connected: true, url: cfg.url, date: c.date, consignees: c.consignees, boxes: c.boxes, scanned: c.scanned, sample: c.list.slice(0, 3) }); } catch (e) { return res.json({ connected: false, url: cfg.url, error: e.message }); }
  });
  app.get('/truckmate/artis/cargo', requireAuth, async (req, res) => {
    try { res.json(await cargo({ date: String(req.query.date || '') || undefined, customer: String(req.query.q || '') })); } catch (e) { fail(res, e); }
  });

  console.log(`[artis] Florida Beauty EDI ${artisConfig(env).ready ? 'connected (read-only)' : 'off — needs ARTIS_API_USER / ARTIS_API_PASSWORD'}`);
  return { ready: () => artisConfig(env).ready, cargo, dayOfService };
}
