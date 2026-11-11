import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructionsFor, instructionsSms } from '../instructionstext.js';

const profiles = {
  a: { id: 'a', type: 'customer', name: 'PFG THE VIRGINIA FOOD SERVICE GROUP', locations: ['RICHMOND, VA'], aliases: [], truckmate: { code: '31797', name: 'PFG THE VIRGINIA FOOD SERVICE GROUP', notes: 'Receiving 6AM-2PM.\nCheck in at gate 2.', syncedAt: '2026-11-11T00:00:00Z' } },
  b: { id: 'b', type: 'customer', name: 'NATIVE FLOWERS', aliases: [] },
};

test('by customer name: from the profile TruckMate filled in', () => {
  const l = instructionsFor({ profiles, customer: 'PFG The Virginia Food Service Group' });
  assert.equal(l.length, 1);
  assert.equal(l[0].code, '31797');
  assert.deepEqual(instructionsFor({ profiles, customer: 'Native Flowers' }), []);   // no TruckMate notes yet
});

test('by trip: every stop on the load that has instructions, narrowed by customer', () => {
  const item = { _customerNotes: [{ code: '31797', name: 'PFG VIRGINIA', notes: 'Gate 2', readAt: 'x' }, { code: '35951', name: 'EASTERN FOOD SERVICES', notes: 'Call 30 min ahead', readAt: 'x' }] };
  assert.equal(instructionsFor({ item }).length, 2);
  assert.equal(instructionsFor({ item, customer: 'Eastern Food' })[0].code, '35951');
});

test('one short text', () => {
  const t = instructionsSms(instructionsFor({ profiles, customer: 'PFG Virginia Food Service' }), { trip: '626919' });
  assert.equal(t, 'Delivery instructions — trip 626919:\nPFG THE VIRGINIA FOOD SERVICE GROUP (RICHMOND, VA): Receiving 6AM-2PM. / Check in at gate 2.');
  assert.equal(instructionsSms([{ customer: 'X', instructions: '' }]), null);
});
