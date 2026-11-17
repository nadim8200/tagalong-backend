// ---------------------------------------------------------------
// Yard report: how many trailers we have, how many sit at each hub yard (Miami, Ventura, Memphis, Central Florida /
// Bartow) — by the Thermo King unit's GPS (thermoking.js), so trailers parked without a load count too — and what's
// coming down to Florida (loads delivering in FL, with truck, trailer, where they are and the ETA), so the yard manager
// can plan; and trailers parked away from the hubs for 2+ days (Thermo King positions). Read only; no ARTIS.
// ---------------------------------------------------------------
import { MIAMI_YARDS, haversineMi, brokerLoad } from './watchtower.js';
import { KNOWN_YARDS } from './loadsheet.js';
import { geocodePlace } from './meetwatch.js';
import { getLiveIndex, samsaraTokenFrom, trailerLocations } from './samsara.js';
import { nextParked } from './thermoking.js';

const SITE = 'florida-beauty';
const POINTS = 'taHubPoints';      // hub → [{ lat, lng }] (the yard addresses, looked up once)
const SAM = 'taSamsaraTrailers';   // { units: { trailer: reading + parkedSince }, firstReadAt } — trailers with a Samsara gateway
export const SAM_POLL_MS = 20 * 60000;
export const HUB_MILES = 1;
// Yards pinned where our trucks actually park (the street-address lookup for Bartow landed over a mile away, so the Central Florida
// yard showed 0 while Darwin's inventory had trucks and trailers there — Nov 16: truck 2405 parked at 27.9181, -81.7260)
export const PINNED = { BARTOW: [{ lat: 27.9181, lng: -81.7260, miles: 1 }] };
// added to a hub's looked-up point (both count): Memphis's address point misses the yard Thermo King calls "MEMPHIS YARD"
// — trailer 7135 at 35.0668, -90.0162 is "0.70 km South West of MEMPHIS YARD" (Nov 17)
export const EXTRA_POINTS = { MEMPHIS: [{ lat: 35.0712, lng: -90.0108, miles: 1 }] };
export const PARKED_MS = 2 * 86400000;   // parked away from the hubs this long shows on the Parked tab
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
export const HUB_NAMES = { MIAMI: 'Miami', VENTURA: 'Ventura', MEMPHIS: 'Memphis', BARTOW: 'Central Florida (Bartow)' };
// South Florida: the cities trucks deliver around the Miami yard (Miami-Dade, Broward, Palm Beach). Pure.
const SOUTH_FL = /\b(MIAMI|MEDLEY|DORAL|HIALEAH|OPA[- ]?LOCKA|HOMESTEAD|FLORIDA CITY|SWEETWATER|MIAMI GARDENS|MIAMI LAKES|NORTH MIAMI|AVENTURA|FORT LAUDERDALE|FT LAUDERDALE|HOLLYWOOD|PEMBROKE|MIRAMAR|DAVIE|PLANTATION|SUNRISE|WESTON|POMPANO|DEERFIELD|CORAL SPRINGS|MARGATE|TAMARAC|LAUDERHILL|LAUDERDALE|BOCA RATON|DELRAY|BOYNTON|LAKE WORTH|WEST PALM|PALM BEACH|JUPITER|WELLINGTON|ROYAL PALM|LOXAHATCHEE|RIVIERA BEACH)\b/i;

// The hub a load is headed to, from its destination (the last delivery's place, else TruckMate's destination):
// South Florida → Miami, the rest of Florida → Central Florida (Bartow), Memphis area (TN / MS / AR) → Memphis,
// California → Ventura; anywhere else → null (the dispatcher picks). Pure.
export function hubForDest(item) {
  const t = (item && item.trip) || item || {};
  const bills = (item && (item.freightBills || item.orders)) || [];
  const last = bills.map((b) => b && (b.endZoneDescription || b.endZone)).filter(Boolean).pop();
  const d = String(last || t.destZoneDesc || t.descZoneDesc || '').toUpperCase();
  const st = (d.match(/,\s*([A-Z]{2})\b/) || [])[1] || null;
  if (st === 'FL') return SOUTH_FL.test(d) ? 'MIAMI' : 'BARTOW';
  if (st === 'TN' || st === 'MS' || st === 'AR') return 'MEMPHIS';
  if (st === 'CA') return 'VENTURA';
  return null;
}

// Which hub yard a point is at (within HUB_MILES), else null. Pure.
export function hubAt(p, points = {}) {
  if (!p || p.lat == null || p.lng == null) return null;
  for (const [hub, list] of Object.entries(points)) if ((list || []).some((y) => haversineMi(Number(p.lat), Number(p.lng), y.lat, y.lng) <= (y.miles || HUB_MILES))) return hub;
  return null;
}

// Trailer numbers as both sources write them: "07141" / "7141 " / "tl 7141" → "7141". Pure.
export const trailerKey = (x) => String(x || '').trim().toUpperCase().replace(/^(TL|TRL|TRAILER)\s*/, '').replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
// One trailer list from Thermo King and Samsara (Nov 17: carriers' and other trailers without Thermo King show on Samsara).
// Same trailer in both: the newer position wins (with its parked time); Thermo King's temperatures are always kept. Pure.
export function mergeTrailers(tk = {}, sam = {}) {
  const out = {};
  for (const u of Object.values(tk)) { const k = trailerKey(u.trailer); if (k) out[k] = { ...u, trailer: k, source: 'Thermo King' }; }
  for (const u of Object.values(sam)) {
    const k = trailerKey(u.trailer); if (!k) continue;
    const cur = out[k];
    if (!cur) { out[k] = { ...u, trailer: k, source: 'Samsara' }; continue; }
    if (u.lat != null && String(u.at || '') > String(cur.at || '')) {
      out[k] = { ...cur, lat: u.lat, lng: u.lng, location: u.location || cur.location, at: u.at, mph: u.mph, parkedSince: u.parkedSince, atLeast: u.atLeast, watchStart: u.watchStart, source: 'Samsara + Thermo King' };
    } else out[k] = { ...cur, source: 'Thermo King + Samsara' };
  }
  return out;
}

// The report from Thermo King units, the board and its ETAs. units: { trailer: reading }, etas: { trip: { stops } }. Pure.
export const ROLLING_IN = /^(DEPSHIP|INTRAN|ENROUTE|WAY|ARRCONS|DEPCONS)/i;
export function inboundToFlorida(it) {
  const t = tripOf(it);
  if (!/,\s*FL\b/i.test(String(t.destZoneDesc || ''))) return false;
  if (/,\s*FL\b|MIAMI TERM|\bFL\s*\d{0,5}$/i.test(String(t.origZoneDesc || ''))) return false;   // started in Florida
  if (!brokerLoad(it)) return false;
  return ROLLING_IN.test(String(t.status || '').trim());
}

export function yardReport({ units = {}, items = [], etas = {}, points = {}, now = Date.now(), trackingSince = null }) {
  // a trailer never seen moving since Jarvis began watching: parked at least that long — listed after 12 h, marked so
  const watchStart = trackingSince ? Date.parse(trackingSince) : null;
  const list = Object.values(units);
  const onLoad = new Map(items.map((it) => [String(tripOf(it).trailer || '').trim().toUpperCase().replace(/^0+(?=\d)/, ''), tripNo(it)]));
  const hubs = Object.fromEntries(Object.keys(HUB_NAMES).map((h) => [h, []]));
  let elsewhere = 0; let unknown = 0; const parked = [];
  for (const u of list) {
    if (u.lat == null || u.lng == null) { unknown += 1; continue; }   // no GPS: not counted as on the road
    const h = hubAt(u, points);
    if (!h) {
      elsewhere += 1;
      const ps = Date.parse(u.parkedSince || '');
      const ws = u.watchStart ? Date.parse(u.watchStart) : watchStart;   // a Samsara trailer: since Jarvis began reading Samsara trailers
      const sinceTracking = !!(u.atLeast && ws && ps <= ws + 60 * 60000 && now - ps >= 12 * 3600000 && now - ps < PARKED_MS);
      if (Number.isFinite(ps) && (now - ps >= PARKED_MS || sinceTracking)) parked.push({ sinceTracking, hours: Math.floor((now - ps) / 3600000), source: u.source || null, trailer: u.trailer, location: u.location || null, lat: u.lat, lng: u.lng, parkedSince: u.parkedSince, atLeast: !!u.atLeast, days: Math.floor((now - ps) / 86400000), seenAt: u.at, ageMin: Math.round((now - Date.parse(u.at)) / 60000), unitOn: u.powerOn, returnF: u.returnF, setF: u.setF, supplyF: u.supplyF ?? null, onLoad: onLoad.get(u.trailer) || null });
      continue;
    }
    hubs[h].push({ hub: HUB_NAMES[h], source: u.source || null, trailer: u.trailer, seenAt: u.at, ageMin: Math.round((now - Date.parse(u.at)) / 60000), unitOn: u.powerOn, returnF: u.returnF, setF: u.setF, supplyF: u.supplyF ?? null, onLoad: onLoad.get(u.trailer) || null });
  }
  for (const h of Object.keys(hubs)) hubs[h].sort((a, b) => String(a.trailer).localeCompare(String(b.trailer), 'en', { numeric: true }));
  // coming down to Florida: only trailers out in the country on an ACTIVE broker load into FL — picked up outside Florida
  // and rolling (departed the shipper, between stops or at a Florida stop). Never Miami outbounds, never loads only booked
  // (assigned / dispatched / spotted / at the shipper still loading).
  const inbound = items.filter(inboundToFlorida)
    .map((it) => {
      const t = tripOf(it); const s = it._samsara || {}; const e = (etas[tripNo(it)] || {}).stops || []; const last = e[e.length - 1] || null;
      const tk = it._tkApi || null;
      return { trip: tripNo(it), status: t.status || null, truck: String(t.powerUnit || '').trim() || null, trailer: String(t.trailer || '').trim() || null, from: t.origZoneDesc || null, to: t.destZoneDesc || null,
        southFlorida: SOUTH_FL.test(String(t.destZoneDesc || '')), driver: (s.driver1Info && s.driver1Info.name) || s.driver1 || (it._oc && it._oc.driverName) || null,
        where: s.location || (tk && tk.location) || null, gpsAt: s.gpsAt || (tk && tk.at) || null, mph: s.speedMph ?? null,
        milesLeft: last && last.miles != null ? Math.round(Number(last.miles)) : null, etaMs: last && last.etaMs ? last.etaMs : null,
        reeferF: tk ? tk.returnF : null, setF: tk ? tk.setF : null, supplyF: tk ? (tk.supplyF ?? null) : null, broker: /^B/i.test(String(((it.freightBills || [])[0] || {}).billNumber || '')) };
    })
    .sort((a, b) => (a.etaMs || 9e15) - (b.etaMs || 9e15));
  return {
    at: new Date(now).toISOString(), trailers: list.length,
    hubs: Object.entries(hubs).map(([h, l]) => ({ key: h, hub: HUB_NAMES[h], count: l.length, trailers: l })),
    elsewhere, unknown, parked: parked.sort((a, b) => a.parkedSince.localeCompare(b.parkedSince)), inbound, southFlorida: inbound.filter((x) => x.southFlorida).length,
  };
}

const norm = (x) => String(x == null ? '' : x).trim().toUpperCase().replace(/^0+(?=\d)/, '');
const DONE = /^(DELV|CMPLT|CANC|VOID)/i;
// One driver for the page: name, duty status and drive / shift time left. Pure.
const crewMember = (name, h) => (name ? { name, status: (h && h.status) || null, driveLeftMin: h && h.driveLeftMin != null ? h.driveLeftMin : null, shiftLeftMin: h && h.shiftLeftMin != null ? h.shiftLeftMin : null } : null);

// The trucks: every Samsara truck's GPS, the drivers on it (the load's drivers, else whoever's logged in on it), team or solo,
// their hours, and the load it's on — at a hub yard or out on the road. idx = Samsara's live index (samsara.js). Pure.
export function truckReport({ idx = {}, items = [], etas = {}, points = {}, now = Date.now() }) {
  const seen = new Set(); const trucks = [];
  for (const st of Object.values(idx.statsByUnit || {})) {
    const unit = norm(st && st.name);
    if (!unit || seen.has(unit)) continue;
    seen.add(unit); trucks.push({ unit, st });
  }
  const onVehicle = {};
  for (const h of Object.values(idx.hosById || {})) if (h && h.vehicle && h.driverName) (onVehicle[norm(h.vehicle)] = onVehicle[norm(h.vehicle)] || []).push(h);
  const loadOf = (unit) => items.find((it) => norm(tripOf(it).powerUnit) === unit && !DONE.test(String(tripOf(it).status || ''))) || null;
  const hubs = Object.fromEntries(Object.keys(HUB_NAMES).map((h) => [h, []]));
  const road = []; let unknown = 0;
  for (const { unit, st } of trucks) {
    const g = st.gps || {};
    const it = loadOf(unit); const t = it ? tripOf(it) : null; const s = (it && it._samsara) || {};
    const drivers = it && (s.driver1 || s.driver2)
      ? [crewMember(s.driver1, s.hos), crewMember(s.driver2, s.hos2)].filter(Boolean)
      : (onVehicle[unit] || []).slice(0, 2).map((h) => crewMember(h.driverName, h));
    const e = it ? ((etas[tripNo(it)] || {}).stops || []) : []; const last = e[e.length - 1] || null;
    const row = {
      unit, drivers, crew: drivers.length >= 2 ? 'Team' : drivers.length === 1 ? 'Solo' : 'No driver',
      trip: it ? tripNo(it) : null, status: t ? t.status || null : null, from: t ? t.origZoneDesc || null : null, to: t ? t.destZoneDesc || null : null,
      southFlorida: !!(t && SOUTH_FL.test(String(t.destZoneDesc || ''))), toFlorida: !!(t && /,\s*FL\b/i.test(String(t.destZoneDesc || ''))),
      where: (g.reverseGeo && g.reverseGeo.formattedLocation) || null, lat: g.latitude ?? null, lng: g.longitude ?? null,
      mph: g.speedMilesPerHour != null ? Math.round(g.speedMilesPerHour) : null, gpsAt: g.time || null,
      etaMs: last && last.etaMs ? last.etaMs : null, milesLeft: last && last.miles != null ? Math.round(Number(last.miles)) : null,
    };
    if (row.lat == null || row.lng == null) { unknown += 1; continue; }   // no GPS: not counted as on the road
    const h = hubAt(row, points);
    if (h) hubs[h].push({ ...row, hub: HUB_NAMES[h], ageMin: row.gpsAt ? Math.round((now - Date.parse(row.gpsAt)) / 60000) : null });
    else road.push(row);
  }
  for (const h of Object.keys(hubs)) hubs[h].sort((a, b) => a.unit.localeCompare(b.unit, 'en', { numeric: true }));
  road.sort((a, b) => (a.etaMs || 9e15) - (b.etaMs || 9e15));
  return {
    at: new Date(now).toISOString(), trucks: trucks.length, unknown,
    hubs: Object.entries(hubs).map(([h, l]) => ({ key: h, hub: HUB_NAMES[h], count: l.length, trucks: l })),
    road, onRoad: road.length, toFlorida: road.filter((x) => x.toFlorida).length, southFlorida: road.filter((x) => x.southFlorida).length,
  };
}

export function initYardReport(app, { requireAuth, db, getBoard, geo = (q) => geocodePlace(q, null), now = () => Date.now(), onTrailers = null }) {
  // the yards' points: Miami's three lots are known; the others are looked up once from their addresses and kept
  async function points() {
    const saved = (await db.get(POINTS, {})) || {};
    const out = { MIAMI: MIAMI_YARDS.map((y) => ({ lat: y.lat, lng: y.lng, miles: 0.5 })), ...PINNED };
    for (const h of ['VENTURA', 'MEMPHIS', 'BARTOW']) {
      if (out[h]) continue;
      if (saved[h]) { out[h] = saved[h]; continue; }
      const y = KNOWN_YARDS[h];
      const g = y ? await geo(y.address).catch(() => null) : null; // eslint-disable-line no-await-in-loop
      if (g && g.lat != null) { out[h] = [{ lat: g.lat, lng: g.lng }]; await db.update(POINTS, (cur) => ({ ...(cur || {}), [h]: out[h] }), {}); } // eslint-disable-line no-await-in-loop
    }
    for (const [h, list] of Object.entries(EXTRA_POINTS)) out[h] = [...(out[h] || []), ...list];
    return out;
  }
  // Samsara trailer GPS (one light request, cached 2 min by samsara.js) every 20 min: each trailer's position and, like
  // Thermo King, since when it has sat within half a mile without moving
  async function readSamsara() {
    const token = samsaraTokenFrom(process.env);
    if (!token || !db || !db.enabled) return { skipped: 'no Samsara' };
    const [loc, idx] = await Promise.all([trailerLocations(token), getLiveIndex(token).catch(() => ({}))]);
    const names = (idx && idx.trailerAssets) || {};
    const st = (await db.get(SAM, {})) || {};
    const units = { ...(st.units || {}) }; const at = new Date(now()).toISOString();
    const firstReadAt = st.firstReadAt || at;
    for (const [id, fix] of Object.entries((loc && loc.byId) || {})) {
      const name = trailerKey(names[id]); if (!name || fix.lat == null) continue;
      const x = { trailer: name, lat: fix.lat, lng: fix.lng, at: fix.at || at, mph: fix.speedMph ?? null, location: fix.location || null, watchStart: firstReadAt };
      if (!units[name] || String(x.at) >= String(units[name].at || '')) units[name] = { ...x, ...nextParked(units[name], x) };
    }
    // a silent trailer stays (its last position is where it sits) until it reports again
    await db.set(SAM, { units, firstReadAt, lastRead: at, source: (loc && loc.source) || null, error: (loc && loc.error) || null });
    return { units: Object.keys(units).length };
  }
  let samTimer = null;
  if (app && db && db.enabled && process.env.NODE_ENV !== 'test') {
    // every 20 min: read Samsara trailers, then the trailer watch (30+ days parked, moving without a load) on the merged list
    const tick = async () => {
      await readSamsara().catch((e) => console.warn('[yard-samsara]', e.message));
      if (!onTrailers) return;
      const units = mergeTrailers(((await db.get('taThermoKing', {})) || {}).units || {}, ((await db.get(SAM, {})) || {}).units || {});
      const board = await getBoard(SITE).catch(() => null);
      await onTrailers(units, (board && board.trips) || [], await points()).catch((e) => console.warn('[trailer-watch]', e.message));
    };
    samTimer = setInterval(() => { tick(); }, SAM_POLL_MS);
    if (samTimer.unref) samTimer.unref();
    setTimeout(() => { tick(); }, 30000);
  }
  async function report() {
    const tkSt = (await db.get('taThermoKing', {})) || {};
    const samSt = (await db.get(SAM, {})) || {};
    const units = mergeTrailers(tkSt.units || {}, samSt.units || {});
    const board = await getBoard(SITE);
    const etas = ((await db.get(`taWatch:${SITE}`, {})) || {}).etas || {};
    const all = Object.values(units);
    const sources = { thermoKing: all.filter((u) => /Thermo King/.test(u.source || '')).length, samsara: all.filter((u) => /Samsara/.test(u.source || '')).length, samsaraOnly: all.filter((u) => u.source === 'Samsara').length };
    return { ...yardReport({ units, items: (board && board.trips) || [], etas, points: await points(), now: now(), trackingSince: tkSt.firstReadAt || null }), trackingSince: tkSt.firstReadAt || null, samsaraSince: samSt.firstReadAt || null, sources };
  }
  async function trucks() {
    const token = samsaraTokenFrom(process.env);
    const idx = token ? await getLiveIndex(token) : {};
    const board = await getBoard(SITE);
    const etas = ((await db.get(`taWatch:${SITE}`, {})) || {}).etas || {};
    return truckReport({ idx, items: (board && board.trips) || [], etas, points: await points(), now: now() });
  }
  if (app && requireAuth) app.get('/truckmate/yard-report/trucks', requireAuth, async (req, res) => { try { res.json(await trucks()); } catch (e) { res.status(502).json({ error: e.message }); } });
  if (app && requireAuth) app.get('/truckmate/yard-report', requireAuth, async (req, res) => { try { res.json(await report()); } catch (e) { res.status(502).json({ error: e.message }); } });
  // the hub a release is for: where the load is headed (releases are given during the run, not at a yard)
  const hubOf = async (item) => hubForDest(item);
  return { report, trucks, hubOf, readSamsara };
}
