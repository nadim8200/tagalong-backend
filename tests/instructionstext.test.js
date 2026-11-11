import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructionsFor, instructionsSms, whichLocation, loadFor } from '../instructionstext.js';
import { findLoad } from '../voice.js';

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

test('a customer with several locations: ask for the load (trailer / outbound day) or the city — never guess', () => {
  const mobis = {
    m1: { id: 'm1', type: 'customer', name: "MOBI'S", aliases: [], truckmate: { code: '11834', name: "MOBI'S", address: '5134 FOOTHILL ROAD, DORAL', notes: 'Back door only.', syncedAt: 'x' } },
    m2: { id: 'm2', type: 'customer', name: "MOBI'S", aliases: [], truckmate: { code: '11857', name: "MOBI'S", address: '3910 N. VIA REAL, ATLANTA', notes: 'Saturday dock 8am-2pm.', syncedAt: 'x' } },
  };
  const l = instructionsFor({ profiles: mobis, customer: "Mobi's" });
  assert.equal(l.length, 2);
  const w = whichLocation(l, null);
  assert.equal(w.several, true);
  assert.deepEqual(w.locations.map((x) => x.code), ['11834', '11857']);
  // the load pins it: that trip's stop has its own number
  const item = { trip: { tripNumber: '7', trailer: '7288' }, _tb: { date: '2026-11-10' }, _customerNotes: [{ code: '11857', name: "MOBI'S", notes: 'Saturday dock 8am-2pm.', readAt: 'x', roles: ['consignee'] }] };
  assert.equal(whichLocation(instructionsFor({ profiles: mobis, item, customer: "Mobi's" }), item), null);
  assert.equal(instructionsFor({ profiles: mobis, item, customer: "Mobi's" })[0].code, '11857');
  // a load whose stop wasn't read yet: the other location's instructions are not given
  assert.deepEqual(instructionsFor({ profiles: mobis, item: { _customerNotes: [] }, customer: "Mobi's" }), []);
  assert.equal(whichLocation([l[0]], null), null);
  // finding the load by trailer + outbound day
  const other = { trip: { tripNumber: '9', trailer: '7288' }, _tb: { date: '2026-11-11' } };
  assert.equal(loadFor([item, other], { trailer: '7288', outboundDay: '2026-11-10' }, findLoad), item);
  assert.equal(loadFor([item, other], { trailer: '7288', outboundDay: '2026-11-11' }, findLoad), other);
  assert.equal(loadFor([item], {}, findLoad), null);
});
