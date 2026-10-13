// ---------------------------------------------------------------
// Descartes MacroPoint → outside-carrier (OC) locations on our trips.
// The office already tracks OC loads in MacroPoint. MacroPoint calls this server (a "callback") with each
// location ping and trip event; we match it to the trip by the Load / Order ID the office typed (our trip
// number, a TruckMate bill, the broker's load #, a PO…) and the trip gets that position like a truck of
// ours: ETA, miles to the next stop, passed stops, Jarvis.
// MacroPoint's exact callback fields come with API access, so this reads XML, JSON, form or query string
// and the usual field names — and keeps the last raw messages so the format can be confirmed.
// Secured: Basic auth (MACROPOINT_CALLBACK_USER / _PASSWORD) or a key in the URL (MACROPOINT_CALLBACK_KEY).
// ---------------------------------------------------------------
import { timingSafeEqual } from 'crypto';

const SITE = 'florida-beauty';
const KEY = `taMacroPoint:${SITE}`;
const MIN = 60000;
export const FRESH_MIN = 180;   // a MacroPoint ping counts as live for 3 h (OC drivers' phones ping less often)
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const norm = (x) => String(x == null ? '' : x).toUpperCase().replace(/[^A-Z0-9]/g, '');

// Any message → flat { lowercased field: value } (XML tags / attributes, JSON at any depth, form, query). Pure.
export function flatten(body, query = {}) {
  const out = {};
  const put = (k, v) => { const key = String(k).toLowerCase().replace(/[^a-z0-9]/g, ''); if (v == null || v === '' || typeof v === 'object') return; if (!(key in out)) out[key] = String(v).trim(); };
  const walk = (o) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object') walk(v); else put(k, v); } };
  for (const [k, v] of Object.entries(query || {})) put(k, v);
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) { walk(body); return out; }
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  if (!text.trim()) return out;
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { walk(JSON.parse(t)); return out; } catch { /* not JSON */ } }
  if (t.startsWith('<')) {
    for (const m of t.matchAll(/<([A-Za-z_][\w.-]*)(\s[^>]*)?>([^<]*)<\/\1>/g)) put(m[1].split(':').pop(), m[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    for (const m of t.matchAll(/\s([A-Za-z_][\w.-]*)="([^"]*)"/g)) put(m[1].split(':').pop(), m[2]);
    return out;
  }
  for (const [k, v] of new URLSearchParams(t)) put(k, v);
  return out;
}

const pick = (f, names) => { for (const n of names) if (f[n] != null && f[n] !== '') return f[n]; return null; };
// The ping / event in it. Pure. → { orderId, lat, lng, at, city, state, zip, street, source, event, stop } | null
export function readPing(f) {
  const orderId = pick(f, ['mporderid', 'orderid', 'loadid', 'loadnumber', 'shipmentid', 'trackingrequestid', 'referencenumber', 'ordernumber', 'id']);
  const lat = Number(pick(f, ['latitude', 'lat']));
  const lng = Number(pick(f, ['longitude', 'lon', 'lng', 'long']));
  // the time: a UTC field without a zone gets "Z"; anything with a zone is read as written
  const tKey = ['locationdatetimeutc', 'datetimeutc', 'eventdatetimeutc', 'createddatetimeutc', 'locationdatetime', 'eventdatetime', 'datetime', 'timestamp', 'time'].find((k) => f[k]);
  const at0 = tKey ? f[tKey] : null;
  let at = at0 ? (/^\d{10,13}$/.test(at0) ? Number(at0) * (at0.length === 10 ? 1000 : 1) : Date.parse(/utc/.test(tKey) && !/z$|[+-]\d\d:?\d\d$/i.test(at0) ? `${at0.replace(' ', 'T')}Z` : at0)) : NaN;
  if (Number.isNaN(at)) at = null;
  const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  const event = pick(f, ['tripevent', 'eventtype', 'event', 'eventcode', 'status', 'statuscode']);
  if (!orderId || (!ok && !event)) return null;
  return {
    orderId: String(orderId).trim(), lat: ok ? lat : null, lng: ok ? lng : null, at,
    city: pick(f, ['city']), state: pick(f, ['state', 'stateprovince', 'province']), zip: pick(f, ['postal', 'postalcode', 'zip', 'zipcode']), street: pick(f, ['street1', 'street', 'address1', 'address']),
    source: pick(f, ['datasource', 'source', 'locationsource']), event: event || null, stop: pick(f, ['stopname', 'stopid', 'stop', 'stopnumber']),
  };
}

// Which trip a MacroPoint Load / Order ID is: our trip number, a TruckMate bill, the broker's load # / reference
// numbers on the rate con, a PO or reference on a bill. Pure. → trip | null
export function tripFor(orderId, items) {
  const id = norm(orderId);
  if (!id) return null;
  const six = (String(orderId).match(/\b6\d{5}\b/) || [])[0];
  if (six && items.some((it) => tripNo(it) === six)) return six;
  for (const it of items) {
    const rc = (it._ratecon && (it._ratecon.data || it._ratecon)) || {};
    const ids = [tripNo(it), ...billsOf(it).flatMap((b) => [b.billNumber, b.poNumber, b.po, b.reference, b.referenceNumber, b.customerReference]), rc.loadNumber, ...(rc.referenceNumbers || []), it._oc && it._oc.loadNumber].filter(Boolean).map(norm);
    if (ids.includes(id)) return tripNo(it);
  }
  return null;
}

// Basic auth or the URL key, compared in constant time. Pure.
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
export function authorized(req, env) {
  const user = env.MACROPOINT_CALLBACK_USER; const pass = env.MACROPOINT_CALLBACK_PASSWORD; const key = env.MACROPOINT_CALLBACK_KEY;
  if (!((user && pass) || key)) return { ok: false, code: 503, why: 'MacroPoint callback not set up (set MACROPOINT_CALLBACK_USER / _PASSWORD or MACROPOINT_CALLBACK_KEY in Render)' };
  const h = String((req.get && req.get('authorization')) || (req.headers && req.headers.authorization) || '');
  if (user && pass && /^basic /i.test(h)) {
    const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    if (same(u, user) && same(p.join(':'), pass)) return { ok: true };
  }
  const k = (req.query && req.query.key) || (req.params && req.params.key);
  if (key && k && same(k, key)) return { ok: true };
  return { ok: false, code: 401, why: 'not authorized' };
}

// The raw body when no parser read it (XML / text). → string
async function rawOf(req) {
  if (req.rawBody) return Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody);
  if (req.body !== undefined && !(req.body && typeof req.body === 'object' && !Object.keys(req.body).length)) return req.body;
  if (!req.readable) return '';
  return new Promise((resolve) => { let s = ''; req.setEncoding && req.setEncoding('utf8'); req.on('data', (c) => { s += c; if (s.length > 200000) req.destroy(); }); req.on('end', () => resolve(s)); req.on('error', () => resolve(s)); });
}

export function initMacroPoint(app, { requireAdmin, db, getBoard = null, env = process.env, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  let cache = null;
  const load = async () => { if (!cache) cache = (await db.get(KEY, null)) || { byTrip: {}, raw: [], unmatched: [], orderMap: {} }; return cache; };
  const save = async () => { await db.set(KEY, cache); };

  async function receive(body, query) {
    const st = await load();
    const f = flatten(body, query);
    st.raw = [{ at: new Date(now()).toISOString(), fields: Object.fromEntries(Object.entries(f).slice(0, 40)) }, ...(st.raw || [])].slice(0, 30);
    const p = readPing(f);
    if (!p) { await save(); return { ok: true, used: false, why: 'no order id / location in the message' }; }
    let trip = st.orderMap[norm(p.orderId)] || null;
    if (!trip && getBoard) { const b = await getBoard(SITE).catch(() => null); trip = tripFor(p.orderId, (b && b.trips) || []); if (trip) st.orderMap[norm(p.orderId)] = trip; }
    if (!trip) { st.unmatched = [{ at: new Date(now()).toISOString(), orderId: p.orderId, city: p.city, state: p.state }, ...(st.unmatched || []).filter((x) => x.orderId !== p.orderId)].slice(0, 30); await save(); return { ok: true, used: false, why: `no trip for MacroPoint load ${p.orderId}` }; }
    const cur = st.byTrip[trip] || { trip, orderId: p.orderId, events: [] };
    const at = p.at || now();
    if (p.lat != null && (!cur.at || at >= Date.parse(cur.at))) Object.assign(cur, { lat: p.lat, lng: p.lng, at: new Date(at).toISOString(), city: p.city || null, state: p.state || null, zip: p.zip || null, street: p.street || null, source: p.source || null });
    if (p.event) cur.events = [{ at: new Date(at).toISOString(), event: p.event, stop: p.stop || null, city: p.city || null, state: p.state || null }, ...(cur.events || [])].slice(0, 20);
    cur.receivedAt = new Date(now()).toISOString();
    st.byTrip[trip] = cur;
    for (const [k, v] of Object.entries(st.byTrip)) if (Date.parse(v.receivedAt) < now() - 10 * 24 * 60 * MIN) delete st.byTrip[k];
    await save();
    return { ok: true, used: true, trip };
  }

  // MacroPoint → us (location pings and trip events). Always answers 200 once authorized, so MacroPoint doesn't retry forever.
  const handler = async (req, res) => {
    const a = authorized(req, env);
    if (!a.ok) return res.status(a.code).json({ error: a.why });
    if (!enabled) return res.status(503).json({ error: 'storage off' });
    try { const r = await receive(await rawOf(req), req.query || {}); res.status(200).json(r); } catch (e) { console.warn('[macropoint]', e.message); res.status(200).json({ ok: false }); }
  };
  app.post('/macropoint/callback', handler);
  app.get('/macropoint/callback', handler);

  // the board: an OC trip MacroPoint tracks gets its position (unless our own GPS is fresher)
  async function overlay(site, trips) {
    if (!enabled) return;
    const st = await load();
    for (const it of trips) {
      const r = st.byTrip[tripNo(it)];
      if (!r) continue;
      it._macropoint = { at: r.at || null, city: r.city, state: r.state, source: r.source, orderId: r.orderId, events: (r.events || []).slice(0, 5), fresh: !!(r.at && now() - Date.parse(r.at) < FRESH_MIN * MIN) };
      const s = it._samsara || null;
      const ownNewer = s && s.lat != null && s.gpsAt && r.at && Date.parse(s.gpsAt) > Date.parse(r.at);
      if (r.lat != null && !ownNewer) it._samsara = { ...(s || {}), source: 'MacroPoint', lat: r.lat, lng: r.lng, gpsAt: r.at, speedMph: s && s.source !== 'MacroPoint' ? s.speedMph : null, location: [r.street, r.city, r.state].filter(Boolean).join(', ') || null };
    }
  }

  app.get('/truckmate/macropoint/status', requireAdmin, async (req, res) => {
    const st = enabled ? await load() : { byTrip: {}, raw: [], unmatched: [] };
    res.json({ configured: !!((env.MACROPOINT_CALLBACK_USER && env.MACROPOINT_CALLBACK_PASSWORD) || env.MACROPOINT_CALLBACK_KEY), tracked: Object.values(st.byTrip).map((r) => ({ trip: r.trip, orderId: r.orderId, at: r.at, city: r.city, state: r.state, events: (r.events || []).length })), unmatched: st.unmatched || [], lastMessages: (st.raw || []).slice(0, 5) });
  });

  return { overlay, receive };
}
