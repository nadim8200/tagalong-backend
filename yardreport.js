// ---------------------------------------------------------------
// Yard report: how many trailers we have, how many sit at each hub yard (Miami, Ventura, Memphis, Central Florida /
// Bartow) — by the Thermo King unit's GPS (thermoking.js), so trailers parked without a load count too — and what's
// coming down to Florida (loads delivering in FL, with truck, trailer, where they are and the ETA), so the yard manager
// can plan; and trailers parked away from the hubs for 2+ days (Thermo King positions). Read only; no ARTIS.
// ---------------------------------------------------------------
import { MIAMI_YARDS, haversineMi, brokerLoad } from './watchtower.js';
import { KNOWN_YARDS } from './loadsheet.js';
import { geocodePlace } from './meetwatch.js';
import { getLiveIndex, samsaraTokenFrom } from './samsara.js';

const SITE = 'florida-beauty';
const POINTS = 'taHubPoints';      // hub → [{ lat, lng }] (the yard addresses, looked up once)
export const HUB_MILES = 1;
// Yards pinned where our trucks actually park (the street-address lookup for Bartow landed over a mile away, so the Central Florida
// yard showed 0 while Darwin's inventory had trucks and trailers there — Nov 16: truck 2405 parked at 27.9181, -81.7260)
export const PINNED = { BARTOW: [{ lat: 27.9181, lng: -81.7260, miles: 1 }] };
export const PARKED_MS = 2 * 86400000;   // parked away from the hubs this long shows on the Parked tab
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
export const HUB_NAMES = { MIAMI: 'Miami', VENTURA: 'Ventura', MEMPHIS: 'Memphis', BARTOW: 'Central Florida (Bartow)' };
// South Florida: the cities trucks deliver around the Miami yard (Miami-Dade, Broward, Palm Beach). Pure.
const SOUTH_FL = /\b(MIAMI|MEDLEY|DORAL|HIALEAH|OPA[- ]?LOCKA|HOMESTEAD|FLORIDA CITY|SWEETWATER|MIAMI GARDENS|MIAMI LAKES|NORTH MIAMI|AVENTURA|FORT LAUDERDALE|FT LAUDERDALE|HOLLYWOOD|PEMBROKE|MIRAMAR|DAVIE|PLANTATION|SUNRISE|WESTON|POMPANO|DEERFIELD|CORAL SPRINGS|MARGATE|TAMARAC|LAUDERHILL|LAUDERDALE|BOCA RATON|DELRAY|BOYNTON|LAKE WORTH|WEST PALM|PALM BEACH|JUPITER|WELLINGTON|ROYAL PALM|LOXAHATCHEE|RIVIERA BEACH)\b/i;

// Which hub yard a point is at (within HUB_MILES), else null. Pure.
export function hubAt(p, points = {}) {
  if (!p || p.lat == null || p.lng == null) return null;
  for (const [hub, list] of Object.entries(points)) if ((list || []).some((y) => haversineMi(Number(p.lat), Number(p.lng), y.lat, y.lng) <= (y.miles || HUB_MILES))) return hub;
  return null;
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

export function yardReport({ units = {}, items = [], etas = {}, points = {}, now = Date.now() }) {
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
      if (Number.isFinite(ps) && now - ps >= PARKED_MS) parked.push({ trailer: u.trailer, location: u.location || null, lat: u.lat, lng: u.lng, parkedSince: u.parkedSince, atLeast: !!u.atLeast, days: Math.floor((now - ps) / 86400000), seenAt: u.at, ageMin: Math.round((now - Date.parse(u.at)) / 60000), unitOn: u.powerOn, returnF: u.returnF, setF: u.setF, supplyF: u.supplyF ?? null, onLoad: onLoad.get(u.trailer) || null });
      continue;
    }
    hubs[h].push({ hub: HUB_NAMES[h], trailer: u.trailer, seenAt: u.at, ageMin: Math.round((now - Date.parse(u.at)) / 60000), unitOn: u.powerOn, returnF: u.returnF, setF: u.setF, supplyF: u.supplyF ?? null, onLoad: onLoad.get(u.trailer) || null });
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

export function initYardReport(app, { requireAuth, db, getBoard, geo = (q) => geocodePlace(q, null), now = () => Date.now() }) {
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
    return out;
  }
  async function report() {
    const units = ((await db.get('taThermoKing', {})) || {}).units || {};
    const board = await getBoard(SITE);
    const etas = ((await db.get(`taWatch:${SITE}`, {})) || {}).etas || {};
    return yardReport({ units, items: (board && board.trips) || [], etas, points: await points(), now: now() });
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
  return { report, trucks };
}
