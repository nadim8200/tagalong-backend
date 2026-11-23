import test from 'node:test';
import assert from 'node:assert/strict';
import { massRecipients } from '../masstext.js';

const loads = [
  { trip: '627661', truck: '4564', trailer: '18096', drivers: [{ name: 'Ana Ruiz', phone: '3055550001' }] },
  { trip: '627700', truck: '2403', drivers: [{ name: 'Team One', phone: '3055550002' }, { name: 'Team Two', phone: '3055550003' }] },
  { trip: '627701', truck: 'OC 12', drivers: [{ name: 'No Agreement', phone: '3055550009' }] },
];
const roster = [
  { name: 'Ana Ruiz', phone: '(305) 555-0001', truck: '4564' },
  { name: 'Home Time', phones: [{ number: '+1 305 555 0004' }], truck: '930' },
  { name: 'Stopped Him', phone: '3055550005', truck: '931' },
  { name: 'Name Only', phone: '3055550006' },
];
const consent = Object.fromEntries(['3055550001', '3055550002', '3055550003', '3055550004', '3055550005', '3055550006'].map((p) => [p, { at: 'x' }]));
const optOut = { 3055550005: { at: 'x' } };
const phones = (r) => r.recipients.map((x) => x.phone).sort();

test('drivers on a load: everyone on the board once; no agreement → skipped with the reason', () => {
  const r = massRecipients({ audience: 'active', loads, roster, consent, optOut });
  assert.deepEqual(phones(r), ['3055550001', '3055550002', '3055550003']);
  assert.deepEqual(r.skipped, [{ name: 'No Agreement', truck: 'OC 12', why: 'no text agreement on file' }]);
  assert.equal(r.recipients.find((x) => x.phone === '3055550001').trip, '627661');
});

test('all drivers: loads + every profile, a number once, STOP never', () => {
  const r = massRecipients({ audience: 'all', loads, roster, consent, optOut });
  assert.deepEqual(phones(r), ['3055550001', '3055550002', '3055550003', '3055550004', '3055550006']);
  assert.ok(r.skipped.some((x) => x.name === 'Stopped Him' && x.why === 'replied STOP'));
});

test('an area on the map: the truck\'s load drivers, else its profile, else the map\'s driver name; unknown trucks listed', () => {
  const r = massRecipients({ audience: 'area', units: [{ unit: '2403' }, { unit: '930' }, { unit: '777', driver: 'name only' }, { unit: '555', driver: 'Who' }], loads, roster, consent, optOut });
  assert.deepEqual(phones(r), ['3055550002', '3055550003', '3055550004', '3055550006']);
  assert.deepEqual(r.skipped, [{ name: 'Who', truck: '555', why: 'no cell number on file' }]);
  assert.equal(massRecipients({ audience: 'area', units: [], loads, roster, consent }).recipients.length, 0);
});
