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

// ---- tying ARTIS boxes to the loads on the board ----
const tripOf = (it) => (it && it.trip) || it || {};
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const id5 = (x) => { const d = String(x ?? '').trim(); return /^\d{1,6}$/.test(d) ? d.padStart(5, '0') : d.toUpperCase(); };
const normCo = (s) => String(s || '').toUpperCase().replace(/[*]/g, ' ').replace(/\b(LLC|INC|CORP|CO|LTD)\b\.?/g, ' ').replace(/[^A-Z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();
const LOADING = /^(LOADINGMAN|LOADEDTOGO|ARRSHIP|DEPSHIP)/i;
export const ROLLING = /^(DEPSHIP|ARRCONS|DEPCONS|INTRAN|ENROUTE)/i;
const DONE = /^(delvd|deliv|del$|cmplt|complete|canc|void)/i;

// Which ship date a load's boxes belong to: the day it started loading at the terminal, else (not loading
// yet) today. Pure.
export function shipDateOf(it, now = Date.now()) {
  const h = ((it && it._times && it._times.statusHistory) || []).find((x) => LOADING.test(String(x.status || '')) && x.at);
  if (h) return ymd(new Date(h.at));
  const st = String(tripOf(it).status || '');
  if (ROLLING.test(st) || DONE.test(st)) { const c = it && it._times && it._times.createdAt; return c ? ymd(new Date(c)) : null; }
  return ymd(new Date(now));
}
// The customers on a load (client IDs + names from the bills). Pure.
export function loadCustomers(it) {
  const ids = new Set(); const names = new Set();
  for (const b of billsOf(it)) {
    for (const r of [b.consignee, b.billToCustomer]) {
      if (!r || typeof r !== 'object') continue;
      for (const v of [r.clientId, r.clientID, r.customerId, r.code, r.id]) if (v != null && v !== '') ids.add(id5(v));
      const n = r.name || r.clientName || r.customerName; if (n) names.add(normCo(n));
    }
    if (b.billToName) names.add(normCo(b.billToName));
  }
  return { ids, names };
}
// ARTIS boxes for one load: its customers' cargo on its ship date, and whether boxes are missing while the
// load hasn't left. Pure. summaryFor(date) → summarizeCargo list | null
export function loadBoxes(it, summaryFor, now = Date.now()) {
  const date = shipDateOf(it, now);
  const list = date ? summaryFor(date) : null;
  if (!list || !list.length) return null;
  const { ids, names } = loadCustomers(it);
  const stops = list.filter((c) => (c.consigneeId && ids.has(id5(c.consigneeId))) || (c.consignee && names.has(normCo(c.consignee))));
  if (!stops.length) return null;
  const tot = stops.reduce((a, c) => ({ boxes: a.boxes + c.boxes, scanned: a.scanned + c.scanned }), { boxes: 0, scanned: 0 });
  const st = String(tripOf(it).status || '');
  const notLeft = !ROLLING.test(st) && !DONE.test(st);
  const missing = Math.max(0, tot.boxes - tot.scanned);
  const short = stops.filter((c) => c.missing > 0);
  // the trip sheet's box count per customer vs ARTIS — ARTIS is always the right count
  const same = (a, b) => { const x = normCo(a); const y = normCo(b); return !!(x && y && (x === y || x.startsWith(y) || y.startsWith(x))); };
  const sheet = ((it._manifest && it._manifest.stops) || []).filter((x) => /DELIVER/i.test(x.action || '') && x.pieces != null);
  const sheetDiffs = stops.map((c) => {
    const rows = sheet.filter((x) => same(x.customer, c.consignee));
    if (!rows.length) return null;
    const n = rows.reduce((a, x) => a + (Number(x.pieces) || 0), 0);
    return n !== c.boxes ? { consignee: c.consignee, sheet: n, artis: c.boxes } : null;
  }).filter(Boolean);
  return {
    sheetDiffs,
    shipDate: date, boxes: tot.boxes, scanned: tot.scanned, missing,
    stops: stops.map((c) => ({ consigneeId: c.consigneeId, consignee: c.consignee, boxes: c.boxes, scanned: c.scanned, missing: c.missing, cubes: c.cubes })),
    // before the truck leaves: boxes for a customer on it still not scanned
    alert: notLeft && missing > 0 ? `${missing} box${missing === 1 ? '' : 'es'} not scanned yet — ${short.map((c) => `${c.consignee} ${c.scanned}/${c.boxes}`).join(', ')}` : null,
  };
}

// A truck that LEFT (departed the shipper within the last 12 h) with boxes for its customers still not
// scanned → { trip, truck, departedAt, missing, stops } | null. Pure.
export function leftShort(it, now = Date.now()) {
  const a = it && it._artis;
  if (!a || !(a.missing > 0)) return null;
  if (!ROLLING.test(String(tripOf(it).status || ''))) return null;
  const dep = ((it._times && it._times.statusHistory) || []).find((x) => /^DEPSHIP/i.test(String(x.status || '')) && x.at);
  const at = dep ? Date.parse(dep.at) : NaN;
  if (Number.isNaN(at) || now - at > 12 * 3600000 || at > now + 600000) return null;
  return { trip: String(tripOf(it).tripNumber || ''), truck: String(tripOf(it).powerUnit || '') || null, departedAt: new Date(at).toISOString(), shipDate: a.shipDate, missing: a.missing, boxes: a.boxes, scanned: a.scanned, stops: (a.stops || []).filter((c) => c.missing > 0) };
}
export function leftShortEmail(x) {
  const when = new Date(x.departedAt).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const rows = x.stops.map((c) => `<tr><td>${c.consignee}${c.consigneeId ? ` (${c.consigneeId})` : ''}</td><td>${c.boxes}</td><td>${c.scanned}</td><td><b>${c.missing}</b></td></tr>`).join('');
  return {
    subject: `Truck ${x.truck || '?'} left with missing boxes — trip ${x.trip} (${x.missing} not scanned)`,
    html: `<p>Trip <b>${x.trip}</b>${x.truck ? ` · truck <b>${x.truck}</b>` : ''} departed ${when} ET with <b>${x.missing}</b> box${x.missing === 1 ? '' : 'es'} not scanned in ARTIS (${x.scanned} of ${x.boxes} scanned, ship date ${x.shipDate}).</p>
<table border="1" cellpadding="6" cellspacing="0"><tr><th>Customer</th><th>Expected</th><th>Scanned</th><th>Missing</th></tr>${rows}</table>
<p>Check whether the boxes are still at the terminal or went on another truck.</p>`,
    text: `Trip ${x.trip} truck ${x.truck || '?'} left ${when} ET — ${x.missing} box(es) not scanned: ${x.stops.map((c) => `${c.consignee} ${c.scanned}/${c.boxes}`).join(', ')}`,
  };
}

export function initArtis(app, { requireAuth, requireAdmin = null, db = null, sendMail = null, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
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

  // yesterday / today / tomorrow kept fresh in the background, so the board never waits on ARTIS
  const byDate = new Map();   // date → summarizeCargo list
  async function refresh() {
    if (!artisConfig(env).ready) return;
    const t = now();
    for (const d of [-1, 0, 1].map((k) => ymd(new Date(t + k * 86400000)))) {
      try { byDate.set(d, summarizeCargo(rowsOf(await get('/artis/api/cargo/received', { shipDate: d })))); } catch (e) { console.warn('[artis] refresh', d, e.message); } // eslint-disable-line no-await-in-loop
    }
    for (const k of [...byDate.keys()]) if (Date.parse(k) < t - 3 * 86400000) byDate.delete(k);
  }
  if (env.NODE_ENV !== 'test') {
    setTimeout(() => { refresh().catch(() => {}); }, 30000).unref?.();
    const tick = setInterval(() => { refresh().catch(() => {}); }, 10 * MIN); if (tick.unref) tick.unref();
  }
  // a truck that left short → one email per trip (to ARTIS_LEFT_SHORT_TO — Nadim for the test)
  const leftTo = () => String(env.ARTIS_LEFT_SHORT_TO || 'ntellez@floridabeauty.us').split(',').map((x) => x.trim()).filter(Boolean);
  async function notifyLeftShort(list) {
    if (!list.length || !db || !db.enabled || !sendMail) return 0;
    let fresh = [];
    await db.update('taArtisLeftShort', (cur) => {
      const a = { ...(cur || {}) };
      fresh = list.filter((x) => !a[x.trip]);
      for (const x of fresh) a[x.trip] = { at: new Date(now()).toISOString(), missing: x.missing };
      for (const [k, v] of Object.entries(a)) if (Date.parse(v.at) < now() - 14 * 86400000) delete a[k];
      return a;
    }, {});
    for (const x of fresh) { try { await sendMail({ to: leftTo(), ...leftShortEmail(x) }); } catch (e) { console.warn('[artis] left-short email:', e.message); } } // eslint-disable-line no-await-in-loop
    return fresh.length;
  }
  async function overlay(site, trips) {
    if (!byDate.size) return;
    const short = [];
    for (const it of trips) {
      const b = loadBoxes(it, (d) => byDate.get(d) || null, now());
      if (!b) continue;
      it._artis = b;
      const x = leftShort(it, now()); if (x) short.push(x);
    }
    if (short.length) notifyLeftShort(short).catch((e) => console.warn('[artis] left-short:', e.message));
  }

  console.log(`[artis] Florida Beauty EDI ${artisConfig(env).ready ? 'connected (read-only)' : 'off — needs ARTIS_API_USER / ARTIS_API_PASSWORD'}`);
  return { ready: () => artisConfig(env).ready, cargo, dayOfService, overlay, refresh, notifyLeftShort, _byDate: byDate };
}

// ---- missing boxes on a load a customer asked about → the team gets an email (never the customer) ----
export const MISSING_TEAM = ['Frank Ducassi', 'Sebastian Manotas', 'Ronen', 'Nadim'];
// Pure: the email for a list of { trip, truck, shipDate, consignee, consigneeId, boxes, scanned, missing }.
export function missingEmail(list, { caller = null } = {}) {
  const rows = list.map((m) => `<tr><td>${m.trip}</td><td>${m.truck || '—'}</td><td>${m.consignee}${m.consigneeId ? ` (${m.consigneeId})` : ''}</td><td>${m.scanned} of ${m.boxes}</td><td><b>${m.missing}</b></td><td>${m.shipDate}</td></tr>`).join('');
  const first = list[0];
  return {
    subject: `Missing boxes — ${first.consignee} · trip ${first.trip} (${first.missing} not scanned)`,
    html: `<p>A customer asked about their delivery and ARTIS shows boxes not scanned for them. Jarvis told the customer only how many boxes are loaded — <b>not</b> that any are missing.</p>
<table border="1" cellpadding="6" cellspacing="0"><tr><th>Trip</th><th>Truck</th><th>Customer</th><th>Scanned</th><th>Missing</th><th>Ship date</th></tr>${rows}</table>
${caller ? `<p>Caller: ${caller}</p>` : ''}<p>Please find / scan the missing boxes or follow up with the customer.</p>`,
    text: list.map((m) => `Trip ${m.trip} · ${m.consignee}: ${m.scanned}/${m.boxes} scanned, ${m.missing} missing (ship date ${m.shipDate})`).join('\n'),
  };
}
export function initMissingBoxes({ db, sendMail, recipients, now = () => Date.now() }) {
  const key = 'taArtisMissingSent';
  return async function notify(list, { caller = null } = {}) {
    if (!list || !list.length || !db || !db.enabled) return { sent: false };
    const day = new Date(now()).toISOString().slice(0, 10);
    let fresh = [];
    await db.update(key, (cur) => {
      const a = { ...(cur || {}) };
      fresh = list.filter((m) => !a[`${day}|${m.trip}|${m.consigneeId || m.consignee}`]);
      for (const m of fresh) a[`${day}|${m.trip}|${m.consigneeId || m.consignee}`] = { at: new Date(now()).toISOString(), missing: m.missing };
      for (const k of Object.keys(a)) if (k.slice(0, 10) < new Date(now() - 7 * 86400000).toISOString().slice(0, 10)) delete a[k];
      return a;
    }, {});
    if (!fresh.length) return { sent: false, already: true };
    const to = (await recipients()).filter(Boolean);
    if (!to.length) { console.warn('[artis] missing boxes: no team emails found'); return { sent: false }; }
    await sendMail({ to, ...missingEmail(fresh, { caller }) });
    return { sent: true, to, count: fresh.length };
  };
}
