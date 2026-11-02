import test from 'node:test';
import assert from 'node:assert/strict';
import { stopsLeft } from '../loadstops.js';
import { voiceFacts, customerView } from '../voice.js';
import { loadRows } from '../breakdownreport.js';

const bill = (billToName, endZoneDescription, actualDelivery = null) => ({ billNumber: 'B1', billToName, endZoneDescription, actualDelivery });
const trip = { tripNumber: '625967', powerUnit: '2611', trailer: '2032' };
const load = { trip, freightBills: [bill('Bristol Farms *', 'CARSON, CA, 90745'), bill('Done Co', 'RENO, NV, 89501', '2026-11-01'), bill('Other Co', 'CARSON, CA, 90745')] };
const sheeted = { ...load, _manifest: { stops: [{ action: 'LOAD', city: 'Whippany', state: 'NJ' }, { action: 'DELIVER', customer: 'Bristol Farms', city: 'Carson', state: 'CA', tmPlace: 'CARSON, CA' }, { action: 'DELIVER', customer: 'Done Co', city: 'Reno', state: 'NV', tmPlace: 'RENO, NV' }] } };

test('counts customers, not cities, from the bills', () => {
  assert.deepEqual(stopsLeft(load), { count: 2, total: 3, stops: [{ customer: 'Bristol Farms', place: 'CARSON, CA, 90745' }, { customer: 'Other Co', place: 'CARSON, CA, 90745' }] });
});
test('the trip sheet wins, and the pickup is not a stop left', () => {
  assert.deepEqual(stopsLeft(sheeted), { count: 1, total: 2, stops: [{ customer: 'Bristol Farms', place: 'Carson, CA' }] });
});
test('nothing on file is zero, not a crash', () => assert.deepEqual(stopsLeft({ trip }), { count: 0, total: 0, stops: [] }));
test('staff get the count on a call with the breakdown, customers do not', () => {
  const f = voiceFacts({ ...load, _bdOpen: true }, null);
  assert.equal(f.stops_left.count, 2); assert.equal(f.breakdown, true);
  assert.equal(JSON.stringify(customerView(load, null)).includes('stops_left'), false);
});
test('the breakdown email says it too', () => {
  assert.deepEqual(loadRows(sheeted).find(([k]) => k === 'Stops left'), ['Stops left', '1 of 2: Bristol Farms, Carson, CA']);
  assert.equal(loadRows({ trip }).find(([k]) => k === 'Stops left'), undefined);
});
