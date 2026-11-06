import test from 'node:test';
import assert from 'node:assert/strict';
import { fencesFor, isLtlRun, stepFences, nextAsk, fenceText, askKey, FENCE } from '../loadfences.js';

const T0 = Date.parse('2026-11-05T20:00:00Z');
const iso = (m) => new Date(T0 + m * 60000).toISOString();
const P = { 'pickup:0': { lat: 35, lng: -80.95 }, 'delivery:VENTURA, CA, 93003': { lat: 34.27, lng: -119.23 }, 'delivery:OXNARD, CA, 93036': { lat: 34.2, lng: -119.18 } };
const fences = [
  { key: 'pickup:0', kind: 'pickup', name: 'Sun Valley', city: 'Fort Mill, SC' },
  { key: 'delivery:VENTURA, CA, 93003', kind: 'delivery', stopKey: 'VENTURA, CA, 93003', name: 'Mayesh', city: 'Ventura, CA' },
  { key: 'delivery:OXNARD, CA, 93036', kind: 'delivery', stopKey: 'OXNARD, CA, 93036', name: 'Kroger', city: 'Oxnard, CA' },
];

test('fences: street addresses from the trip sheet / rate con only; never our Miami yard; LTL runs are spotted', () => {
  const item = { trip: { tripNumber: '1', origZoneDesc: 'FORT MILL, SC, 29715' }, _ratecon: { pickups: [{ name: 'Sun Valley', address: '100 Commerce Dr', city: 'Fort Mill', state: 'SC', zip: '29715' }], deliveries: [{ name: 'Mayesh', address: '5 Main St', city: 'Ventura', state: 'CA' }, { name: 'Kroger', address: null, city: 'Oxnard', state: 'CA' }] } };
  const f = fencesFor(item, [{ key: 'VENTURA, CA, 93003', place: 'VENTURA, CA' }, { key: 'OXNARD, CA, 93036', place: 'OXNARD, CA' }]);
  assert.deepEqual(f.map((x) => x.key), ['pickup:0', 'delivery:VENTURA, CA, 93003'], 'no street address → no fence');
  assert.equal(f[0].q, '100 Commerce Dr, Fort Mill, SC 29715');
  assert.equal(fencesFor({ ...item, trip: { origZoneDesc: 'MIAMI, FL, 33166' } }, []).length, 0, 'our yard is not a fence');
  const ltl = { trip: {}, freightBills: [{ billNumber: 'F1' }], _manifest: { stops: [{ action: 'DELIVER', stopNumber: 1, city: 'A' }, { action: 'DELIVER', stopNumber: 2, city: 'B' }] } };
  assert.equal(isLtlRun(ltl), true);
});

test('fences: 20 min parked inside → arrive; leaving after that → left; a drive-by is nothing', () => {
  let f = {};
  f = stepFences(fences, P, f, { lat: 35.001, lng: -80.95, at: iso(0) }, T0);
  f = stepFences(fences, P, f, { lat: 35.001, lng: -80.95, at: iso(10) }, T0 + 10 * 60000);
  assert.equal(nextAsk(fences, f, { now: T0 + 10 * 60000 }), null, 'not 20 min yet');
  f = stepFences(fences, P, f, { lat: 35.001, lng: -80.95, at: iso(21) }, T0 + 21 * 60000);
  const a = nextAsk(fences, f, { now: T0 + 21 * 60000 });
  assert.equal(a.event, 'arrive'); assert.equal(a.fence.key, 'pickup:0');
  // drive-by at Ventura: in for 5 min, then gone
  f = stepFences(fences, P, f, { lat: 34.27, lng: -119.23, at: iso(30) }, T0 + 30 * 60000);
  f = stepFences(fences, P, f, { lat: 34.5, lng: -119.23, at: iso(35) }, T0 + 35 * 60000);
  assert.equal(f['delivery:VENTURA, CA, 93003'].inAt, undefined);
  assert.equal(f['delivery:VENTURA, CA, 93003'].leftAt, undefined);
  // stale GPS is ignored
  assert.deepEqual(stepFences(fences, P, f, { lat: 34.27, lng: -119.23, at: iso(0) }, T0 + 60 * 60000), f);
});

test('fences: only the newest event is sent — a truck that already left never gets "are you checked in?"', () => {
  const f = { 'pickup:0': { inAt: iso(0), lastInAt: iso(30), leftAt: iso(40) } };
  const a = nextAsk(fences, f, { now: T0 + 41 * 60000 });
  assert.equal(a.fence.key, 'pickup:0'); assert.equal(a.event, 'left');
  assert.deepEqual(a.skip, [['pickup:0', 'arrive']]);
  // a later stop beats an earlier one
  const g = { 'pickup:0': { inAt: iso(0), lastInAt: iso(30), leftAt: iso(40) }, 'delivery:VENTURA, CA, 93003': { inAt: iso(50), lastInAt: iso(75) } };
  const b = nextAsk(fences, g, { now: T0 + 75 * 60000 });
  assert.equal(b.fence.key, 'delivery:VENTURA, CA, 93003'); assert.equal(b.event, 'arrive');
  assert.ok(b.skip.some(([k, e]) => k === 'pickup:0' && e === 'left'));
  // too old to ask → everything skipped, nothing sent
  const c = nextAsk(fences, f, { now: T0 + (40 + FENCE.leftFreshMin + 1) * 60000 });
  assert.equal(c.fence, null);
  // spacing and rest: wait
  assert.equal(nextAsk(fences, f, { now: T0 + 41 * 60000, lastAskAt: iso(35) }).wait, true);
  assert.equal(nextAsk(fences, f, { now: T0 + 41 * 60000, resting: true }).wait, true);
});

test('fence texts and the milestone a YES confirms', () => {
  assert.match(fenceText(fences[1], 'arrive', { name: 'Brian Lee', trip: '626554' }), /Hi Brian, it looks like you're at Mayesh in Ventura, CA for load 626554\. Are you checked in\? Did they give you a door yet\?/);
  assert.match(fenceText(fences[1], 'left', { name: 'Brian', trip: '1' }), /Was it delivered complete\? Please send the signed POD/);
  assert.equal(askKey(fences[0], 'arrive'), 'arrived-shipper'); assert.equal(askKey(fences[0], 'left'), 'loaded');
  assert.equal(askKey(fences[1], 'left'), 'left:VENTURA, CA, 93003');
});
