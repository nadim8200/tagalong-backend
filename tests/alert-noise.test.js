import test from 'node:test';
import assert from 'node:assert/strict';
import { faultSeverity, evaluateBoard } from '../watchtower.js';
import { compareWithTruckMate } from '../manifest.js';

test('engine faults: network/sensor/manufacturer codes are quiet; protection and derate codes alert', () => {
  for (const code of ['SPN 639 FMI 2', 'SPN 2042 FMI 9', 'SPN 3216 FMI 5', 'SPN 523012 FMI 31', 'SPN 1590 FMI 19', 'SPN 811 FMI 2', 'P2002', 'SPN 2659 FMI 18']) assert.equal(faultSeverity({ code }), null, code);
  assert.equal(faultSeverity({ code: 'SPN 110 FMI 0' }), 'critical');
  assert.equal(faultSeverity({ code: 'SPN 100 FMI 1' }), 'critical');
  assert.equal(faultSeverity({ code: 'SPN 5246 FMI 15' }), 'critical');
  assert.equal(faultSeverity({ code: 'SPN 4364 FMI 1' }), 'warning');
  assert.equal(faultSeverity({ code: 'SPN 412 FMI 0' }), 'warning');
  assert.equal(faultSeverity({ code: 'P0217' }), 'critical');
});

test('a truck with only minor codes raises no alert; a serious code does', () => {
  const now = Date.parse('2026-10-06T16:00:00Z');
  const item = (codes) => ({ trip: { tripNumber: '1', status: 'DEPSHIP', powerUnit: '2403' }, freightBills: [], _samsara: { lat: 30, lng: -84, gpsAt: '2026-10-06T15:59:00Z', speedMph: 60, dtcCodes: codes } });
  const ctx = { now, geo: () => null, unitState: () => ({}) };
  const ce = (b) => evaluateBoard({ trips: [b] }, ctx).filter((a) => a.code === 'check-engine');
  assert.equal(ce(item([{ code: 'SPN 639 FMI 2', meaning: 'J1939 Network #1' }, { code: 'SPN 3216 FMI 5', meaning: 'NOx sensor' }])).length, 0);
  const a = ce(item([{ code: 'SPN 639 FMI 2', meaning: 'J1939 Network #1' }, { code: 'SPN 110 FMI 0', meaning: 'Engine Coolant Temperature — High—most severe' }]));
  assert.equal(a.length, 1); assert.equal(a[0].severity, 'critical');
  assert.match(a[0].title, /Engine fault — Engine Coolant Temperature/);
  assert.match(a[0].detail, /1 minor code on the truck card/);
});

test('outside-carrier loads: carrier truck/trailer vs OC code is not a mismatch', () => {
  const sheet = { tripNumber: '624257', truck: '176', trailer: 'RR53153', stops: [] };
  assert.deepEqual(compareWithTruckMate(sheet, { trip: { powerUnit: 'OC 978', trailer: 'OC27' }, freightBills: [] }), []);
  assert.deepEqual(compareWithTruckMate({ ...sheet, truck: '003', trailer: '14' }, { trip: { powerUnit: 'OC2', trailer: 'OC2' }, freightBills: [] }), []);
  const own = compareWithTruckMate({ tripNumber: '624218', truck: '2612', stops: [] }, { trip: { powerUnit: '2609' }, freightBills: [] });
  assert.match(own[0].msg, /Sheet says truck 2612, TruckMate has 2609/);
});
