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
    // per shipper / farm: who sent what, and what never arrived at the terminal
    const sh = String(r.shipperName || r.shipper || r.farmName || '').trim() || 'Unknown shipper';
    c.byShipper = c.byShipper || new Map();
    const b = c.byShipper.get(sh) || { shipper: sh, boxes: 0, scanned: 0 };
    b.boxes += Number(r.cargoQty) || 0; b.scanned += Number(r.scannedQty) || 0; c.byShipper.set(sh, b);
    by.set(k, c);
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return [...by.values()].map((c) => ({ ...c, shippers: [...(c.byShipper || new Map()).values()].map((x) => ({ ...x, missing: Math.max(0, x.boxes - x.scanned) })).sort((a, b) => b.missing - a.missing), byShipper: undefined, cubes: r2(c.cubes), scannedCubes: r2(c.scannedCubes), missing: Math.max(0, c.boxes - c.scanned), farms: [...c.farms].slice(0, 12), products: [...c.products].slice(0, 8) }))
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
// A load can carry a customer's boxes from EARLIER ship dates (624773: Davis Macon 240 shipped 10/11 + 16 held
// from 10/09 = the 256 on its trip sheet). Earlier days (up to LOOKBACK) are added only when they make the total
// EXACTLY the trip sheet's count for that customer (no sheet yet → its TruckMate bills); no exact match → nothing
// is added. ARTIS box lines carry no trip or bill number, so the sheet's count is the proof. Pure.
const LOOKBACK = 5;
const dayBefore = (d, k) => ymd(new Date(Date.parse(`${d}T12:00:00Z`) - k * 86400000));
const sameCo = (a, b) => { const x = normCo(a); const y = normCo(b); return !!(x && y && (x === y || x.startsWith(y) || y.startsWith(x))); };
function sheetTotalFor(it, c) {
  // ARTIS's Truck Builder (read nightly — truckbuilder.js) is the digital original of the trip sheet
  const tb = it._tb && (it._tb.stops || []).filter((b) => (c.consigneeId && b.consigneeId && id5(b.consigneeId) === id5(c.consigneeId)) || sameCo(b.consignee, c.consignee));
  if (tb && tb.length) return tb.reduce((n, b) => n + (Number(b.boxes) || 0), 0);
  const rows = ((it._manifest && it._manifest.stops) || []).filter((x) => /DELIVER/i.test(x.action || '') && x.pieces != null && sameCo(x.customer, c.consignee));
  return rows.length ? rows.reduce((n, x) => n + (Number(x.pieces) || 0), 0) : null;
}
function billTotalFor(it, c) {
  const bs = billsOf(it).filter((b) => [b.consignee, b.billToCustomer].some((r) => r && typeof r === 'object' && [r.clientId, r.clientID, r.customerId, r.code, r.id].some((v) => v != null && v !== '' && c.consigneeId && id5(v) === id5(c.consigneeId)))
    || (c.consignee && [b.billToName, b.consignee && (b.consignee.name || b.consignee.clientName)].some((n) => n && normCo(n) === normCo(c.consignee))));
  const counted = bs.filter((b) => b.pieces != null);
  return counted.length ? counted.reduce((n, b) => n + (Number(b.pieces) || 0), 0) : null;
}
function addDay(a, c, d) {
  const sh = new Map((a.shippers || []).map((x) => [x.shipper, { ...x }]));
  for (const x of c.shippers || []) { const y = sh.get(x.shipper) || { shipper: x.shipper, boxes: 0, scanned: 0, missing: 0 }; y.boxes += x.boxes; y.scanned += x.scanned; y.missing += x.missing; sh.set(x.shipper, y); }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { ...a, boxes: a.boxes + c.boxes, scanned: a.scanned + c.scanned, missing: a.missing + c.missing, cubes: r2((a.cubes || 0) + (c.cubes || 0)), scannedCubes: r2((a.scannedCubes || 0) + (c.scannedCubes || 0)),
    shippers: [...sh.values()].sort((x, y) => y.missing - x.missing), shipDates: [...(a.shipDates || []), d] };
}
export function loadBoxes(it, summaryFor, now = Date.now()) {
  const date = shipDateOf(it, now);
  if (!date) return null;
  const { ids, names } = loadCustomers(it);
  const mine = (c) => (c.consigneeId && ids.has(id5(c.consigneeId))) || (c.consignee && names.has(normCo(c.consignee)));
  const keyOf = (c) => (c.consigneeId ? id5(c.consigneeId) : normCo(c.consignee));
  const byKey = new Map();
  for (const c of (summaryFor(date) || []).filter(mine)) byKey.set(keyOf(c), { ...c, shipDates: [date] });
  // the customer's boxes on earlier ship dates
  const earlier = new Map();   // key → [{ d, c }] newest first
  for (let k = 1; k <= LOOKBACK; k++) {
    const d = dayBefore(date, k);
    for (const c of (summaryFor(d) || []).filter(mine)) if (c.boxes > 0) earlier.set(keyOf(c), [...(earlier.get(keyOf(c)) || []), { d, c }]);
  }
  for (const [key, days] of earlier) {
    const cur = byKey.get(key);
    const ref = cur || days[0].c;
    const target = sheetTotalFor(it, ref) ?? billTotalFor(it, ref);
    const have = cur ? cur.boxes : 0;
    if (target == null || have >= target) continue;
    // the fewest, most recent earlier days whose boxes add up EXACTLY to what's still unaccounted for
    let pick = null;
    for (let m = 1; m < (1 << days.length); m++) {
      const set = days.filter((_, i) => m & (1 << i));
      if (set.reduce((n, x) => n + x.c.boxes, 0) !== target - have) continue;
      if (!pick || set.length < pick.length) pick = set;
    }
    if (!pick) continue;
    let acc = cur || null;
    for (const { d, c } of pick) acc = acc ? addDay(acc, c, d) : { ...c, shipDates: [d] };
    byKey.set(key, acc);
  }
  // a customer split between trailers (ARTIS Truck Builder, truckbuilder.js): the EDI count covers ALL their
  // trailers — this trip gets this truck's share; boxes never received are the customer's, on either trailer
  const tbStops = (it._tb && it._tb.stops) || [];
  for (const [k, c] of byKey) {
    // this customer's stops on this truck (one per city); split ones only
    const mineTb = tbStops.filter((x) => (x.consigneeId && c.consigneeId && id5(x.consigneeId) === id5(c.consigneeId)) || sameCo(x.consignee, c.consignee));
    const b = mineTb.length === 1 ? mineTb[0] : null;   // several cities under one customer → EDI can't be told apart
    if (!b || !b.split) continue;
    const short = Math.max(0, c.boxes - c.scanned);
    const others = (b.splitWith || []).map((x) => `${x.boxes} on ${x.trip ? `trip ${x.trip}` : 'a truck not assigned yet'}`).join(', ');
    byKey.set(k, { ...c, ediBoxes: c.boxes, ediScanned: c.scanned, boxes: b.boxes, scanned: Math.max(0, b.boxes - short), missing: Math.min(short, b.boxes),
      split: `split between trailers: ${b.boxes} on this truck${others ? `, ${others}` : ''}${short ? ` — ${short} not received for this customer could be on either trailer` : ''}` });
  }
  const stops = [...byKey.values()].sort((a, b) => b.missing - a.missing || String(a.consignee).localeCompare(String(b.consignee)));
  if (!stops.length) return null;
  const tot = stops.reduce((a, c) => ({ boxes: a.boxes + c.boxes, scanned: a.scanned + c.scanned }), { boxes: 0, scanned: 0 });
  const st = String(tripOf(it).status || '');
  const notLeft = !ROLLING.test(st) && !DONE.test(st);
  const missing = Math.max(0, tot.boxes - tot.scanned);
  const short = stops.filter((c) => c.missing > 0);
  // the trip sheet's box count per customer vs ARTIS — ARTIS is always the right count
  const same = sameCo;
  const sheet = ((it._manifest && it._manifest.stops) || []).filter((x) => /DELIVER/i.test(x.action || '') && x.pieces != null);
  const sheetDiffs = stops.map((c) => {
    if (c.split) return null;   // split: the Truck Builder check compares each truck's share
    const rows = sheet.filter((x) => same(x.customer, c.consignee));
    if (!rows.length) return null;
    const n = rows.reduce((a, x) => a + (Number(x.pieces) || 0), 0);
    return n !== c.boxes ? { consignee: c.consignee, sheet: n, artis: c.boxes } : null;
  }).filter(Boolean);
  return {
    sheetDiffs,
    shipDate: date, boxes: tot.boxes, scanned: tot.scanned, missing,
    stops: stops.map((c) => ({ consigneeId: c.consigneeId, consignee: c.consignee, boxes: c.boxes, scanned: c.scanned, missing: c.missing, cubes: c.cubes, ...(c.shipDates && c.shipDates.length > 1 ? { shipDates: c.shipDates } : {}), ...(c.split ? { split: c.split } : {}), shippers: (c.shippers || []).filter((x) => x.missing > 0) })),
    // before the truck leaves: boxes for a customer on it still not scanned
    // "not scanned" in ARTIS = never received at our terminal from the shipper (not left behind)
    alert: notLeft && missing > 0 ? `${missing} box${missing === 1 ? '' : 'es'} not received from the shipper yet — ${short.map((c) => `${c.consignee} ${c.scanned}/${c.boxes}${c.split ? ' (split — could be on the other trailer)' : ''}${(c.shippers || []).filter((x) => x.missing > 0).length ? ` (${c.shippers.filter((x) => x.missing > 0).map((x) => `${x.shipper} ${x.missing}`).join(', ')})` : ''}`).join(', ')}` : null,
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
  const rows = x.stops.flatMap((c) => {
    const sh = (c.shippers || []).filter((s2) => s2.missing > 0);
    return sh.length ? sh.map((s2) => `<tr><td>${c.consignee}${c.consigneeId ? ` (${c.consigneeId})` : ''}</td><td>${s2.shipper}</td><td>${s2.boxes}</td><td>${s2.scanned}</td><td><b>${s2.missing}</b></td></tr>`)
      : [`<tr><td>${c.consignee}${c.consigneeId ? ` (${c.consigneeId})` : ''}</td><td>—</td><td>${c.boxes}</td><td>${c.scanned}</td><td><b>${c.missing}</b></td></tr>`];
  }).join('');
  return {
    subject: `Truck ${x.truck || '?'} left — ${x.missing} box${x.missing === 1 ? '' : 'es'} not received from the shipper — trip ${x.trip}`,
    html: `<p>Trip <b>${x.trip}</b>${x.truck ? ` · truck <b>${x.truck}</b>` : ''} departed ${when} ET. ARTIS shows <b>${x.missing}</b> ${x.missing === 1 ? 'box that was' : 'boxes that were'} never received at our terminal (${x.scanned} of ${x.boxes} received, ship date ${x.shipDate}).</p>
<table border="1" cellpadding="6" cellspacing="0"><tr><th>Customer</th><th>Shipper</th><th>Expected (EDI)</th><th>Received</th><th>Not received</th></tr>${rows}</table>
<p><b>Verify whether they were rejected, or contact the shipper.</b></p>`,
    text: `Trip ${x.trip} truck ${x.truck || '?'} left ${when} ET — ${x.missing} box(es) not received from the shipper: ${x.stops.map((c) => `${c.consignee} ${c.scanned}/${c.boxes}`).join(', ')}. Verify whether they were rejected, or contact the shipper.`,
  };
}

export function initArtis(app, { requireAuth, requireAdmin = null, db = null, sendMail = null, recipients = null, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
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
    // today / tomorrow / yesterday every time; the older days (held boxes riding later trucks) once an hour
    const older = !refresh.olderAt || t - refresh.olderAt > 60 * MIN;
    if (older) refresh.olderAt = t;
    const days = [0, 1, -1, ...(older ? [-2, -3, -4, -5, -6] : [])];
    for (const d of days.map((k) => ymd(new Date(t + k * 86400000)))) {
      try { byDate.set(d, summarizeCargo(rowsOf(await get('/artis/api/cargo/received', { shipDate: d })))); } catch (e) { console.warn('[artis] refresh', d, e.message); } // eslint-disable-line no-await-in-loop
    }
    for (const k of [...byDate.keys()]) if (Date.parse(k) < t - 8 * 86400000) byDate.delete(k);
  }
  if (env.NODE_ENV !== 'test') {
    setTimeout(() => { refresh().catch(() => {}); }, 30000).unref?.();
    const tick = setInterval(() => { refresh().catch(() => {}); }, 10 * MIN); if (tick.unref) tick.unref();
  }
  // a truck that left short → one email per trip (to the "Truck left with missing boxes" list — Employees → Alert emails)
  const leftTo = async () => (recipients ? recipients('artis_left_short') : ['ntellez@floridabeauty.us']);
  // turned off 2026-10-13 (owner's call) — set ARTIS_LEFT_SHORT_EMAILS=on in Render to send them again.
  // The trip card chip and Jarvis's answers about boxes not received stay on.
  const leftShortOn = () => /^(1|on|true|yes)$/i.test(String(env.ARTIS_LEFT_SHORT_EMAILS || ''));
  async function notifyLeftShort(list) {
    if (!leftShortOn()) return 0;
    if (!list.length || !db || !db.enabled || !sendMail) return 0;
    let fresh = [];
    await db.update('taArtisLeftShort', (cur) => {
      const a = { ...(cur || {}) };
      fresh = list.filter((x) => !a[x.trip]);
      for (const x of fresh) a[x.trip] = { at: new Date(now()).toISOString(), missing: x.missing };
      for (const [k, v] of Object.entries(a)) if (Date.parse(v.at) < now() - 14 * 86400000) delete a[k];
      return a;
    }, {});
    const to = fresh.length ? await leftTo() : [];
    if (fresh.length && !to.length) { console.warn('[artis] left-short: nobody on the list (Employees → Alert emails)'); return 0; }
    for (const x of fresh) { try { await sendMail({ to, ...leftShortEmail(x) }); } catch (e) { console.warn('[artis] left-short email:', e.message); } } // eslint-disable-line no-await-in-loop
    return fresh.length;
  }
  const lastLoads = new Map();   // trip → the load as last seen with ARTIS boxes (for "send me this alert again")
  async function overlay(site, trips) {
    if (!byDate.size) return;
    const short = [];
    for (const it of trips) {
      const b = loadBoxes(it, (d) => byDate.get(d) || null, now());
      if (!b) continue;
      it._artis = b;
      lastLoads.set(String(tripOf(it).tripNumber || ''), it);
      if (lastLoads.size > 600) lastLoads.delete(lastLoads.keys().next().value);
      const x = leftShort(it, now()); if (x) short.push(x);
    }
    if (short.length) notifyLeftShort(short).catch((e) => console.warn('[artis] left-short:', e.message));
  }

  // admin: send the "truck left — boxes not received" email for one trip again, to the person asking (to check
  // how it reads). Ignores the once-per-trip rule; never goes to the alert list.
  app.post('/truckmate/artis/left-short/:trip/send', requireAdmin || requireAuth, async (req, res) => {
    const it = lastLoads.get(String(req.params.trip));
    if (!it || !it._artis) return res.status(404).json({ error: 'That trip has no ARTIS boxes on the board right now.' });
    const dep = ((it._times && it._times.statusHistory) || []).find((h) => /^DEPSHIP/i.test(String(h.status || '')) && h.at);
    const x = leftShort(it, dep ? Date.parse(dep.at) + 60000 : now());
    if (!x) return res.status(409).json({ error: it._artis.missing ? 'The truck has not left yet.' : 'No boxes missing on this trip.' });
    const to = [(req.user && req.user.email) || ''].filter((a) => /@/.test(a));
    if (!to.length || !sendMail) return res.status(400).json({ error: 'No email for your login.' });
    try { await sendMail({ to, ...leftShortEmail(x) }); res.json({ sent: true, to, subject: leftShortEmail(x).subject }); } catch (e) { res.status(502).json({ error: e.message }); }
  });

  console.log(`[artis] Florida Beauty EDI ${artisConfig(env).ready ? 'connected (read-only)' : 'off — needs ARTIS_API_USER / ARTIS_API_PASSWORD'}`);
  return { ready: () => artisConfig(env).ready, cargo, dayOfService, overlay, refresh, notifyLeftShort, _byDate: byDate };
}

// ---- missing boxes on a load a customer asked about → the team gets an email (never the customer) ----
// Pure: the email for a list of { trip, truck, shipDate, consignee, consigneeId, boxes, scanned, missing }.
export function missingEmail(list, { caller = null } = {}) {
  const rows = list.map((m) => `<tr><td>${m.trip}</td><td>${m.truck || '—'}</td><td>${m.consignee}${m.consigneeId ? ` (${m.consigneeId})` : ''}</td><td>${m.scanned} of ${m.boxes}</td><td><b>${m.missing}</b></td><td>${m.shipDate}</td></tr>`).join('');
  const first = list[0];
  return {
    subject: `Boxes not received from the shipper — ${first.consignee} · trip ${first.trip} (${first.missing})`,
    html: `<p>A customer asked about their delivery and ARTIS shows boxes for them that were never received at our terminal. Jarvis told the customer only how many boxes are loaded — <b>not</b> that any are missing.</p>
<table border="1" cellpadding="6" cellspacing="0"><tr><th>Trip</th><th>Truck</th><th>Customer</th><th>Received</th><th>Not received</th><th>Ship date</th></tr>${rows}</table>
${caller ? `<p>Caller: ${caller}</p>` : ''}<p><b>Verify whether they were rejected, or contact the shipper.</b></p>`,
    text: list.map((m) => `Trip ${m.trip} · ${m.consignee}: ${m.scanned}/${m.boxes} received, ${m.missing} not received from the shipper (ship date ${m.shipDate})`).join('\n'),
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
