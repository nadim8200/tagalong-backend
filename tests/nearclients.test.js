import test from 'node:test';
import assert from 'node:assert/strict';
import { clientsNear, stateOf } from '../nearclients.js';

const PTS = { 'MICKLETON, NJ': { lat: 39.79, lng: -75.24, formatted: 'Mickleton, NJ 08056, USA' }, '08080, NJ': { lat: 39.75, lng: -75.12 }, '19103, PA': { lat: 39.95, lng: -75.17 }, '07001, NJ': { lat: 40.58, lng: -74.27 } };
const locate = async (q) => PTS[String(q).toUpperCase()] || null;
const list = [
  { id: '00001', name: 'SEWELL FLOWERS', city: 'SEWELL', state: 'NJ', zip: '08080' },
  { id: '00002', name: 'PHILLY WHOLESALE', city: 'PHILADELPHIA', state: 'PA', zip: '19103' },
  { id: '00003', name: 'AVENEL FLORIST', city: 'AVENEL', state: 'NJ', zip: '07001' },
  { id: '00004', name: 'CLOSED SHOP', city: 'SEWELL', state: 'NJ', zip: '08080', inactive: true },
  { id: '00005', name: 'BOSTON FLOWERS', city: 'BOSTON', state: 'MA', zip: '02101' },
  { id: '00006', name: 'GEOFENCED FARM', city: 'MULLICA HILL', state: 'NJ', zip: '99999' },
];

test('the state in a place or an address', () => {
  assert.equal(stateOf('Mickleton, NJ'), 'NJ'); assert.equal(stateOf('x', 'Mickleton, NJ 08056, USA'), 'NJ'); assert.equal(stateOf('nowhere'), null);
});

test('clients near a place: closest first, within the radius, geofence before ZIP, inactive and far states skipped', async () => {
  const asked = [];
  const r = await clientsNear({ place: 'Mickleton, NJ', radiusMiles: 30, list, fences: { '00006': { lat: 39.73, lng: -75.22 } }, locate: async (q) => { asked.push(q); return locate(q); } });
  assert.equal(r.found, true);
  assert.deepEqual(r.clients.map((c) => c.name), ['GEOFENCED FARM', 'SEWELL FLOWERS', 'PHILLY WHOLESALE']);
  assert.equal(r.clients[0].located, 'geofence'); assert.equal(r.clients[1].located, 'ZIP area');
  assert.ok(r.clients[1].miles > 5 && r.clients[1].miles < 10);
  assert.ok(!asked.includes('02101, MA'), 'Massachusetts is not a neighbor of NJ: never looked up');
  assert.ok(!r.clients.some((c) => c.name === 'CLOSED SHOP' || c.name === 'AVENEL FLORIST'), 'inactive skipped; Avenel is ~50 mi away');
});

test('a place the map can\'t find, or no place: says so', async () => {
  assert.equal((await clientsNear({ place: 'Atlantis', list, locate })).found, false);
  assert.match((await clientsNear({ place: '', list, locate })).note, /Which city/);
});
