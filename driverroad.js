// ---------------------------------------------------------------
// What the driver sees on the road (Nov 21, 2026 — "build 1, 2, 3, 4, 6"): extra facts on each load in the driver app.
//   · notes: each stop's delivery instructions from the customer's TruckMate profile (the reefer agent reads them — View Notes
//     → Consignee, the Address boxes, Shipping Instructions) — the same notes Jarvis reads to staff
//   · temp: the trailer's reading against what the load needs, with the same freeze line Jarvis alerts on (≤ 33°F)
//   · wait: when dispatch's waiting-time clock starts at a stop the driver checked in at (3 hours after arrival or the appointment)
//   · truck parking: truck stops near the truck, ahead of it when it's moving (Google Places, cached by area)
// Only facts: nothing here changes a load. Pure helpers, plus the truck-stop lookup.
// ---------------------------------------------------------------
import { normName } from './profiles.js';
import { FREEZE_F } from './tempalert.js';

const S = (x) => String(x == null ? '' : x).trim();
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const WAIT_FREE_MIN = 180;   // waitingtime.js FREE_MS: the clock starts 3 hours after arrival (or the appointment, if later)

// a customer name on a stop vs. the name on the TruckMate profile: every word of the shorter one is in the other. Pure.
export function sameCustomer(a, b) {
  const x = normName(a); const y = normName(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const w = new Set(long.split(' '));
  const words = short.split(' ').filter((t) => t.length > 1);
  return words.length > 0 && words.every((t) => w.has(t));
}

// The notes for each stop (by its check-in key), plus pickup notes and any we couldn't place on a stop. Pure.
export function stopNotes(item, stops = []) {
  const all = ((item && item._customerNotes) || []).filter((c) => c && S(c.notes));
  const byStop = {}; const used = new Set();
  for (const st of stops) {
    const c = all.find((x) => (x.roles || []).includes('consignee') && sameCustomer(st.name, x.name));
    if (c) { byStop[st.key] = { customer: c.name || st.name, notes: S(c.notes).slice(0, 1500), readAt: c.readAt || null }; used.add(c); }
  }
  // one delivery stop and one consignee profile we couldn't match by name: it's that stop
  const leftC = all.filter((c) => !used.has(c) && (c.roles || []).includes('consignee'));
  const open = stops.filter((s) => !byStop[s.key]);
  if (stops.length === 1 && open.length === 1 && leftC.length === 1) { const c = leftC[0]; byStop[open[0].key] = { customer: c.name || open[0].name, notes: S(c.notes).slice(0, 1500), readAt: c.readAt || null }; used.add(c); }
  const pickup = all.filter((c) => !used.has(c) && (c.roles || []).includes('shipper')).map((c) => ({ customer: c.name, notes: S(c.notes).slice(0, 1500), readAt: c.readAt || null }));
  pickup.forEach((p) => { const c = all.find((x) => x.name === p.customer); if (c) used.add(c); });
  const other = all.filter((c) => !used.has(c)).map((c) => ({ customer: c.name, notes: S(c.notes).slice(0, 1500), readAt: c.readAt || null }));
  return { byStop, pickup, other };
}

// The trailer temperature the board shows (Samsara, Thermo King, TruckMate or ARTIS), checked against the load. Pure.
export function tempFor(item, now = Date.now()) {
  const lt = item && item._loadTemp; const c = lt && lt.current;
  if (!c || num(c.readingF) == null) return null;
  const readingF = num(c.readingF); const setF = num(c.setF);
  const at = c.at || null; const ageMin = at && !Number.isNaN(Date.parse(at)) ? Math.round((now - Date.parse(at)) / 60000) : null;
  if (ageMin != null && ageMin > 240) return null;                      // an old reading would mislead more than help
  const target = lt.target ? { minF: num(lt.target.minF), maxF: num(lt.target.maxF), text: lt.target.text || null } : null;
  const check = lt.check || {};
  // the same line the temp alerts use: at or below 33°F freezes flowers, unless the load itself is meant to run that cold
  const freeze = readingF <= FREEZE_F && !(target && target.minF != null && target.minF <= FREEZE_F);
  const level = freeze ? 'freeze' : check.status === 'out' ? 'off' : check.status === 'ok' ? 'ok' : 'unknown';
  return { readingF, setF, target, level, source: c.source || null, at, ageMin };
}

// When the waiting-time clock starts at a stop the driver checked in at (ms), and whether they're still there. Pure.
export function waitStart(arrivedAt, apptAt = null) {
  const a = Date.parse(arrivedAt || ''); if (Number.isNaN(a)) return null;
  const p = Date.parse(apptAt || ''); return Math.max(a, Number.isNaN(p) ? 0 : p) + WAIT_FREE_MIN * 60000;
}

// Everything above for one of the driver's loads. Pure.
export function roadFacts(item, { stops = [], now = Date.now() } = {}) {
  if (!item) return null;
  const l = item._samsara || {};
  const pos = num(l.lat) != null && num(l.lng) != null && !(num(l.lat) === 0 && num(l.lng) === 0) ? { lat: num(l.lat), lng: num(l.lng), course: num(l.course), speedMph: num(l.speedMph), at: l.gpsAt || null } : null;
  return { notes: stopNotes(item, stops), temp: tempFor(item, now), pos, waitFreeMin: WAIT_FREE_MIN };
}

// ---------- truck parking near the truck ----------
const R = 3958.8;
const rad = (d) => (d * Math.PI) / 180;
export const milesBetween = (a, b) => { const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
export const bearing = (a, b) => { const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat)); const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng)); return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360; };
// Places near the truck, closest first; when it's moving with a heading, only ones ahead of it (within 75°). Pure.
export function aheadOf(pos, places = [], { max = 6 } = {}) {
  const moving = pos && num(pos.speedMph) > 5 && num(pos.course) != null;
  return places.filter((p) => p && num(p.lat) != null && num(p.lng) != null)
    .map((p) => ({ ...p, miles: Math.round(milesBetween(pos, p) * 10) / 10, dir: bearing(pos, p) }))
    .filter((p) => !moving || p.miles < 2 || Math.min(Math.abs(p.dir - pos.course), 360 - Math.abs(p.dir - pos.course)) <= 75)
    .sort((a, b) => a.miles - b.miles).slice(0, max)
    .map(({ dir, ...p }) => p);
}

// Truck stops within ~40 miles (Google Places text search), cached per ~7-mile square for 12 hours so a whole fleet costs a few
// lookups a day. → [{ name, address, lat, lng, open }]
export function truckStopFinder({ db, env = process.env, fetchFn = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const key = env.GOOGLE_PLACES_KEY || env.GOOGLE_MAPS_KEY || env.GOOGLE_GEOCODE_KEY || env.GOOGLE_ROUTES_KEY || '';
  const CACHE = 'taTruckStops';
  return async function find(pos) {
    if (!key || !pos) return { places: [], why: key ? 'no position' : 'not set up' };
    const cell = `${(Math.round(pos.lat * 10) / 10).toFixed(1)},${(Math.round(pos.lng * 10) / 10).toFixed(1)}`;
    const cache = (db && db.enabled ? await db.get(CACHE, {}).catch(() => ({})) : {}) || {};
    const hit = cache[cell];
    if (hit && now() - Date.parse(hit.at) < 12 * 3600000) return { places: hit.places };
    const r = await fetchFn('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.currentOpeningHours.openNow' },
      body: JSON.stringify({ textQuery: 'truck stop', maxResultCount: 20, locationBias: { circle: { center: { latitude: pos.lat, longitude: pos.lng }, radius: 50000 } } }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Places ${r.status}: ${t.slice(0, 160)}`); }
    const j = await r.json();
    const places = (j.places || []).map((p) => ({ name: (p.displayName && p.displayName.text) || 'Truck stop', address: p.formattedAddress || null, lat: p.location && p.location.latitude, lng: p.location && p.location.longitude, open: p.currentOpeningHours ? !!p.currentOpeningHours.openNow : null }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (db && db.enabled) await db.update(CACHE, (cur) => ({ ...Object.fromEntries(Object.entries(cur || {}).slice(-400)), [cell]: { at: new Date(now()).toISOString(), places } }), {}).catch(() => {});
    return { places };
  };
}
