import test from 'node:test';
import assert from 'node:assert/strict';
import { applyUnitAliases, realUnit } from '../units.js';
import { isOcLoad } from '../voice.js';

test('OC2 is truck 4550: the board shows the real truck (TruckMate\'s tag kept), and it is not an outside carrier', () => {
  const trips = [{ trip: { tripNumber: '625645', powerUnit: 'OC2', trailer: '7310' } }, { trip: { tripNumber: '1', powerUnit: '2403' } }];
  applyUnitAliases(trips);
  assert.equal(trips[0].trip.powerUnit, '4550'); assert.equal(trips[0].trip.tmPowerUnit, 'OC2');
  assert.equal(trips[1].trip.powerUnit, '2403');
  assert.equal(isOcLoad(trips[0]), false);
  applyUnitAliases(trips);   // building the board again changes nothing
  assert.equal(trips[0].trip.tmPowerUnit, 'OC2');
});
test('asking for "oc2" / "OC-2" / "O C 2" finds truck 4550', () => {
  for (const x of ['oc2', 'OC-2', 'O C 2', 'OC2']) assert.equal(realUnit(x), '4550');
  assert.equal(realUnit('2403'), '2403'); assert.equal(realUnit('OC3'), 'OC3');
});
