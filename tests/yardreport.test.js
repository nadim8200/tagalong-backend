import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yardReport, hubAt } from '../yardreport.js';

const NOW = Date.parse('2026-11-16T20:00:00Z');
const points = { MIAMI: [{ lat: 25.7947, lng: -80.3099, miles: 0.5 }], VENTURA: [{ lat: 34.27, lng: -119.24 }], MEMPHIS: [{ lat: 34.95, lng: -89.79 }], BARTOW: [{ lat: 27.87, lng: -81.82 }] };
const u = (trailer, lat, lng, extra = {}) => ({ trailer, lat, lng, at: '2026-11-16T19:40:00.000Z', powerOn: false, returnF: null, setF: null, ...extra });

test('trailers counted per hub yard by their Thermo King GPS; the rest are on the road', () => {
  assert.equal(hubAt({ lat: 25.7950, lng: -80.3101 }, points), 'MIAMI');
  assert.equal(hubAt({ lat: 25.90, lng: -80.30 }, points), null, '7 miles away');
  const units = { 7200: u('7200', 25.7948, -80.31), 7136: u('7136', 34.2701, -119.2401), 2024: u('2024', 27.8702, -81.8199), 7387: u('7387', 30.8, -83.2, { powerOn: true, returnF: 54.5, setF: 55 }) };
  const items = [
    { trip: { tripNumber: '627033', status: 'DEPSHIP', powerUnit: '934', trailer: '7342', origZoneDesc: 'HYDE PARK, MA', destZoneDesc: 'DEERFIELD BEACH, FL, 33442' }, freightBills: [{ billNumber: 'B180949' }], _samsara: { location: 'Opa-locka, FL', driver1: 'Ana R' } },
    { trip: { tripNumber: '627345', status: 'ASSGN', trailer: '7392', origZoneDesc: 'NEWARK, NJ', destZoneDesc: 'JACKSONVILLE, FL' }, freightBills: [{ billNumber: 'B181000' }] },
    { trip: { tripNumber: '627251', status: 'DEPSHIP', powerUnit: '2001', trailer: '7300', origZoneDesc: 'BARTOW, FL', destZoneDesc: 'MIAMI, FL' }, freightBills: [{ billNumber: 'B181001' }] },
    { trip: { tripNumber: '627093', status: 'DEPSHIP', powerUnit: '1082', trailer: '7387', origZoneDesc: 'MEMPHIS, TN', destZoneDesc: 'LAKELAND, FL, 33801' }, freightBills: [{ billNumber: 'H1' }], _tkApi: units[7387] },
    { trip: { tripNumber: '627130', status: 'DEPSHIP', powerUnit: '2604', trailer: '7200', origZoneDesc: 'MIAMI TERMINAL', destZoneDesc: 'WEST SACRAMENTO, CA' }, freightBills: [] },
  ];
  const etas = { 627093: { stops: [{ label: 'LAKELAND, FL', miles: 260, etaMs: NOW + 5 * 3600000 }] }, 627033: { stops: [{ label: 'DEERFIELD BEACH, FL', miles: 30, etaMs: NOW + 3600000 }] } };
  const r = yardReport({ units, items, etas, points, now: NOW });
  assert.equal(r.trailers, 4); assert.equal(r.elsewhere, 1);
  assert.deepEqual(r.hubs.map((h) => [h.hub, h.count]), [['Miami', 1], ['Ventura', 1], ['Memphis', 0], ['Central Florida (Bartow)', 1]]);
  assert.equal(r.hubs[0].trailers[0].onLoad, '627130');
  assert.deepEqual(r.inbound.map((x) => [x.trip, x.southFlorida, x.milesLeft]), [['627033', true, 30]], 'only active broker loads picked up outside FL: not the Miami outbound, not a booked (ASSGN) load, not one from Bartow, not an LTL (H) bill');
  assert.equal(r.southFlorida, 1);
});

test('parked away from the hubs 2+ days: listed longest first; at a hub or under 2 days never', () => {
  const units = {
    7001: { trailer: '7001', lat: 33.5, lng: -84.2, at: '2026-11-16T19:40:00Z', parkedSince: '2026-11-12T08:00:00Z', atLeast: false, location: 'Forest Park, GA', powerOn: false },
    7002: { trailer: '7002', lat: 35.1, lng: -90.0, at: '2026-11-16T19:40:00Z', parkedSince: '2026-11-14T08:00:00Z', atLeast: true, location: 'Memphis, TN' },
    7003: { trailer: '7003', lat: 36.0, lng: -86.0, at: '2026-11-16T19:40:00Z', parkedSince: '2026-11-16T08:00:00Z' },
    7004: { trailer: '7004', lat: 25.7948, lng: -80.31, at: '2026-11-16T19:40:00Z', parkedSince: '2026-11-01T08:00:00Z' },
  };
  const r = yardReport({ units, items: [], etas: {}, points, now: NOW });
  assert.deepEqual(r.parked.map((p) => [p.trailer, p.days, p.atLeast]), [['7001', 4, false], ['7002', 2, true]]);
});

test('trucks: at a hub yard or on the road; drivers from the load (team / solo + hours), else whoever is logged in on it; no GPS not counted', async () => {
  const { truckReport } = await import('../yardreport.js');
  const gps = (lat, lng, mph = 0, place = 'Somewhere') => ({ gps: { latitude: lat, longitude: lng, speedMilesPerHour: mph, time: '2026-11-16T19:50:00Z', reverseGeo: { formattedLocation: place } } });
  const idx = {
    statsByUnit: { 2604: { name: '2604', ...gps(30.5, -83.5, 64, 'I-75, Valdosta, GA') }, '02604': { name: '02604', ...gps(30.5, -83.5) }, 4550: { name: '4550', ...gps(25.7948, -80.31) }, 9999: { name: '9999', gps: {} } },
    hosById: { a: { driverName: 'Ana Ruiz', vehicle: '4550', status: 'offDuty', driveLeftMin: 600, shiftLeftMin: 840 } },
  };
  const items = [{ trip: { tripNumber: '627130', powerUnit: '2604', status: 'DEPSHIP', origZoneDesc: 'HUNTS POINT, NY', destZoneDesc: 'MEDLEY, FL, 33166' },
    _samsara: { driver1: 'Bryan K', hos: { status: 'driving', driveLeftMin: 312 }, driver2: 'Luis P', hos2: { status: 'sleeperBed', driveLeftMin: 660 } } }];
  const etas = { 627130: { stops: [{ label: 'MEDLEY, FL', miles: 470, etaMs: NOW + 8 * 3600000 }] } };
  const r = truckReport({ idx, items, etas, points, now: NOW });
  assert.equal(r.trucks, 3, '2604 / 02604 are one truck'); assert.equal(r.unknown, 1);
  assert.deepEqual(r.hubs.map((h) => [h.hub, h.count]), [['Miami', 1], ['Ventura', 0], ['Memphis', 0], ['Central Florida (Bartow)', 0]]);
  assert.deepEqual(r.hubs[0].trucks[0].drivers, [{ name: 'Ana Ruiz', status: 'offDuty', driveLeftMin: 600, shiftLeftMin: 840 }]); assert.equal(r.hubs[0].trucks[0].crew, 'Solo');
  const t = r.road[0];
  assert.equal(t.unit, '2604'); assert.equal(t.crew, 'Team'); assert.deepEqual(t.drivers.map((d) => [d.name, d.driveLeftMin]), [['Bryan K', 312], ['Luis P', 660]]);
  assert.equal(t.trip, '627130'); assert.equal(t.milesLeft, 470); assert.equal(t.southFlorida, true); assert.equal(t.where, 'I-75, Valdosta, GA');
  assert.equal(r.toFlorida, 1);
});

test('Bartow yard is pinned where the trucks park (Rifle Range Road): truck 2405 counts as Central Florida', async () => {
  const { truckReport, PINNED, hubAt } = await import('../yardreport.js');
  assert.equal(hubAt({ lat: 27.918074, lng: -81.726045 }, { ...points, ...PINNED }), 'BARTOW');
  const idx = { statsByUnit: { 2405: { name: '2405', gps: { latitude: 27.918074, longitude: -81.726045, time: '2026-11-16T19:50:00Z', reverseGeo: { formattedLocation: 'Rifle Range Road, Polk County, FL, 33830' } } } } };
  const r = truckReport({ idx, points: { ...points, ...PINNED }, now: NOW });
  assert.equal(r.hubs.find((h) => h.key === 'BARTOW').count, 1);
});

test('Memphis: trailer 7135 "0.70 km South West of MEMPHIS YARD" counts at the Memphis yard (pinned point added)', async () => {
  const { hubAt, EXTRA_POINTS } = await import('../yardreport.js');
  assert.equal(hubAt({ lat: 35.066755, lng: -90.01618 }, { MEMPHIS: [{ lat: 35.15, lng: -89.9 }, ...EXTRA_POINTS.MEMPHIS] }), 'MEMPHIS');
  assert.equal(hubAt({ lat: 35.2, lng: -90.2 }, { MEMPHIS: EXTRA_POINTS.MEMPHIS }), null, 'miles away: not at the yard');
});

test('Samsara trailers join the yard report: one list by trailer number, the newer position wins, Thermo King temps kept', async () => {
  const { mergeTrailers, trailerKey, yardReport } = await import('../yardreport.js');
  assert.equal(trailerKey(' tl 07141 '), '7141');
  const tk = { 7141: { trailer: '7141', lat: 25.79, lng: -80.31, at: '2026-11-17T10:00:00Z', returnF: 35, setF: 35, parkedSince: '2026-11-17T09:00:00Z', atLeast: false } };
  const sam = {
    7141: { trailer: '07141', lat: 35.2, lng: -80.8, at: '2026-11-17T20:00:00Z', parkedSince: '2026-11-17T14:00:00Z', atLeast: false, location: 'Charlotte, NC' },
    9001: { trailer: '9001', lat: 35.7, lng: -79.4, at: '2026-11-17T20:00:00Z', parkedSince: '2026-11-17T00:00:00Z', atLeast: true, watchStart: '2026-11-17T00:00:00Z', location: 'Siler City, NC' },   // carrier trailer, Samsara only
  };
  const m = mergeTrailers(tk, sam);
  assert.equal(m['7141'].source, 'Samsara + Thermo King'); assert.equal(m['7141'].location, 'Charlotte, NC'); assert.equal(m['7141'].returnF, 35);
  assert.equal(m['9001'].source, 'Samsara');
  // Nov 18: 7366 dropped at Bartow (its own Thermo King GPS), still on truck 2301's TruckMate trip — the truck's GPS (Miami) is a guess
  const tk2 = { 7366: { trailer: '7366', lat: 27.99, lng: -81.9, at: '2026-11-18T20:45:00Z', location: 'BARTOW YARD' } };
  const guess = { trailer: '7366', lat: 25.83, lng: -80.31, at: '2026-11-18T22:36:00Z', via: 'With truck 2301', location: 'Miami, FL' };
  assert.equal(mergeTrailers(tk2, { 7366: guess })['7366'].lat, 27.99, 'the trailer\'s own GPS wins over the truck it was booked on');
  assert.equal(mergeTrailers(tk2, { 7366: { ...guess, at: '2026-11-19T10:00:00Z' } })['7366'].lat, 25.83, 'Thermo King quiet 12 h+: the truck\'s GPS is better than nothing');
  assert.equal(mergeTrailers(tk2, { 7366: { ...guess, via: null } })['7366'].lat, 25.83, 'a real newer fix still wins');
  const r = yardReport({ units: m, items: [], points: {}, now: Date.parse('2026-11-17T20:30:00Z'), trackingSince: '2026-11-16T23:25:00Z' });
  assert.equal(r.trailers, 2);
  const p = r.parked.find((x) => x.trailer === '9001');
  assert.ok(p && p.sinceTracking && p.source === 'Samsara', 'a Samsara trailer not moved since Jarvis began reading Samsara: listed after 12 h');
});

test('Samsara trailers come from the fleet map list (hitched → the truck\'s GPS; dropped → where it was left)', async () => {
  const { initYardReport } = await import('../yardreport.js');
  const m = new Map(); const db = { enabled: true, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? m.get(k) : fb); m.set(k, v); return v; } };
  const fleet = { trailers: [
    { trailer: '2022', lat: 25.8025, lng: -80.3, gpsAt: '2026-11-17T21:40:43Z', speedMph: 0, source: 'With truck 2606', location: 'Miami, FL' },
    { trailer: '2023', lat: 38.2587, lng: -85.7, gpsAt: '2026-10-23T16:14:47Z', source: 'Last known — dropped by truck 2018' },
    { trailer: '9999', lat: null, lng: null, gpsAt: null },
  ] };
  const y = initYardReport(null, { db, getBoard: async () => ({ trips: [] }), getFleet: async () => fleet, now: () => Date.parse('2026-11-17T21:45:00Z') });
  const r = await y.readSamsara();
  assert.equal(r.units, 2);
  const u = m.get('taSamsaraTrailers').units;
  assert.equal(u['2023'].via, 'Last known — dropped by truck 2018'); assert.equal(u['2023'].parkedSince, '2026-10-23T16:14:47Z');
  assert.equal(u['2022'].via, 'With truck 2606');
});
