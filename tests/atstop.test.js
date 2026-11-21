import test from 'node:test';
import assert from 'node:assert/strict';
import { atStopNow, customerStops } from '../voice.js';

// truck 2604, trip 627413 at 3:11 AM ET Nov 21: TruckMate "Arrive consignee" 2:40 AM, parked, the board's next stop Mickleton 2 mi away
const item = {
  trip: { tripNumber: '627413', powerUnit: '2604', status: 'ARRCONS' },
  freightBills: [
    { billNumber: 'C981715', billToName: 'BAY STATE FLORAL- WILMINGTON', endZoneDescription: 'MICKLETON, NJ, 08056', pieces: 1 },
    { billNumber: 'S085767', billToName: 'HABP GLOBAL *', endZoneDescription: 'PISCATAWAY, NJ, 08854', pieces: 5 },
  ],
  _samsara: { speedMph: 0 },
  _times: { statusHistory: [{ status: 'DEPCONS', at: '2026-11-21T06:52:33Z' }, { status: 'ARRCONS', at: '2026-11-21T07:40:31Z' }] },
};
const mick = { label: 'MICKLETON, NJ, 08056', zip: '08056', miles: 2, etaMs: Date.parse('2026-11-21T08:13:00Z') };
const pisc = { label: 'PISCATAWAY, NJ, 08854', zip: '08854', miles: 80, etaMs: Date.parse('2026-11-21T10:31:00Z') };

test('a multi-stop load: arrived in TruckMate, parked, next stop within 5 miles → at that stop', () => {
  assert.equal(atStopNow(item, mick, mick), Date.parse('2026-11-21T07:40:31Z'));
  assert.equal(atStopNow(item, pisc, mick), null, 'only the next stop');
  assert.equal(atStopNow({ ...item, _samsara: { speedMph: 55 } }, mick, mick), null, 'rolling: not there');
  assert.equal(atStopNow({ ...item, trip: { ...item.trip, status: 'DEPCONS' } }, mick, mick), null, 'TruckMate says it left');
  assert.equal(atStopNow(item, { ...mick, miles: 12 }, { ...mick, miles: 12 }), null, 'too far');
});

test('"ETA for Bay State" while the truck is there says it arrived, not an ETA', () => {
  const stops = customerStops([item], 'Bay State Floral', { 627413: { stops: [mick, pisc], passed: [] } }, { staff: true });
  const bay = stops.find((x) => /MICKLETON/i.test(x.city));
  assert.ok(bay && bay.arrived_at_receiver, 'arrival reported');
  assert.match(bay.arrived_at_receiver, /2:40 AM/);
});
