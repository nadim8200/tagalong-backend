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
// MacroPoint times are UTC (ISO 8601); a value with no zone is read as UTC. Pure.
const utc = (v) => { if (!v) return null; if (/^\d{10,13}$/.test(v)) return Number(v) * (v.length === 10 ? 1000 : 1); const t = Date.parse(/z$|[+-]\d\d:?\d\d$/i.test(v) ? v : `${String(v).replace(' ', 'T')}Z`); return Number.isNaN(t) ? null : t; };
export const EVENTS = { X3: 'Arrived at pickup', AF: 'Departed pickup', X1: 'Arrived at delivery', D1: 'Departed delivery' };
// One MacroPoint callback (docs.macropoint.com — all GET with the values in the URL):
//  Location Updates  ?MPOrderID&ID&Latitude&Longitude&…&City&State&Postal&LocationDateTimeUTC&DataSource&Locator
//  Trip Events       ?MPOrderID&ID&Stop&Event(X3/AF/X1/D1)&EventDateTime&StopID&Latitude&Longitude&City&State…
//  Order Status      ?MPOrderID&ID&Code&Message
//  Schedule Alerts   ?MPOrderID&ID&StopName&City&State&ScheduleAlertCode&ScheduleAlertText&DistanceToStopInMiles&EtaToStop…
// ID is the office's Load ID ("624741 NATIVE…"); MPOrderID is MacroPoint's own. Pure. → ping | null
export function readPing(f) {
  const orderId = pick(f, ['id', 'loadid', 'loadnumber', 'orderid', 'shipmentid', 'referencenumber', 'ordernumber']);
  const mpOrderId = pick(f, ['mporderid', 'mptrackingrequestid']);
  const lat = Number(pick(f, ['latitude', 'lat']));
  const lng = Number(pick(f, ['longitude', 'lon', 'lng', 'long']));
  const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  const code = pick(f, ['event', 'tripevent', 'eventtype', 'eventcode']);
  const statusMsg = pick(f, ['message', 'statusmessagedetail']);
  const alertText = pick(f, ['schedulealerttext']);
  const kind = alertText || pick(f, ['schedulealertcode']) ? 'schedule' : code ? 'event' : statusMsg && pick(f, ['code']) ? 'status' : ok ? 'location' : null;
  if ((!orderId && !mpOrderId) || !kind) return null;
  const at = utc(pick(f, ['locationdatetimeutc', 'eventdatetime', 'createddatetime', 'datetimeutc', 'datetime', 'timestamp']));
  const clean = (v) => (v == null ? null : String(v).replace(/\+/g, ' ').trim() || null);
  return {
    kind, orderId: orderId ? String(orderId).trim() : null, mpOrderId: mpOrderId || null,
    lat: ok ? lat : null, lng: ok ? lng : null, at,
    city: pick(f, ['city']), state: pick(f, ['state', 'stateorprovince', 'province']), zip: pick(f, ['postal', 'postalcode', 'zip']), street: pick(f, ['street1', 'addressline1', 'street', 'address1']),
    source: pick(f, ['datasource', 'source']), locator: pick(f, ['locator']),
    event: kind === 'event' ? (EVENTS[String(code).toUpperCase()] || clean(code)) : null, eventCode: kind === 'event' ? String(code).toUpperCase() : null, stop: pick(f, ['stop', 'stopname', 'stopid']),
    status: kind === 'status' ? { code: pick(f, ['code']), message: clean(statusMsg) } : null,
    schedule: kind === 'schedule' ? { alert: clean(alertText), code: pick(f, ['schedulealertcode']), stop: pick(f, ['stopname', 'stopid']), city: pick(f, ['city']), state: pick(f, ['state']), distanceMi: Number(pick(f, ['distancetostopinmiles'])) || null, etaToStop: pick(f, ['etatostop']), etaOffset: pick(f, ['etalocaltimezoneoffset']) } : null,
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
    let trip = (p.orderId && st.orderMap[norm(p.orderId)]) || (p.mpOrderId && st.orderMap[`MP:${p.mpOrderId}`]) || null;
    if (!trip && getBoard && p.orderId) { const b = await getBoard(SITE).catch(() => null); trip = tripFor(p.orderId, (b && b.trips) || []); }
    if (trip) { if (p.orderId) st.orderMap[norm(p.orderId)] = trip; if (p.mpOrderId) st.orderMap[`MP:${p.mpOrderId}`] = trip; }
    if (!trip) { const id = p.orderId || p.mpOrderId; st.unmatched = [{ at: new Date(now()).toISOString(), orderId: id, kind: p.kind, city: p.city, state: p.state }, ...(st.unmatched || []).filter((x) => x.orderId !== id)].slice(0, 30); await save(); return { ok: true, used: false, why: `no trip for MacroPoint load ${id}` }; }
    const cur = st.byTrip[trip] || { trip, orderId: p.orderId, events: [] };
    if (p.orderId) cur.orderId = p.orderId;
    if (p.mpOrderId) cur.mpOrderId = p.mpOrderId;
    const at = p.at || now();
    if (p.lat != null && (p.kind === 'location' || p.kind === 'event') && (!cur.at || at >= Date.parse(cur.at))) Object.assign(cur, { lat: p.lat, lng: p.lng, at: new Date(at).toISOString(), city: p.city || null, state: p.state || null, zip: p.zip || null, street: p.street || null, source: p.source || null, locator: p.locator || cur.locator || null });
    if (p.kind === 'event') cur.events = [{ at: new Date(at).toISOString(), event: p.event, code: p.eventCode, stop: p.stop || null, city: p.city || null, state: p.state || null }, ...(cur.events || [])].slice(0, 20);
    if (p.kind === 'status') cur.status = { ...p.status, at: new Date(now()).toISOString() };
    if (p.kind === 'schedule') cur.schedule = { ...p.schedule, at: new Date(now()).toISOString() };
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
      it._macropoint = { at: r.at || null, city: r.city, state: r.state, source: r.source, orderId: r.orderId, events: (r.events || []).slice(0, 5), status: r.status || null, schedule: r.schedule || null, fresh: !!(r.at && now() - Date.parse(r.at) < FRESH_MIN * MIN) };
      const s = it._samsara || null;
      const ownNewer = s && s.lat != null && s.gpsAt && r.at && Date.parse(s.gpsAt) > Date.parse(r.at);
      if (r.lat != null && !ownNewer) it._samsara = { ...(s || {}), source: 'MacroPoint', lat: r.lat, lng: r.lng, gpsAt: r.at, speedMph: s && s.source !== 'MacroPoint' ? s.speedMph : null, location: [r.street, r.city, r.state].filter(Boolean).join(', ') || null };
    }
  }

  app.get('/truckmate/macropoint/status', requireAdmin, async (req, res) => {
    const st = enabled ? await load() : { byTrip: {}, raw: [], unmatched: [] };
    res.json({ configured: !!((env.MACROPOINT_CALLBACK_USER && env.MACROPOINT_CALLBACK_PASSWORD) || env.MACROPOINT_CALLBACK_KEY), tracked: Object.values(st.byTrip).map((r) => ({ trip: r.trip, orderId: r.orderId, at: r.at, city: r.city, state: r.state, status: r.status ? r.status.message : null, schedule: r.schedule ? r.schedule.alert : null, lastEvent: (r.events || [])[0] || null })), unmatched: st.unmatched || [], lastMessages: (st.raw || []).slice(0, 5) });
  });

  return { overlay, receive };
}
