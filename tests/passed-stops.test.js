import test from 'node:test';
import assert from 'node:assert/strict';
import { boardEtas, evaluateBoard } from '../watchtower.js';
import { voiceFacts, customerStops } from '../voice.js';

// Trip 624399: Miami → Gwynn Oak MD → Pennsauken (Merchantville) NJ → Clifton NJ → Monsey NY.
// The truck is on the NJ Turnpike at Cranbury heading north; TruckMate hasn't marked anything delivered.
const NOW = Date.parse('2026-10-07T02:40:00Z');
const GEO = { 21207: { lat: 39.32, lng: -76.72 }, '08109': { lat: 39.95, lng: -75.05 }, '07011': { lat: 40.88, lng: -74.14 }, 10952: { lat: 41.11, lng: -74.07 } };
const ctx = { now: NOW, geo: (z) => GEO[z] || null, unitState: () => ({}) };
const bill = (n, zone, pieces) => ({ billNumber: n, billToName: 'X', endZoneDescription: zone, pieces, deliverBy: '2026-10-06T00:00:00' });
const sheetStop = (stopNumber, customer, city, state, tmPlace) => ({ stopNumber, action: 'DELIVER', customer, city, state, tmPlace });
const item = (lat, lng, status = 'DEPSHIP') => ({
  trip: { tripNumber: '624399', status, powerUnit: '724', driver2: 'Y' },
  freightBills: [
    bill('M5038379', 'MERCHANTVILLE, NJ, 08109', 135), bill('M5038440', 'CLIFTON, NJ, 07011', 333),
    bill('M5038134', 'GWYNN OAK, MD, 21207', 75), bill('G5033361', 'MONSEY, NY, 10952', 22),
  ].map((b, i) => ({ ...b, billToName: ['MAIN WHOLESALE FLORIST PENNSAUKEN LLC.', 'MAIN WHOLESALE FLORIST-CLIFTON', 'DBG - BALTIMORE', 'MAIN STREET FLORAL - NY *'][i] })),
  _manifest: { stops: [
    { stopNumber: 1, action: 'LOAD', customer: 'MIAMI TERMINAL', city: 'Miami', state: 'FL' },
    sheetStop(2, 'DBG - BALTIMORE', 'WOODLAWN', 'MD', 'GWYNN OAK, MD'),
    sheetStop(3, 'MAIN WHOLESALE FLORIST PENNSAUKEN LLC.', 'PENNSAUKEN', 'NJ', 'MERCHANTVILLE, NJ'),
    sheetStop(4, 'MAIN WHOLESALE FLORIST-CLIFTON', 'CLIFTON', 'NJ', 'CLIFTON, NJ'),
    sheetStop(5, 'MAIN STREET FLORAL - NY *', 'MONSEY', 'NY', 'MONSEY, NY'),
  ] },
  _samsara: { gpsAt: '2026-10-07T02:37:45Z', speedMph: 70, lat, lng, location: 'New Jersey Turnpike, Cranbury Township, NJ, 08512', hos: { driveLeftMin: 557, shiftLeftMin: 700 } },
});
const CRANBURY = [40.31, -74.51];

test('truck in NJ past Maryland and Pennsauken: those stops are behind it, next stop is Clifton', () => {
  const e = boardEtas({ trips: [item(...CRANBURY)] }, ctx)['624399'];
  assert.deepEqual(e.passed.map((x) => x.zip), ['21207', '08109']);
  assert.equal(e.stops[0].zip, '07011');
  assert.ok(e.stops[0].miles < 70, `never routes back to Maryland (${e.stops[0].miles} mi)`);
});

test('truck still in Virginia: nothing is passed', () => {
  const e = boardEtas({ trips: [item(38.0, -77.5)] }, ctx)['624399'];
  assert.deepEqual(e.passed, []);
  assert.equal(e.stops[0].zip, '21207');
});

test('truck parked just outside the Baltimore stop is not "past" it', () => {
  const e = boardEtas({ trips: [item(39.30, -76.62)] }, ctx)['624399'];
  assert.deepEqual(e.passed, []);
});

test('no late / appointment-passed alerts for stops the truck already passed', () => {
  const a = evaluateBoard({ trips: [item(...CRANBURY)] }, ctx).filter((x) => /late-risk|appt-passed/.test(x.code));
  assert.ok(!a.some((x) => /GWYNN|MERCHANTVILLE/.test(x.key || '')), JSON.stringify(a.map((x) => x.key)));
});

test('Jarvis: next stop is Clifton; Maryland and Pennsauken are "already passed", not remaining', () => {
  const it = item(...CRANBURY);
  const e = boardEtas({ trips: [it] }, ctx)['624399'];
  const f = voiceFacts(it, e);
  assert.match(f.next_stop, /CLIFTON/);
  assert.deepEqual(f.stops_already_passed.map((x) => x.split(',')[0]), ['GWYNN OAK', 'MERCHANTVILLE']);
  assert.ok(!f.stops_remaining.some((x) => /GWYNN|MERCHANTVILLE/.test(x)));
  assert.match(f.stops_note, /Never say the truck will go back/);
});

test('Jarvis: "Main Wholesale Pennsauken" caller hears the truck already passed their stop', () => {
  const it = item(...CRANBURY);
  const e = boardEtas({ trips: [it] }, ctx);
  const r = customerStops([it], 'Main Wholesale Pennsauken', e);
  assert.equal(r[0].customer, 'MAIN WHOLESALE FLORIST PENNSAUKEN LLC.');
  assert.equal(r[0].truck_already_passed, true);
  assert.equal(r[0].estimated_arrival, null);
  assert.equal(r.length, 1, 'TruckMate Merchantville bill is the same stop, not a second one');
  const c = customerStops([it], 'Main Wholesale Clifton', e)[0];
  assert.ok(!c.truck_already_passed && c.estimated_arrival, 'Clifton is still ahead with an ETA');
});

// Trip 624481: team leaving Miami for Kinston NC → South Windsor CT → Cranston RI → Rockland MA → Chelsea Market (5 shops).
import { stopDwellMin } from '../watchtower.js';
test('team out of Miami reaches Chelsea Thursday morning, not Wednesday afternoon', () => {
  const G2 = { 28501: [35.26, -77.58], '06074': [41.83, -72.56], '02920': [41.77, -71.46], '02370': [42.13, -70.91], '02150': [42.39, -71.03] };
  const now = Date.parse('2026-10-07T02:54:00Z');                     // Tue 10:54 PM Eastern
  const b = (n, zone, pieces, who) => ({ billNumber: n, billToName: who, endZoneDescription: zone, pieces });
  const it = { trip: { tripNumber: '624481', status: 'DEPSHIP', powerUnit: '2618', driver2: '7344' },
    freightBills: [b('1', 'KINSTON, NC, 28501', 83, 'ALCOCK'), b('2', 'SOUTH WINDSOR, CT, 06074', 100, 'TERRA'), b('3', 'CRANSTON, RI, 02920', 230, 'CARBONE'), b('4', 'ROCKLAND, MA, 02370', 70, 'NEFM'),
      ...['CARBONE CHELSEA', 'CUPP', 'DIRECT', 'KELLEY', 'RICCARDI'].map((w, i) => b(`5${i}`, 'CHELSEA, MA, 02150', 14, w))],
    _samsara: { gpsAt: '2026-10-07T02:50:00Z', speedMph: 0, lat: 25.80, lng: -80.31, hos: { driveLeftMin: 555, shiftLeftMin: 700 } } };
  const e = boardEtas({ trips: [it] }, { now, geo: (z) => (G2[z] ? { lat: G2[z][0], lng: G2[z][1] } : null), unitState: () => ({}) })['624481'];
  const chelsea = e.stops.find((s) => s.zip === '02150');
  const h = (chelsea.etaMs - now) / 3600000;
  assert.ok(h > 30 && h < 33, `Chelsea in ${h.toFixed(1)} h (Thu ~5-7 AM)`);
  assert.ok(stopDwellMin({ consignees: ['a', 'b', 'c', 'd', 'e'], pieces: 70 }) > stopDwellMin({ consignees: ['a'], pieces: 70 }), 'a 5-shop market takes longer');
});

test('trip sheet "drivers will leave at 20:30": ETAs start at departure, no late alert before it leaves', () => {
  const now = Date.parse('2026-10-06T22:00:00Z');                     // 6 PM Eastern
  const it = { trip: { tripNumber: '7', status: 'DEPSHIP', powerUnit: '1' }, freightBills: [{ billNumber: 'B', endZoneDescription: 'KINSTON, NC, 28501', pieces: 10, deliverBy: '2026-10-07T08:00:00', deliverByEnd: '2026-10-07T08:00:00', deliveryApptReq: 'True' }],
    _manifest: { pickupAt: '2026-10-06T20:30', stops: [] }, _samsara: { gpsAt: '2026-10-06T21:59:00Z', speedMph: 0, lat: 25.80, lng: -80.31, hos: { driveLeftMin: 660, shiftLeftMin: 840 } } };
  const c = { now, geo: () => ({ lat: 35.26, lng: -77.58 }), unitState: () => ({}) };
  const e = boardEtas({ trips: [it] }, c)['7'];
  assert.equal(e.leavesAt, Date.parse('2026-10-07T00:30:00Z'));
  assert.ok(e.stops[0].etaMs - e.leavesAt > 13 * 3600000, 'clock starts at 20:30');
  assert.deepEqual(evaluateBoard({ trips: [it] }, c).filter((a) => a.code === 'late-risk'), []);
});

// Trip 624647: Oxnard CA → San Antonio (delivered) → Houston → Kenner → Biloxi → Pensacola → … → Miami.
// The team is on I-10 in Guadalupe County TX. Stops must run from Oxnard, not from the Miami terminal.
test('a West Coast trip is routed from its own origin: Houston next (not Miami first)', () => {
  const G = { 93035: { lat: 34.17, lng: -119.22 }, 77040: { lat: 29.87, lng: -95.53 }, 70062: { lat: 29.99, lng: -90.25 }, 39532: { lat: 30.47, lng: -88.85 }, 32505: { lat: 30.45, lng: -87.26 }, 33122: { lat: 25.8, lng: -80.31 }, 33126: { lat: 25.78, lng: -80.29 }, 78217: { lat: 29.54, lng: -98.42 } };
  const b = (n, zone, del) => ({ billNumber: n, billToName: 'X', endZoneDescription: zone, pieces: 5, deliverBy: '2026-10-09T00:00:00', ...(del ? { actualDelivery: del } : {}) });
  const it = {
    trip: { tripNumber: '624647', status: 'DEPCONS', powerUnit: '2219', driver2: 'Y', origZoneDesc: 'OXNARD, CA, 93035', destZoneDesc: 'MIAMI, FL, 33122' },
    freightBills: [b('C978178', 'MIAMI, FL, 33122'), b('C978180', 'MIAMI, FL, 33126'), b('C978182', 'HOUSTON, TX, 77040'), b('C978184', 'SAN ANTONIO, TX, 78217', '2026-10-10T10:12:35'),
      b('C978193', 'BILOXI, MS, 39532'), b('C978194', 'PENSACOLA, FL, 32505'), b('C978198', 'KENNER, LA, 70062')],
    _samsara: { gpsAt: '2026-10-10T15:13:52Z', speedMph: 60, lat: 29.6, lng: -97.9, location: 'West Interstate 10, Guadalupe County, TX', hos: { driveLeftMin: 400, shiftLeftMin: 500 } },
  };
  const e = boardEtas({ trips: [it] }, { now: Date.parse('2026-10-10T15:14:00Z'), geo: (z) => G[z] || null, unitState: () => ({}) })['624647'];
  assert.deepEqual(e.stops.map((x) => x.zip), ['77040', '70062', '39532', '32505', '33122', '33126']);
  assert.ok(e.stops[0].miles < 220, `Houston is ~170 mi away (${e.stops[0].miles})`);
  assert.ok(e.stops[0].etaMs < Date.parse('2026-10-10T21:00:00Z'), 'Houston this afternoon, not Wednesday');
});
