// ---------------------------------------------------------------
// Mile calculator for staff: "how many miles from 2403 to its next stop?", "miles from Miami to Carbone Derry?",
// "how far is Boston from Hartford?", "miles left on trip 625717, stop by stop". Points can be a truck (its live GPS),
// a customer on a load (that stop's city / zip), our Miami or Ventura hub, or any city / zip / address.
// Driving miles from Google Routes when a server key is set; else straight line × 1.2, said as "about".
// ---------------------------------------------------------------
import { haversineMi, estimateArrival, MIAMI_TERMINAL } from './watchtower.js';
import { geocodePlace } from './meetwatch.js';
import { nameScore } from './voice.js';
import { realUnit } from './units.js';

const tripOf = (it) => (it && it.trip) || it || {};
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const unitOf = (it) => String(tripOf(it).powerUnit || '').replace(/^0+/, '').toUpperCase();
const fits = (a, b) => Math.max(nameScore(a || '', b || ''), nameScore(b || '', a || '')) >= 0.75;
const VENTURA = { lat: 34.2746, lng: -119.229, label: 'our Ventura, California hub' };
const round = (x) => Math.round(x);

// the trip's stops not yet delivered, one per destination, in stop order (trip sheet first, then nearest next). Pure.
export function openStops(item, from = null) {
  const groups = new Map();
  for (const b of billsOf(item)) {
    const label = String(b.endZoneDescription || b.endZone || '').trim(); if (!label) continue;
    const g = groups.get(label) || { place: label, customers: [], boxes: 0, delivered: true };
    const name = String(b.billToName || '').replace(/\s*\*$/, '').trim();
    if (name && !g.customers.includes(name)) g.customers.push(name);
    g.boxes += Number(b.pieces) || 0;
    if (!b.actualDelivery) g.delivered = false;
    groups.set(label, g);
  }
  const sheet = ((item && item._manifest && item._manifest.stops) || []).filter((s) => /DELIVER/i.test(s.action || ''));
  const norm = (c) => String(c || '').toUpperCase().replace(/[^A-Z ]/g, '').trim();
  const open = [...groups.values()].filter((g) => !g.delivered);
  for (const g of open) {
    const hit = sheet.find((s) => norm(s.city) === norm(g.place.split(',')[0]));
    g.seq = hit && hit.stopNumber != null ? Number(hit.stopNumber) : null;
  }
  return open.sort((a, b) => (a.seq != null ? a.seq : 999) - (b.seq != null ? b.seq : 999));
}

// a staff question's place → a point. Pure apart from the geocoder it is given.
export async function resolvePoint(q, { board = [], geocode }) {
  const s = String(q || '').trim(); if (!s) return null;
  if (/^(?:(?:our |the )?(?:miami )?(?:hub|yard|terminal|cooler)|miami(?:,?\s*(?:fl|florida))?)$/i.test(s)) return { ...MIAMI_TERMINAL, label: 'our Miami hub' };
  if (/^(?:(?:our |the )?ventura(?: hub| terminal)?(?:,?\s*(?:ca|california))?)$/i.test(s)) return VENTURA;
  // a truck number → its live GPS
  const m = s.match(/^(?:truck\s*#?\s*)?([A-Z]{0,3}\d{2,5}|OC\d+)$/i);
  if (m) {
    const u = realUnit(m[1]).replace(/^0+/, '').toUpperCase();
    const it = board.find((x) => unitOf(x) === u && x._samsara && x._samsara.lat != null);
    if (it) { const g = it._samsara; return { lat: g.lat, lng: g.lng, label: `truck ${u}${g.location ? ` (near ${g.location})` : ''}`, at: g.gpsAt || null, truck: u, item: it }; }
    if (/^\d{5}$/.test(s)) { /* a zip, below */ } else return { missing: `Truck ${u} has no live GPS on the board.` };
  }
  // a customer on a load → that stop's city / zip
  for (const it of board) {
    const b = billsOf(it).find((x) => x.billToName && fits(s, String(x.billToName).replace(/\s*\*$/, '')));
    if (b && b.endZoneDescription) { const g = await geocode(b.endZoneDescription); if (g) return { lat: g.lat, lng: g.lng, label: `${String(b.billToName).replace(/\s*\*$/, '').trim()} (${b.endZoneDescription})` }; }
  }
  const g = await geocode(s);
  return g ? { lat: g.lat, lng: g.lng, label: g.formatted || s } : null;
}

export function initMiles({ db, env = process.env, fetchFn = globalThis.fetch, geocoder = null, now = () => Date.now() }) {
  const key = env.GOOGLE_ROUTES_KEY || env.GOOGLE_GEOCODE_KEY || env.GOOGLE_MAPS_KEY || '';
  const enabled = !!(db && db.enabled);
  let cache = null; // { geo: {q: pt}, road: {a>b: {mi, min}} }
  const load = async () => { if (!cache) cache = (enabled ? await db.get('taMilesCache', null).catch(() => null) : null) || { geo: {}, road: {} }; return cache; };
  const save = async () => { if (enabled) await db.set('taMilesCache', cache).catch(() => {}); };
  const cell = (p) => `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;

  async function geocode(q) {
    const c = await load(); const k = String(q).toUpperCase().trim();
    if (k in c.geo) return c.geo[k];
    const g = await (geocoder ? geocoder(q) : geocodePlace(q, null, { env, fetchFn })).catch(() => null);
    c.geo[k] = g ? { lat: g.lat, lng: g.lng, formatted: g.formatted } : null; await save();
    return c.geo[k];
  }

  // driving miles + minutes between two points
  async function road(a, b) {
    const straight = haversineMi(a.lat, a.lng, b.lat, b.lng);
    if (straight < 0.5) return { miles: 0, minutes: 0, exact: true };
    const c = await load(); const k = `${cell(a)}>${cell(b)}`;
    if (c.road[k]) return { ...c.road[k], exact: true };
    if (key) {
      try {
        const r = await fetchFn('https://routes.googleapis.com/directions/v2:computeRoutes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' },
          body: JSON.stringify({ origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } }, destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } }, travelMode: 'DRIVE' }),
        });
        const j = await r.json().catch(() => null);
        const rt = j && j.routes && j.routes[0];
        if (r.ok && rt && rt.distanceMeters) {
          c.road[k] = { miles: Math.round(rt.distanceMeters / 1609.34), minutes: Math.round(parseInt(String(rt.duration || '0'), 10) / 60) || null };
          await save();
          return { ...c.road[k], exact: true };
        }
      } catch { /* estimate below */ }
    }
    return { miles: round(straight * 1.2), minutes: null, exact: false };
  }

  // for a truck's trip: miles from the truck to each stop left, leg by leg and in total, with an HOS-aware ETA
  async function tripLegs(item, start) {
    const hos = ((item && item._samsara) || {}).hos || {};
    const team = !!tripOf(item).driver2;
    let at = start; let total = 0; let exact = true; const legs = [];
    for (const st of openStops(item).slice(0, 10)) {
      const g = await geocode(st.place); // eslint-disable-line no-await-in-loop
      if (!g) { legs.push({ stop: st.place, customers: st.customers, miles: null, note: 'could not place this stop' }); continue; }
      const r = await road(at, g); // eslint-disable-line no-await-in-loop
      total += r.miles; exact = exact && r.exact; at = g;
      const eta = estimateArrival(total, { team, driveLeftMin: hos.driveLeftMin, shiftLeftMin: hos.shiftLeftMin, now: now() });
      legs.push({ stop: st.place, customers: st.customers, boxes: st.boxes || null, leg_miles: r.miles, miles_from_truck: total, driving_eta: eta ? new Date(eta).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : null });
    }
    return { legs, total_miles: total, exact };
  }

  // from / to: any place, truck or customer. truck or trip alone → miles to every stop it has left.
  async function ask({ from = null, to = null, truck = null, trip = null } = {}, board = []) {
    let item = null;
    if (trip) { const n = String(trip).replace(/\D/g, ''); item = board.find((x) => String(tripOf(x).tripNumber || x._id || '') === n) || null; if (!item) return { found: false, note: `Trip ${n} is not on the live board.` }; }
    if (!item && truck) { const u = realUnit(String(truck)).replace(/^0+/, '').toUpperCase(); item = board.find((x) => unitOf(x) === u && openStops(x).length) || board.find((x) => unitOf(x) === u) || null; }
    if (!from && item) from = unitOf(item) || null;
    if (!from && truck) from = String(truck);
    const a = from ? await resolvePoint(from, { board, geocode }) : null;
    if (a && a.missing) return { found: false, note: a.missing };
    if (!a) return { found: false, note: from ? `Could not place "${from}".` : 'Say where from (a truck, a customer, a city or zip).' };
    if (!to) {
      const it = item || a.item;
      if (!it) return { found: false, note: 'Say where to (a customer, a city, a zip).' };
      const r = await tripLegs(it, a);
      return { found: true, from: a.label, gps_at: a.at || null, trip: String(tripOf(it).tripNumber || ''), truck: unitOf(it) || null, stops: r.legs, total_miles: r.total_miles, driving_miles: r.exact, note: r.legs.length ? null : 'Every stop on this trip is delivered.' };
    }
    const b = await resolvePoint(to, { board, geocode });
    if (b && b.missing) return { found: false, note: b.missing };
    if (!b) return { found: false, note: `Could not place "${to}".` };
    const r = await road(a, b);
    const hos = ((a.item && a.item._samsara) || {}).hos || {};
    const eta = a.truck && r.miles ? estimateArrival(r.miles, { team: !!tripOf(a.item).driver2, driveLeftMin: hos.driveLeftMin, shiftLeftMin: hos.shiftLeftMin, now: now() }) : null;
    return {
      found: true, from: a.label, to: b.label, miles: r.miles, driving_miles: r.exact,
      drive_time: r.minutes ? `${Math.floor(r.minutes / 60)}h ${r.minutes % 60}m without stops` : null,
      truck_eta_with_hours_of_service: eta ? new Date(eta).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : null,
      gps_at: a.at || null,
    };
  }

  return { ask, road, geocode };
}
