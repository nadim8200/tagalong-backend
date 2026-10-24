import test from 'node:test';
import assert from 'node:assert/strict';
import { searchPast, pastView } from '../pastloads.js';

// truck 2601: left Miami Tue Oct 20 (8:30 PM), delivered Direct Flowers Thu Oct 22
const rec = (trip, unit, left, bills) => ({ finishedAt: '2026-10-23T12:00:00Z', reason: 'delivered', rec: { item: { trip: { tripNumber: trip, powerUnit: unit, trailer: '2048', origZoneDesc: 'MIAMI TERMINAL' }, _times: { statusHistory: [{ status: 'DEPSHIP', at: left }] }, freightBills: bills } } });
const store = {
  625540: rec('625540', '2601', '2026-10-21T00:30:00Z', [{ billNumber: 'M1', billToName: 'DIRECT FLOWERS OF BOSTON INC', endZoneDescription: 'CHELSEA, MA, 02150', pieces: 40, actualDelivery: '2026-10-22T05:40:00' }, { billNumber: 'M2', billToName: 'CARBONE CHELSEA BILLING', endZoneDescription: 'CHELSEA, MA, 02150', pieces: 9, actualDelivery: '2026-10-22T06:10:00' }]),
  625489: rec('625489', '736', '2026-10-21T09:55:00Z', [{ billNumber: 'M3', billToName: 'DIRECT FLOWERS OF BOSTON INC', endZoneDescription: 'CHELSEA, MA, 02150', pieces: 2, actualDelivery: '2026-10-23T16:30:00' }]),
};
const now = Date.parse('2026-10-24T01:00:00Z');   // Friday night

test('"the Direct Flowers truck that left Miami Tuesday": when it left, truck, trailer, when it delivered', () => {
  const r = searchPast(store, { customer: 'Direct Flowers of Boston', outboundDay: 'Tuesday', now });
  assert.equal(r.length, 1);
  assert.equal(r[0].truck, '2601'); assert.equal(r[0].trailer, '2048'); assert.equal(r[0].left_from, 'our Miami, Florida hub');
  assert.match(r[0].left_at, /Oct 20, 8:30 PM ET/); assert.match(r[0].outbound, /^Tuesday, Oct 20 outbound/);
  assert.deepEqual(r[0].stops.map((s) => s.customer), ['DIRECT FLOWERS OF BOSTON INC'], 'only their stop');
  assert.ok(r[0].stops[0].delivered_at);
});
test('by truck or by delivered day too', () => {
  assert.equal(searchPast(store, { truck: '2601', now })[0].trip, '625540');
  assert.equal(searchPast(store, { customer: 'Direct Flowers', deliveredDay: 'Thursday', now })[0].trip, '625540');
  assert.equal(searchPast(store, { customer: 'Direct Flowers', outboundDay: 'Monday', now }).length, 0);
  assert.equal(pastView(store['625540'], { customer: 'Somebody Else' }), null);
});
