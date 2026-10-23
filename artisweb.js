// ---------------------------------------------------------------
// ARTIS (floridabeauty.com) — the customer-facing Trip Status and Trip Manifest pages, read with the same
// read-only web login as the Truck Builder (ARTIS_WEB_USER / ARTIS_WEB_PASSWORD in Render). Never changes anything.
//
//  • ETAs: twice a day (10 AM and 4 PM Miami time) Jarvis reads ARTIS's own ETA, miles to destination, current
//    location, GPS ping and arrived / delivered for every customer stop on the active ARTIS runs — shown beside
//    our ETA on each stop so dispatch can verify both.
//  • Trip Manifest Detail (summary / detail / detail-with-farm) PDF for one customer on one trip: fetched on
//    demand, stored on the trip (kind "manifest"), for the console, Ask Jarvis, and customer email replies.
// One sign-in at a time; a refused sign-in waits an hour before trying again (no lock-outs).
// ---------------------------------------------------------------
import { webConfig } from './truckbuilder.js';
import { nameScore } from './voice.js';

const SITE = 'florida-beauty';
const KEY = `taArtisEta:${SITE}`;
const MIN = 60000;
const UA = 'FBF-Jarvis (read-only)';
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
export const MANIFEST_KINDS = { summary: '/trip/manifest/print/summary', detail: '/trip/manifest/print/detail', farm: '/trip/manifest/print/farm-detail' };

// The Trip Status page carries its data as `var stops = [...]` on one line. → the trip statuses, or null. Pure.
export function parseTripStatus(html) {
  const s = String(html || '');
  const k = s.indexOf('var stops = ');
  if (k < 0) return null;
  const end = s.indexOf('\n', k + 12);
  try { return JSON.parse(s.slice(k + 12, end < 0 ? undefined : end).trim().replace(/;$/, '')); } catch { return null; }
}
// One ARTIS trip status → what we keep (no driver names / cell phones). Pure.
export function slimStatus(t, clientId) {
  const i = t.tripStatusInfo || {};
  const d = t.destinationClient || {};
  return {
    trip: t.tripNumber != null ? String(t.tripNumber) : null, clientId: String(d.clientId || clientId || ''), name: String(d.name || '').trim() || null,
    city: d.city || null, state: d.state || null, truck: t.powerUnit || null, trailer: t.trailer || null,
    boxes: t.countInfo ? Number(t.countInfo.boxesQty) || 0 : null, cubes: t.countInfo ? Number(t.countInfo.boxesCubes) || 0 : null,
    pallets: t.countInfo ? Number(t.countInfo.palletsQty) || 0 : null,
    route: t.truckSeqno || null, warehouse: (t.warehouseInfo && t.warehouseInfo.warehouseName) || null, origin: t.siteDisplayName || null,
    etaMs: Number(i.etaLong || i.etaDateTimeObj) || null, etaText: i.etaDateTimeStr || null,
    miles: i.milesToDestination != null ? Number(i.milesToDestination) : null, location: i.currentLocation || null,
    gpsMs: Number(i.gpsPingDate) || null, gpsText: i.gpsPingDateStr || null,
    arrived: !!(t.arrived || i.arrived), delivered: !!(t.delivered || i.delivered), arrivedAt: t.arrivedAt || null,
    shippers: (t.tripStatusDetails || []).length,
  };
}
// ARTIS's customer list entry "DESIGNERS CHOICE BOSTON - 02281 - BOSTON, MA" → { id, name, city, state }. Pure.
export function parseConsignee(x) {
  const m = String((x && x.text) || '').match(/ - (\d{3,6}) - ([^,]*),\s*([A-Z]{2})\s*$/);
  return { id: String((x && x.value) || (m && m[1]) || ''), name: String((x && x.clientName) || '').trim(), city: m ? m[2].trim().toUpperCase() : '', state: m ? m[3] : '' };
}
// The ARTIS customer for a stop by name (+ city / state when several match). Pure. → id | null
export function pickConsignee(list, { name, city = '', state = '' }) {
  const fit = (c) => Math.max(nameScore(name, c.name), nameScore(c.name, name));
  const hits = (list || []).map((c) => ({ c, s: fit(c) })).filter((x) => x.s >= 0.75);
  if (!hits.length) return null;
  const town = String(city || '').toUpperCase().split(',')[0].trim();
  const st = String(state || '').toUpperCase();
  hits.sort((a, b) => ((town && b.c.city === town ? 1 : 0) + (st && b.c.state === st ? 0.5 : 0) + b.s) - ((town && a.c.city === town ? 1 : 0) + (st && a.c.state === st ? 0.5 : 0) + a.s));
  return hits[0].c.id || null;
}
// When the twice-a-day read is due: 10 AM and 4 PM Miami time, once each per day. Pure.
export function etaSlotDue(state = {}, now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`; const h = Number(p.hour);
  const slot = h >= 16 ? 'pm' : h >= 10 ? 'am' : null;
  return slot && !(state.done || {})[`${day}|${slot}`] ? `${day}|${slot}` : null;
}
const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export function initArtisWeb(app, { requireAuth, requireAdmin = null, db, docs = null, getBoard = null, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const cfg = () => webConfig(env);
  const enabled = () => !!(db && db.enabled) && cfg().ready;
  let session = null; let refusedAt = 0;

  async function signIn() {
    if (session && now() - session.at < 25 * MIN) return session.cookie;
    if (now() - refusedAt < 60 * MIN) throw new Error('ARTIS sign-in was refused recently — waiting before trying again.');
    const { base, user, password } = cfg();
    const r = await fetchFn(`${base}/login?serviceUrl=/shipment/eta`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: new URLSearchParams({ username: user, password }).toString() });
    const set = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : String(r.headers.get('set-cookie') || '').split(/,(?=\s*[^;,=\s]+=)/);
    const cookie = set.map((c) => String(c).split(';')[0].trim()).filter(Boolean).join('; ');
    if (!cookie) { refusedAt = now(); throw new Error(`ARTIS sign-in gave no session (HTTP ${r.status})`); }
    session = { cookie, at: now() };
    return cookie;
  }
  async function get(path) {
    const cookie = await signIn();
    const r = await fetchFn(`${cfg().base}${path}`, { headers: { Cookie: cookie, 'User-Agent': UA }, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) { session = null; throw new Error('ARTIS session expired or sign-in not accepted.'); }
    if (!r.ok) throw new Error(`ARTIS answered HTTP ${r.status}`);
    return r;
  }

  // one customer's trips on ARTIS between two dates
  async function tripStatus(clientId, fromDate, toDate) {
    const html = await (await get(`/shipment/eta?clientId=${encodeURIComponent(clientId)}&fromDate=${fromDate}&toDate=${toDate}`)).text();
    const stops = parseTripStatus(html);
    if (!stops) throw new Error('ARTIS Trip Status page had no data (session?)');
    return stops.flatMap((c) => (c.tripStatuses || []).map((t) => slimStatus(t, c.clientId)));
  }
  // the Trip Manifest PDF for one customer on one trip → Buffer
  async function manifestPdf({ clientId, trip, kind = 'detail', fromDate, toDate }) {
    const path = MANIFEST_KINDS[kind] || MANIFEST_KINDS.detail;
    const q = new URLSearchParams({ clientId: String(clientId), tripNumber: String(trip), ...(fromDate ? { fromDate } : {}), ...(toDate ? { toDate } : {}) });
    const r = await get(`${path}?${q}`);
    if (!/pdf/i.test(r.headers.get('content-type') || '')) throw new Error('ARTIS did not return a PDF for that trip / customer.');
    return Buffer.from(await r.arrayBuffer());
  }
  // fetch the manifest and keep it on the trip (re-used for the day) → stored doc { id, name }
  async function manifestDoc({ item, clientId, kind = 'detail', by = 'Jarvis' }) {
    const trip = tripNo(item);
    const tb = item && item._tb;
    const day = tb && tb.date ? tb.date : ymd(now());
    const from = ymd(Date.parse(`${day}T12:00:00Z`) - 3 * 86400000); const to = ymd(now() + 5 * 86400000);
    const stop = ((tb && tb.stops) || []).find((s) => String(s.consigneeId) === String(clientId));
    const name = `Trip-Manifest-${kind === 'detail' ? 'Detail' : kind === 'farm' ? 'Farm-Detail' : 'Summary'}-${trip}-${clientId}.pdf`;
    const memo = `taArtisManifest:${SITE}`;
    const seen = (await db.get(memo, {})) || {};
    const k = `${trip}|${clientId}|${kind}|${ymd(now())}`;
    if (seen[k] && docs) return { ...seen[k], customer: stop ? stop.consignee : null, reused: true };
    const buf = await manifestPdf({ clientId, trip, kind, fromDate: from, toDate: to });
    if (!docs || !docs.storeDocs) return { name, bytes: buf };
    const [d] = await docs.storeDocs({ site: SITE, kind: 'manifest', trip, files: [{ filename: name, mediaType: 'application/pdf', dataBase64: buf.toString('base64') }], by });
    const out = { id: String(d.id), name };
    await db.update(memo, (cur) => Object.fromEntries([...Object.entries({ ...(cur || {}), [k]: out })].slice(-500)), {});
    return { ...out, customer: stop ? stop.consignee : null };
  }

  // ARTIS's customer list (kept 12 h) — finds a stop's ARTIS customer number by name + city
  let consigneeCache = { at: 0, list: [] };
  async function consignees() {
    if (now() - consigneeCache.at < 12 * 60 * MIN && consigneeCache.list.length) return consigneeCache.list;
    const j = await (async () => { const t = await (await get(`/artis_ms/clients/edi/all_consignees/json?qs=${now()}`)).text(); try { return JSON.parse(t); } catch { return null; } })();
    const list = (Array.isArray(j) ? j : []).map(parseConsignee).filter((c) => c.id && c.name);
    if (list.length) consigneeCache = { at: now(), list };
    return list;
  }
  async function clientIdFor({ name, city, state }) { return name ? pickConsignee(await consignees(), { name, city, state }) : null; }

  // the twice-a-day read: ARTIS's ETA for every customer stop on the active ARTIS runs
  async function readEtas() {
    const board = getBoard ? await getBoard(SITE) : { trips: [] };
    const items = ((board && board.trips) || []).filter((it) => it._tb && (it._tb.stops || []).length);
    const want = new Map();   // clientId → earliest run date
    for (const it of items) for (const s of it._tb.stops) if (s.consigneeId) { const d = it._tb.date || ymd(now()); if (!want.has(s.consigneeId) || d < want.get(s.consigneeId)) want.set(s.consigneeId, d); }
    const trips = {}; let read = 0; const errors = [];
    const active = new Set(items.map(tripNo));
    for (const [clientId, d] of want) {
      try {
        const list = await tripStatus(clientId, ymd(Date.parse(`${d}T12:00:00Z`) - 2 * 86400000), ymd(now() + 3 * 86400000)); // eslint-disable-line no-await-in-loop
        read += 1;
        for (const x of list) if (x.trip && active.has(x.trip)) trips[x.trip] = { ...(trips[x.trip] || {}), [x.clientId]: x };
      } catch (e) { errors.push(`${clientId}: ${e.message}`); if (/sign-in|session/i.test(e.message)) break; }
      await new Promise((r) => setTimeout(r, 300)); // eslint-disable-line no-await-in-loop -- gentle on ARTIS
    }
    const at = new Date(now()).toISOString();
    await db.update(KEY, (cur) => ({ ...(cur || {}), at, trips: { ...((cur && cur.trips) || {}), ...trips }, last: { at, customers: want.size, read, errors: errors.slice(0, 10) } }), {});
    return { customers: want.size, read, trips: Object.keys(trips).length, errors };
  }
  async function overlay(site, list) {
    if (!(db && db.enabled)) return;
    const st = (await db.get(KEY, {})) || {};
    for (const it of list) { const x = (st.trips || {})[tripNo(it)]; if (x) it._artisEta = { at: st.at || null, stops: Object.values(x) }; }
  }

  if (enabled()) {
    const tick = async () => {
      const st = (await db.get(KEY, {})) || {};
      const slot = etaSlotDue(st, now());
      if (!slot) return;
      await db.update(KEY, (cur) => ({ ...(cur || {}), done: Object.fromEntries([...Object.entries(((cur && cur.done) || {})), [slot, new Date(now()).toISOString()]].slice(-20)) }), {});
      const r = await readEtas();
      console.log(`[artis-eta] ${slot}: ${r.read}/${r.customers} customers read, ${r.trips} trips${r.errors.length ? `, ${r.errors.length} errors` : ''}`);
    };
    const t = setInterval(() => { tick().catch((e) => console.warn('[artis-eta]', e.message)); }, 10 * MIN); if (t.unref) t.unref();
  }

  // the console: the Trip Manifest PDF for a stop (fetched from ARTIS, kept on the trip)
  app.post('/truckmate/artis/manifest/:trip', requireAuth, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'ARTIS web login is not set up (ARTIS_WEB_USER / ARTIS_WEB_PASSWORD).' });
    try {
      const trip = String(req.params.trip || '').replace(/\D/g, '');
      const b = req.body || {};
      // the ARTIS customer number, or found by the stop's customer name + city (truck not linked on the Truck Builder)
      const clientId = String(b.clientId || '').replace(/[^\w]/g, '') || await clientIdFor({ name: String(b.customer || '').slice(0, 120), city: String(b.city || '').slice(0, 60), state: String(b.state || '').slice(0, 2) });
      const kind = MANIFEST_KINDS[b.kind] ? b.kind : 'detail';
      const item = (((await getBoard(SITE)) || {}).trips || []).find((x) => tripNo(x) === trip) || { trip: { tripNumber: trip } };
      if (!clientId) return res.status(404).json({ error: `Couldn't find "${b.customer || 'that customer'}" in ARTIS's customer list.` });
      const by = (req.user && (req.user.name || req.user.email)) || 'dispatcher';
      return res.json(await manifestDoc({ item, clientId, kind, by }));
    } catch (e) { return res.status(502).json({ error: e.message }); }
  });
  app.post('/truckmate/artis/eta/run', requireAdmin || requireAuth, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'ARTIS web login is not set up.' });
    try { res.json(await readEtas()); } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.get('/truckmate/artis/eta/status', requireAuth, async (req, res) => { const st = (await db.get(KEY, {})) || {}; res.json({ configured: enabled(), at: st.at || null, last: st.last || null, trips: Object.keys(st.trips || {}).length }); });

  // for the other ARTIS readers (artisreports.js): a page's text, or a JSON answer
  const fetchText = async (path) => (await get(path)).text();
  const fetchBuffer = async (path) => { const r = await get(path); return { buf: Buffer.from(await r.arrayBuffer()), type: String(r.headers.get('content-type') || '').toLowerCase() }; };
  const fetchJson = async (path) => { const t = await fetchText(path); try { return JSON.parse(t); } catch { throw new Error('ARTIS did not answer with data (session?)'); } };
  return { tripStatus, manifestPdf, manifestDoc, readEtas, overlay, fetchText, fetchJson, fetchBuffer, clientIdFor, ready: enabled };
}
