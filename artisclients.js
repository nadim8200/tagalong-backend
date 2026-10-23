// ---------------------------------------------------------------
// ARTIS customers (My Clients, ~2,500) → our customer profiles + client list + geofences.
//  • once a day (5 AM Miami) and on request: ARTIS's customer ID, address, ZIP, coordinates, business phone,
//    fax, delivery days, appointment-required, warehouse, credit status for every customer.
//  • customer profiles get it under `artis` (+ the customer ID, the phone / fax as contacts) — a dispatcher's
//    own edits are never overwritten; emails / contacts from TruckMate's client report stay.
//  • the client list (who's calling / emailing, client lookups) gains the ARTIS-only customers and addresses.
//  • every customer with coordinates gets a GEOFENCE (circle, default 300 m) — the AI dispatcher's stop
//    arrival / departure tracking uses them next to Samsara's saved addresses. Dispatch can change the radius,
//    move the pin or turn one off; those edits survive the daily sync.
// Read-only on ARTIS (same web login as the Truck Builder).
// ---------------------------------------------------------------
import { pageVar } from './artisreports.js';

const SITE = 'florida-beauty';
const KEY = `taArtisClients:${SITE}`;
const FENCES = `taGeofences:${SITE}`;
const MIN = 60000;
export const DEFAULT_RADIUS_M = 300;
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const pad = (id) => String(id || '').trim().padStart(5, '0');
const p10 = (x) => String(x || '').replace(/\D+/g, '').slice(-10);

// "<strong>MO</strong> TU <strong>WE</strong>…" → the days in bold (the delivery days). Pure.
export function serviceDays(html) {
  const s = String(html || '');
  const bold = [...s.matchAll(/<strong>\s*([A-Z]{2})\s*<\/strong>/gi)].map((m) => m[1].toUpperCase());
  return DAYS.filter((d) => bold.includes(d));
}
// One ARTIS My Clients row → what we keep. Pure.
export function slimClient(c) {
  const t = c.clientTypeInfo || {};
  const lat = Number(c.posLat); const lng = Number(c.posLong);
  return {
    id: pad(c.client_id), name: String(c.name || '').trim(),
    address: String(c.address_1 || '').trim() || null, address2: String(c.address_2 || '').trim() || null,
    city: String(c.city || '').trim().toUpperCase() || null, state: String(c.province || '').trim().toUpperCase() || null, zip: String(c.postal_code || c.defaultDeliveryZ || '').trim() || null,
    lat: Number.isFinite(lat) && lat ? Math.round(lat * 1e6) / 1e6 : null, lng: Number.isFinite(lng) && lng ? Math.round(lng * 1e6) / 1e6 : null,
    phone: p10(c.business_phone).length === 10 ? p10(c.business_phone) : null, fax: p10(c.fax_phone).length === 10 ? p10(c.fax_phone) : null,
    serviceDays: serviceDays(c.serviceDays), apptReq: !!t.apptReq, warehouse: c.warehouseName || null, creditStatus: t.creditStatus || null,
    active: c.client_status === 'A' && !t.client_is_inactive, flower: !!t.isFlowerClient,
    roles: [t.client_is_consingee && 'receiver', t.client_is_shipper && 'shipper', t.client_is_bill_to && 'bill-to'].filter(Boolean),
  };
}
// TruckMate's client list + ARTIS → one list: ARTIS fills address / ZIP / coordinates / phone for known clients and
// adds the ones TruckMate's report didn't have; TruckMate's emails / contacts / last delivery stay. Pure.
export function mergeClients(tm = [], artis = []) {
  const byId = new Map(tm.map((c) => [pad(c.id), { ...c }]));
  for (const a of artis) {
    const c = byId.get(a.id);
    const extra = { lat: a.lat, lng: a.lng, serviceDays: a.serviceDays, apptReq: a.apptReq, warehouse: a.warehouse, artis: true };
    if (c) {
      byId.set(a.id, { ...c, address: c.address || a.address, city: c.city || a.city, state: c.state || a.state, zip: c.zip || a.zip, phone: c.phone || a.phone, fax: c.fax || a.fax,
        phones: [...new Set([...(c.phones || []), a.phone].filter(Boolean))], ...extra });
    } else {
      byId.set(a.id, { id: a.id, name: a.name, inactive: !a.active, address: a.address, city: a.city, state: a.state, zip: a.zip, phone: a.phone, fax: a.fax, phones: a.phone ? [a.phone] : [], emails: [], contacts: [], lastDelivery: null, ...extra });
    }
  }
  return [...byId.values()];
}
// ARTIS customers → geofences; a dispatcher's edits (radius, pin, off) are kept. Pure.
export function buildFences(artis = [], prev = {}, now = new Date().toISOString()) {
  const out = {};
  for (const a of artis) {
    if (a.lat == null || a.lng == null) continue;
    const old = prev[a.id];
    const edited = old && old.edited ? old : null;
    out[a.id] = {
      id: a.id, name: a.name, address: [a.address, a.address2].filter(Boolean).join(', ') || null, city: a.city, state: a.state, zip: a.zip,
      lat: edited && edited.movedBy ? edited.lat : a.lat, lng: edited && edited.movedBy ? edited.lng : a.lng,
      radiusM: edited && edited.radiusM ? edited.radiusM : DEFAULT_RADIUS_M, active: edited ? edited.active !== false : a.active,
      source: 'ARTIS', artisLat: a.lat, artisLng: a.lng, syncedAt: now,
      ...(edited ? { edited: true, editedBy: edited.editedBy, editedAt: edited.editedAt, ...(edited.movedBy ? { movedBy: edited.movedBy } : {}) } : {}),
    };
  }
  // fences a dispatcher added / kept that ARTIS no longer lists stay
  for (const [id, f] of Object.entries(prev)) if (!out[id] && f.edited) out[id] = f;
  return out;
}
// Geofences in the shape the stop-visit tracker reads (like Samsara addresses). Pure.
export function fencesAsAddresses(fences = {}) {
  return Object.values(fences).filter((f) => f.active !== false && f.lat != null && f.lng != null).map((f) => ({
    id: `cg-${f.id}`, name: f.name, formattedAddress: [f.address, f.city, `${f.state || ''} ${f.zip || ''}`.trim()].filter(Boolean).join(', '),
    source: 'Customer geofence', geofence: { circle: { latitude: f.lat, longitude: f.lng, radiusMeters: f.radiusM || DEFAULT_RADIUS_M } },
  }));
}
// 5 AM Miami, once a day. Pure.
export function syncDue(state = {}, now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  return Number(p.hour) >= 5 && state.day !== day ? day : null;
}

export function initArtisClients(app, { requireAuth, requireAdmin = null, db, artisWeb, clients = null, profiles = null, now = () => Date.now() }) {
  const enabled = () => !!(db && db.enabled && artisWeb && artisWeb.ready && artisWeb.ready());
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  let fenceCache = null;
  const fences = async () => { if (!fenceCache) fenceCache = (await db.get(FENCES, {})) || {}; return fenceCache; };

  async function sync() {
    const list = pageVar(await artisWeb.fetchText('/clients/myclients'), 'shipperClients');
    if (!Array.isArray(list) || !list.length) throw new Error('ARTIS My Clients had no data (session?)');
    const artis = list.map(slimClient).filter((a) => a.id && a.name);
    const at = new Date(now()).toISOString();
    // client list (recognition, lookups)
    let merged = 0;
    if (clients && clients.all && clients.save) { const m = mergeClients(clients.all(), artis); await clients.save(m); merged = m.length; }
    // customer profiles
    let profilesUpdated = 0;
    if (profiles && profiles.applyArtis) profilesUpdated = await profiles.applyArtis(artis);
    // geofences
    const prev = await fences();
    const next = buildFences(artis, prev, at);
    await db.set(FENCES, next); fenceCache = next;
    await db.set(KEY, { at, customers: artis.length, withCoordinates: artis.filter((a) => a.lat != null).length, clientList: merged, profilesUpdated, fences: Object.keys(next).length });
    return { customers: artis.length, fences: Object.keys(next).length, profilesUpdated, clientList: merged };
  }
  if (enabled()) {
    const t = setInterval(async () => {
      try {
        const st = (await db.get(`${KEY}:run`, {})) || {}; const day = syncDue(st, now()); if (!day) return;
        await db.set(`${KEY}:run`, { day, at: new Date(now()).toISOString() });
        const r = await sync(); console.log(`[artis-clients] ${r.customers} customers, ${r.fences} geofences, ${r.profilesUpdated} profiles`);
      } catch (e) { console.warn('[artis-clients]', e.message); }
    }, 15 * MIN);
    if (t.unref) t.unref();
  }

  // the Geofences tab
  app.get('/truckmate/geofences', requireAuth, async (req, res) => {
    const all = Object.values(await fences());
    const q = String(req.query.q || '').toUpperCase().trim();
    const words = q.split(/\s+/).filter(Boolean);
    const hit = (f) => { const hay = `${f.id} ${f.name} ${f.address || ''} ${f.city || ''} ${f.state || ''} ${f.zip || ''}`.toUpperCase(); return words.every((w) => hay.includes(w)); };
    const list = all.filter((f) => !words.length || hit(f)).sort((a, b) => a.name.localeCompare(b.name));
    const st = (await db.get(KEY, {})) || {};
    res.json({ total: all.length, active: all.filter((f) => f.active !== false).length, syncedAt: st.at || null, shown: Math.min(list.length, 200), matching: list.length, fences: list.slice(0, 200) });
  });
  app.put('/truckmate/geofences/:id', requireAuth, async (req, res) => {
    if (!(db && db.enabled)) return res.status(503).json({ error: 'Needs the database.' });
    const id = pad(String(req.params.id || '').replace(/\D/g, ''));
    const b = req.body || {};
    const cur = await fences();
    const f = cur[id];
    if (!f) return res.status(404).json({ error: 'No geofence for that customer.' });
    const radius = b.radiusM != null ? Math.round(Number(b.radiusM)) : f.radiusM;
    if (!(radius >= 50 && radius <= 2000)) return res.status(400).json({ error: 'Radius must be 50–2,000 meters.' });
    const moved = b.lat != null && b.lng != null;
    if (moved && !(Math.abs(Number(b.lat)) <= 90 && Math.abs(Number(b.lng)) <= 180)) return res.status(400).json({ error: 'Bad coordinates.' });
    const next = { ...f, radiusM: radius, active: b.active != null ? !!b.active : f.active !== false, ...(moved ? { lat: Number(b.lat), lng: Number(b.lng), movedBy: who(req) } : {}), edited: true, editedBy: who(req), editedAt: new Date(now()).toISOString() };
    const all = await db.update(FENCES, (c) => ({ ...(c || {}), [id]: next }), {});
    fenceCache = all;
    return res.json(next);
  });
  app.post('/truckmate/artis/clients/sync', requireAdmin || requireAuth, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'ARTIS web login is not set up.' });
    try { res.json(await sync()); } catch (e) { res.status(502).json({ error: e.message }); }
  });

  return { sync, fences, asAddresses: async () => fencesAsAddresses(await fences()) };
}
