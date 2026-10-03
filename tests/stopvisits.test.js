import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepVisit, newVisit, distanceToGeofence, matchGeofence, RULES } from '../stopvisits.js';

// Synthetic facility: 150 m circle. Fixture data only.
const GF = { id: 'a1', name: 'Test Floral Whse', source: 'Samsara address', circle: { lat: 30.0, lng: -90.0, radiusM: 150 } };
const at = (m) => ({ lat: 30.0 + m / 110540, lng: -90.0 });          // m metres north of centre
const T0 = Date.parse('2026-10-03T10:00:00Z');
const run = (pts, v0 = newVisit({ trip: 'T1', stopKey: 's1', unit: '2614', geofence: GF })) =>
  pts.reduce((v, [min, m, unit]) => stepVisit(v, { t: T0 + min * 60000, ...at(m), unit: unit || '2614' }, GF, T0 + min * 60000 + 1000), v0);

test('normal visit: arrive, dwell, confirmed departure → completed with evidence', () => {
  const v = run([[0, 2000], [1, 50], [2, 20], [3, 0], [20, 10], [21, 600], [22, 900]]);
  assert.equal(v.state, 'completed');
  assert.equal(new Date(v.enteredAt).toISOString(), '2026-10-03T10:01:00.000Z');
  assert.equal(new Date(v.exitedAt).toISOString(), '2026-10-03T10:21:00.000Z');
  assert.equal(v.dwellMin, 20);
  assert.deepEqual(v.evidence.map((e) => e.event), ['arrived', 'departed']);
  assert.equal(v.rule, RULES.version);
});

test('drive-through: inside briefly then gone is not a visit', () => {
  const v = run([[0, 2000], [1, 40], [2, 900], [3, 1500]]);
  assert.equal(v.state, 'upcoming');
  assert.equal(v.enteredAt, null);
  assert.equal(v.evidence[0].event, 'pass-through');
});

test('short stop (dwell below minimum) is a drive-by, not completed', () => {
  const v = run([[0, 40], [1, 30], [2, 20], [4, 800], [5, 900]]);
  assert.equal(v.state, 'upcoming');
  assert.ok(v.evidence.some((e) => e.event === 'drive-by'));
});

test('boundary jitter just outside the fence does not end the visit', () => {
  const v = run([[0, 40], [1, 30], [5, 200], [6, 170], [7, 250], [12, 20], [30, 210]]);
  assert.equal(v.state, 'at_stop');
});

test('stepping out and back in returns to at_stop', () => {
  const v = run([[0, 40], [1, 30], [5, 600], [6, 40]]);
  assert.equal(v.state, 'at_stop');
  assert.ok(v.evidence.some((e) => e.event === 'returned'));
});

test('duplicate and out-of-order samples are ignored (idempotent)', () => {
  const a = run([[0, 40], [1, 30], [1, 30], [0, 40], [20, 900], [21, 900]]);
  const b = run([[0, 40], [1, 30], [20, 900], [21, 900]]);
  assert.equal(a.state, b.state);
  assert.equal(a.enteredAt, b.enteredAt);
  assert.equal(a.ignored, 2);
});

test('stale samples are ignored', () => {
  const v0 = newVisit({ trip: 'T1', stopKey: 's1', unit: '2614', geofence: GF });
  const v = stepVisit(v0, { t: T0, ...at(0), unit: '2614' }, GF, T0 + 10 * 60000);
  assert.equal(v.state, 'upcoming');
  assert.equal(v.ignored, 1);
});

test('missing GPS changes nothing (unknown, not completed)', () => {
  const v0 = newVisit({ trip: 'T1', stopKey: 's1', unit: '2614', geofence: GF });
  assert.equal(stepVisit(v0, null, GF, T0).state, 'upcoming');
  assert.equal(stepVisit(v0, { t: T0, lat: null, lng: null }, GF, T0).state, 'upcoming');
});

test('a different truck mid-visit needs review', () => {
  const v = run([[0, 40], [1, 30], [5, 20, '2700']]);
  assert.equal(v.state, 'needs_review');
});

test('polygon geofence inside/outside distance', () => {
  const poly = { polygon: [{ lat: 30, lng: -90 }, { lat: 30.002, lng: -90 }, { lat: 30.002, lng: -89.998 }, { lat: 30, lng: -89.998 }] };
  assert.ok(distanceToGeofence({ lat: 30.001, lng: -89.999 }, poly) < 0);
  assert.ok(distanceToGeofence({ lat: 30.01, lng: -89.999 }, poly) > 500);
});

test('geofence match needs clear name + same city; city-only or ambiguous → none', () => {
  const addrs = [
    { id: '1', name: 'Produce Junction', formattedAddress: '1 Main St, Swedesboro, NJ 08085', geofence: { circle: { latitude: 39.7, longitude: -75.3, radiusMeters: 200 } } },
    { id: '2', name: 'Direct Floral Source', formattedAddress: '9 Elm, Fort Worth, TX 76111', geofence: { circle: { latitude: 32.7, longitude: -97.3, radiusMeters: 120 } } },
    { id: '3', name: 'Direct Floral Source', formattedAddress: '10 Oak, Fort Worth, TX 76112', geofence: { circle: { latitude: 32.8, longitude: -97.3, radiusMeters: 120 } } },
    { id: '4', name: 'Huge Zone', formattedAddress: 'Somewhere, Miami, FL', geofence: { circle: { latitude: 25, longitude: -80, radiusMeters: 9000 } } },
  ];
  assert.equal(matchGeofence({ customer: 'PRODUCE JUNCTION', city: 'Swedesboro', state: 'NJ' }, addrs).id, '1');
  assert.equal(matchGeofence({ customer: 'Produce Junction', city: 'Camden', state: 'NJ' }, addrs), null);
  assert.equal(matchGeofence({ customer: 'Direct Floral Source', city: 'Fort Worth', state: 'TX' }, addrs), null);
  assert.equal(matchGeofence({ customer: 'Huge Zone', city: 'Miami', state: 'FL' }, addrs), null);
});
