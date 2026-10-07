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
